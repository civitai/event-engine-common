import { EntityType } from '../types/metric-types';
import { IMeilisearch, IMeilisearchIndex } from '../types/meilisearch-interface';
import { IClickhouseClient, IDbClient } from '../types/package-stubs';
import { MetricService } from '../services/metrics';
import { CacheService } from '../services/cache';
import { getMeilisearchFeed } from '../utils/meilisearch-helpers';
import { createAsyncBatcher, runWithConcurrency } from '../utils/async-utils';
import { chunk } from '../utils/basic';
import {
  CreateFeedConfig,
  FeedContext,
  FeedAdvancedOptions,
  FeedQueryInput,
  FeedResult,
  UpsertType,
  FeedSchema,
} from './types';

/**
 * Creates a feed class with typed access to Meilisearch, caches, and metrics
 *
 * Simplified API with type inference from config:
 * - entityType determines the entity type
 * - schema determines the document type
 * - Function parameters determine input/output types
 *
 * All types are properly inferred from the config, eliminating `any` types
 *
 * @param config - Feed configuration
 * @returns Feed class constructor
 */
export function createFeed<
  E extends EntityType,
  TInput extends Record<string, any>,
  TSchema extends FeedSchema,
  TDoc,
  TPop
>(
  config: CreateFeedConfig<E, TInput, TSchema, TDoc, TPop>
) {

  const options: FeedAdvancedOptions = {
    fetchBatchSize: 1000,
    upsertBatchSize: 100000,
    createConcurrency: 2,
    ...(config.options ?? {}),
  };

  class Feed {
    private client: IMeilisearch;
    private context!: FeedContext<E>;
    private index: IMeilisearchIndex | undefined;
    private indexError: Error | undefined;
    private indexReady: Promise<boolean>;
    private configured = false;

    constructor(
      meilisearch: IMeilisearch,
      ch: IClickhouseClient,
      pg: IDbClient,
      metricService: MetricService,
      cacheService: CacheService
    ) {
      this.client = meilisearch;

      // Read-only initialization: just get the index reference
      console.log(`[Feed:${config.name}] Initializing feed (read-only)...`);
      const initStart = Date.now();

      this.indexReady = this.client.getIndex(config.name)
        .then((index) => {
          this.index = index;
          console.log(`[Feed:${config.name}] Index obtained in ${Date.now() - initStart}ms`);
          return true;
        })
        .catch((err) => {
          this.indexError = err as Error;
          console.error(`[Feed:${config.name}] Failed to get index:`, err);
          return false;
        });

      // Build context
      const self = this;
      this.context = {
        pg: {
          query: async <T = any>(query: string, params?: any[]) => {
            const result = await pg.query(query, params);
            return result.rows as T[];
          },
        },
        ch: {
          query: async <T = any>(query: string, params?: any[]) => {
            const result = await ch.query({
              query: params
                ? query.replace(/\$(\d+)/g, (_, i) => String(params[parseInt(i) - 1]))
                : query,
              format: 'JSONEachRow',
            });
            return (await result.json()) as T[];
          },
        },
        cache: {
          fetch: (name, ids) => cacheService.fetch(name, ids),
        },
        metric: {
          fetch: async (ids) => {
            return metricService.fetch(config.entityType, ids);
          },
        },
        get index() {
          if (!self.index) throw new Error('Index not ready');
          return self.index;
        },
        // Default pagination - will be overridden in query method
        pagination: {
          limit: 20,
          cursor: undefined,
        },
      } as FeedContext<E>;
    }

    /**
     * Wait for index to be ready
     */
    private async ready() {
      if (!(await this.indexReady))
        throw this.indexError ?? new Error('Index failed to initialize');
      if (!this.index) throw new Error('Index not available');
    }

    /**
     * Configure index for write operations
     * Creates index if it doesn't exist and updates schema settings
     * This is called automatically by upsert() and delete()
     * Safe to call multiple times (idempotent)
     */
    async configure(): Promise<void> {
      if (this.configured) return; // Already configured

      console.log(`[Feed:${config.name}] Configuring index for write operations...`);
      const configStart = Date.now();

      // Ensure we can access the index
      await this.ready();

      // Try to create index if it doesn't exist
      try {
        this.index = await this.client.getIndex(config.name);
      } catch (e: any) {
        if (e.code === 'index_not_found') {
          console.log(`[Feed:${config.name}] Index not found, creating...`);
          const task = await this.client.createIndex(config.name, { primaryKey: 'id' });
          await this.client.tasks.waitForTask(task.taskUid);
          this.index = await this.client.getIndex(config.name);
          console.log(`[Feed:${config.name}] Index created successfully`);
        } else {
          throw e;
        }
      }

      // Get current settings to avoid unnecessary updates
      const settingsStart = Date.now();
      const currentSettings = await this.index.getSettings();
      console.log(`[Feed:${config.name}] Settings fetched in ${Date.now() - settingsStart}ms`);

      // Configure index based on schema
      const sortable: string[] = [];
      const filterable: string[] = [];

      for (const [field, fieldConfig] of Object.entries(config.schema) as [string, { sortable?: boolean; filterable?: boolean }][]) {
        if (fieldConfig.sortable) sortable.push(field);
        if (fieldConfig.filterable) filterable.push(field);
      }

      // Only update if changed to avoid hammering Meilisearch
      const sortableChanged =
        JSON.stringify(sortable.sort()) !==
        JSON.stringify((currentSettings.sortableAttributes ?? []).sort());
      const filterableChanged =
        JSON.stringify(filterable.sort()) !==
        JSON.stringify((currentSettings.filterableAttributes ?? []).sort());

      console.log(`[Feed:${config.name}] Schema: ${sortable.length} sortable, ${filterable.length} filterable`);
      console.log(`[Feed:${config.name}] Updates needed: sortable=${sortableChanged}, filterable=${filterableChanged}`);

      // Update attributes synchronously to ensure they're set before writes
      if (sortableChanged && sortable.length) {
        console.log(`[Feed:${config.name}] Updating sortable attributes`);
        const task = await this.index.updateSortableAttributes(sortable);
        await this.client.tasks.waitForTask(task.taskUid);
        console.log(`[Feed:${config.name}] Sortable attributes updated successfully`);
      }
      if (filterableChanged && filterable.length) {
        console.log(`[Feed:${config.name}] Updating filterable attributes`);
        const task = await this.index.updateFilterableAttributes(filterable);
        await this.client.tasks.waitForTask(task.taskUid);
        console.log(`[Feed:${config.name}] Filterable attributes updated successfully`);
      }

      this.configured = true;
      console.log(`[Feed:${config.name}] Configuration complete in ${Date.now() - configStart}ms`);
    }

    /**
     * Delete documents from the index
     */
    async delete(ids: number[]): Promise<void> {
      await this.configure(); // Ensure index is configured for write operations
      const task = await this.index!.deleteDocuments(ids);
      // Task is queued, we don't wait for completion
    }

    /**
     * Upsert (insert or update) documents in the index
     * Fetches data in batches and updates Meilisearch with batching
     *
     * @param ids - Entity IDs to upsert
     * @param type - Type of update ('full' or 'metrics')
     */
    async upsert(ids: number[], type: UpsertType = 'full'): Promise<void> {
      await this.configure(); // Ensure index is configured for write operations

      const batcher = createAsyncBatcher<TDoc>(
        options.upsertBatchSize,
        async (docs) => {
          await this.index!.updateDocuments(docs as Record<string, any>[]);
        }
      );

      const batches = chunk(ids, options.fetchBatchSize);

      const tasks = batches.map((batch) => async () => {
        const docs = await config.createDocuments(this.context, batch, type);
        batcher.enqueue(docs);
      });

      await runWithConcurrency(tasks, options.createConcurrency);
      await batcher.flush();
    }

    /**
     * Query documents from Meilisearch
     * Input and return types are inferred from config
     * Pagination (limit, cursor) is extracted and passed via context
     * Returns data array and next cursor for pagination
     */
    async query(input: FeedQueryInput<TInput>): Promise<FeedResult<TDoc>> {
      console.log(`[Feed:${config.name}] Query started with input:`, JSON.stringify(input, null, 2));
      const queryStart = Date.now();

      await this.ready();

      // Extract pagination from input
      const { limit = 20, cursor, ...customInput } = input;

      // Create context with pagination
      const ctxWithPagination: FeedContext<E> = {
        ...this.context,
        pagination: { limit, cursor },
      };

      // Pass custom input (without pagination) to queryDocuments
      const docs = await config.queryDocuments(
        ctxWithPagination,
        customInput as TInput
      );

      // Extract cursor if we have more results than requested
      let nextCursor: string | undefined;
      let data: TDoc[];

      if (docs.length > limit) {
        // We have more results, extract cursor from the last item we'll return
        data = docs.slice(0, limit);
        const lastItem = data[limit - 1] as Record<string, unknown>;

        // Generate cursor from document if getCursor function is provided
        if (config.getCursor) {
          nextCursor = config.getCursor(lastItem as TDoc);
        } else {
          // Default cursor format: sortAt:id or just id
          const sortAt = lastItem.sortAt;
          const id = lastItem.id;
          nextCursor = sortAt ? `${sortAt}:${id}` : String(id);
        }
      } else {
        // No more results
        data = docs;
        nextCursor = undefined;
      }

      console.log(`[Feed:${config.name}] Query completed in ${Date.now() - queryStart}ms, returned ${data.length} documents, nextCursor: ${nextCursor}`);
      return { data, nextCursor };
    }

    /**
     * Populate documents with related data
     * Document and return types are inferred from config
     */
    async populate(docs: TDoc[]): Promise<TPop[]> {
      console.log(`[Feed:${config.name}] Populate started with ${docs.length} documents`);
      const populateStart = Date.now();

      await this.ready();
      const populatedDocs = await config.populateDocuments(this.context, docs);

      console.log(`[Feed:${config.name}] Populate completed in ${Date.now() - populateStart}ms`);
      return populatedDocs;
    }

    /**
     * Query and populate in one call
     * Convenience method for common use case
     * All types are inferred from config
     * Returns populated data and cursor for pagination
     */
    async populatedQuery(
      input: FeedQueryInput<TInput>
    ): Promise<FeedResult<TPop>> {
      const { data, nextCursor } = await this.query(input);
      const populated = await this.populate(data);
      return { data: populated, nextCursor };
    }
  }

  return Feed;
}

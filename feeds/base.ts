import { EntityType } from '../types/metric-types';
import { logger } from '../utils/logger';
import { IMeilisearch, IMeilisearchIndex } from '../types/meilisearch-interface';
import { IClickhouseClient, IDbClient } from '../types/package-stubs';
import { MetricService } from '../services/metrics';
import { CacheService } from '../services/cache';
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
    public client: IMeilisearch;
    public context!: FeedContext<E>;
    public index: IMeilisearchIndex | undefined;
    public indexError: Error | undefined;
    public indexReady: Promise<boolean>;
    public configured = false;

    constructor(
      meilisearchInitializer: (config: {apiKey: string, host: string}) => IMeilisearch,
      ch: IClickhouseClient,
      pg: IDbClient,
      metricService: MetricService,
      cacheService: CacheService
    ) {
      this.client = meilisearchInitializer({
        apiKey: config.connection?.apiKey ?? process.env.FEED_API_KEY ?? '',
        host: config.connection?.host ?? process.env.FEED_HOST ?? 'http://localhost:7700',
      });

      // Read-only initialization: just get the index reference
      logger.debug('Feed',`[Feed:${config.name}] Initializing feed (read-only)...`);
      const initStart = Date.now();

      this.indexReady = this.client.getIndex(config.name)
        .then((index) => {
          this.index = index;
          logger.debug('Feed',`[Feed:${config.name}] Index obtained in ${Date.now() - initStart}ms`);
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
          fetchImageTagIds: (ids: number[]) => cacheService.fetchImageTagIds(ids),
          mGet: <T>(keys: string[]) => cacheService.mGet<T>(keys),
          set: <T>(key: string, value: T, options?: { EX?: number }) => cacheService.set<T>(key, value, options),
          sAdd: <T>(key: string, values: T[]) => cacheService.sAdd<T>(key, values),
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
    public async ready() {
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

      logger.debug('Feed',`[Feed:${config.name}] Configuring index for write operations...`);
      const configStart = Date.now();

      // Ensure we can access the index
      await this.ready();

      // Try to create index if it doesn't exist
      try {
        this.index = await this.client.getIndex(config.name);
      } catch (e: any) {
        if (e.code === 'index_not_found') {
          logger.debug('Feed',`[Feed:${config.name}] Index not found, creating...`);
          const task = await this.client.createIndex(config.name, { primaryKey: 'id' });
          await this.client.tasks.waitForTask(task.taskUid);
          this.index = await this.client.getIndex(config.name);
          logger.debug('Feed',`[Feed:${config.name}] Index created successfully`);
        } else {
          throw e;
        }
      }

      // Get current settings to avoid unnecessary updates
      const settingsStart = Date.now();
      const currentSettings = await this.index.getSettings();
      logger.debug('Feed',`[Feed:${config.name}] Settings fetched in ${Date.now() - settingsStart}ms`);

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

      logger.debug('Feed',`[Feed:${config.name}] Schema: ${sortable.length} sortable, ${filterable.length} filterable`);
      logger.debug('Feed',`[Feed:${config.name}] Updates needed: sortable=${sortableChanged}, filterable=${filterableChanged}`);

      // Update attributes synchronously to ensure they're set before writes
      if (sortableChanged && sortable.length) {
        logger.debug('Feed',`[Feed:${config.name}] Updating sortable attributes`);
        const task = await this.index.updateSortableAttributes(sortable);
        await this.client.tasks.waitForTask(task.taskUid);
        logger.debug('Feed',`[Feed:${config.name}] Sortable attributes updated successfully`);
      }
      if (filterableChanged && filterable.length) {
        logger.debug('Feed',`[Feed:${config.name}] Updating filterable attributes`);
        const task = await this.index.updateFilterableAttributes(filterable);
        await this.client.tasks.waitForTask(task.taskUid);
        logger.debug('Feed',`[Feed:${config.name}] Filterable attributes updated successfully`);
      }

      this.configured = true;
      logger.debug('Feed',`[Feed:${config.name}] Configuration complete in ${Date.now() - configStart}ms`);
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
    /**
     * Create documents without upserting to Meilisearch
     * Useful for testing and debugging document generation
     */
    async createDocuments(ids: number[], type: UpsertType = 'full'): Promise<TDoc[]> {
      return await config.createDocuments(this.context, ids, type);
    }

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
      logger.debug('Feed',`[Feed:${config.name}] Query started with input:`, JSON.stringify(input, null, 2));
      const queryStart = Date.now();

      await this.ready();

      // Extract pagination from input
      const { limit = 20, cursor, ...customInput } = input;

      // Parse cursor to extract offset
      // Cursor format: "offset|timestamp" e.g., "100|1724677401898"
      let offset = 0;
      let entry: string | undefined;

      if (cursor) {
        const parts = cursor.split('|');
        if (parts.length === 2) {
          offset = parseInt(parts[0]) || 0;
          entry = parts[1];
          logger.debug('Feed',`[Feed:${config.name}] Parsed cursor: offset=${offset}, entry=${entry}`);
        } else if (parts.length === 1) {
          // Fallback: if cursor is just a number, treat it as offset
          offset = parseInt(parts[0]) || 0;
          logger.debug('Feed',`[Feed:${config.name}] Parsed cursor as offset only: ${offset}`);
        } else {
          console.warn(`[Feed:${config.name}] Invalid cursor format, expected 'offset|timestamp', got:`, cursor);
        }
      }

      // Create context with pagination
      const ctxWithPagination: FeedContext<E> = {
        ...this.context,
        pagination: { limit, cursor, offset },
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

        logger.debug('Feed',`[Feed:${config.name}] More results available (${docs.length} > ${limit}), generating cursor from last returned item`);

        // Calculate new offset for next page
        const newOffset = offset + limit;

        // Get timestamp from last item using getCursor or default to sortAtUnix
        let timestamp: string | number;
        if (config.getCursor) {
          timestamp = config.getCursor(lastItem as TDoc);
          logger.debug('Feed',`[Feed:${config.name}] Got timestamp from getCursor():`, timestamp);
        } else {
          // Default: use sortAtUnix or sortAt or id
          timestamp = (lastItem.sortAtUnix as number) || (lastItem.sortAt as number) || (lastItem.id as number);
          logger.debug('Feed',`[Feed:${config.name}] Using default timestamp:`, timestamp);
        }

        // Generate cursor in format "offset|timestamp"
        nextCursor = `${newOffset}|${timestamp}`;
        logger.debug('Feed',`[Feed:${config.name}] Generated cursor:`, nextCursor);
      } else {
        // No more results
        data = docs;
        nextCursor = undefined;
        logger.debug('Feed',`[Feed:${config.name}] No more results available (${docs.length} <= ${limit}), no cursor generated`);
      }

      logger.debug('Feed',`[Feed:${config.name}] Query completed in ${Date.now() - queryStart}ms, returned ${data.length} documents, nextCursor: ${nextCursor}`);
      return { items: data, nextCursor };
    }

    /**
     * Populate documents with related data
     * Document and return types are inferred from config
     * Input parameter is passed for post-filtering and conditional data fetching
     *
     * @param docs - Documents to populate
     * @param input - Input parameters for filtering/conditional fetching
     * @param options - Optional settings
     * @param options.skipIndexCheck - Skip index availability check (for testing without index)
     */
    async populate(docs: TDoc[], input: TInput, options?: { skipIndexCheck?: boolean }): Promise<TPop[]> {
      logger.debug('Feed',`[Feed:${config.name}] Populate started with ${docs.length} documents`);
      const populateStart = Date.now();

      // In production, ensure index is ready; in dev/test mode, allow bypassing
      if (!options?.skipIndexCheck) {
        await this.ready();
      }

      const populatedDocs = await config.populateDocuments(this.context, docs, input);

      logger.debug('Feed',`[Feed:${config.name}] Populate completed in ${Date.now() - populateStart}ms`);
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
      const { items, nextCursor } = await this.query(input);

      // Extract custom input (without pagination) to pass to populate
      const populated = await this.populate(items, input as TInput);

      return { items: populated, nextCursor };
    }
  }

  return Feed;
}

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
  UpsertType,
  FeedSchema,
} from './types';

// Helper types to extract generics from config for proper type inference
type ExtractEntityType<T> = T extends CreateFeedConfig<infer E, any, any, any, any> ? E : never;
type ExtractInputType<T> = T extends CreateFeedConfig<any, infer TInput, any, any, any>
  ? TInput
  : never;
type ExtractDocument<T> = T extends CreateFeedConfig<any, any, any, infer TDoc, any> ? TDoc : never;
type ExtractPopulated<T> = T extends CreateFeedConfig<any, any, any, any, infer TPop>
  ? TPop
  : never;

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
export function createFeed<const TConfig extends CreateFeedConfig<EntityType, any, any, any, any>>(
  config: TConfig
) {
  const options: FeedAdvancedOptions = {
    fetchBatchSize: 1000,
    upsertBatchSize: 100000,
    createConcurrency: 2,
    ...(config.options ?? {}),
  };

  class Feed {
    private client: IMeilisearch;
    private context!: FeedContext<ExtractEntityType<TConfig>>;
    private index: IMeilisearchIndex | undefined;
    private indexError: Error | undefined;
    private indexReady: Promise<boolean>;

    constructor(
      meilisearch: IMeilisearch,
      ch: IClickhouseClient,
      pg: IDbClient,
      metricService: MetricService,
      cacheService: CacheService
    ) {
      this.client = meilisearch;

      // Initialize index and configure settings
      this.indexReady = getMeilisearchFeed({
        client: this.client,
        name: config.name,
      })
        .then(async (index) => {
          this.index = index;

          // Get current settings to avoid unnecessary updates
          const currentSettings = await index.getSettings();

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

          if (sortableChanged && sortable.length) await index.updateSortableAttributes(sortable);
          if (filterableChanged && filterable.length)
            await index.updateFilterableAttributes(filterable);

          return true;
        })
        .catch((err) => {
          this.indexError = err as Error;
          console.error(`Failed to initialize feed ${config.name}:`, err);
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
      } as FeedContext<ExtractEntityType<TConfig>>;
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
     * Delete documents from the index
     */
    async delete(ids: number[]): Promise<void> {
      await this.ready();
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
      await this.ready();

      const batcher = createAsyncBatcher<ExtractDocument<TConfig>>(
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
     */
    async query(input: FeedQueryInput<ExtractInputType<TConfig>>): Promise<ExtractDocument<TConfig>[]> {
      await this.ready();

      // Extract pagination from input
      const { limit = 20, cursor, ...customInput } = input;

      // Create context with pagination
      const ctxWithPagination: FeedContext<ExtractEntityType<TConfig>> = {
        ...this.context,
        pagination: { limit, cursor },
      };

      // Pass custom input (without pagination) to queryDocuments
      const docs = await config.queryDocuments(
        ctxWithPagination,
        customInput as ExtractInputType<TConfig>
      );
      return docs;
    }

    /**
     * Populate documents with related data
     * Document and return types are inferred from config
     */
    async populate(docs: ExtractDocument<TConfig>[]): Promise<ExtractPopulated<TConfig>[]> {
      await this.ready();
      const populatedDocs = await config.populateDocuments(this.context, docs);
      return populatedDocs;
    }

    /**
     * Query and populate in one call
     * Convenience method for common use case
     * All types are inferred from config
     */
    async populatedQuery(
      input: FeedQueryInput<ExtractInputType<TConfig>>
    ): Promise<ExtractPopulated<TConfig>[]> {
      const docs = await this.query(input);
      return await this.populate(docs);
    }
  }

  return Feed;
}

import * as caches from '../caches';
import type { ImageTagIds } from '../caches';
import { fetchImageTagIdsFromDb } from '../caches/imageData.cache';
import { CacheContext } from '../caches/base';
import { IRedisClient, IDbClient, IClickhouseClient, IDataPacker } from '../types/package-stubs';
import { withRedisPacking } from '../utils/redis-packer';

/**
 * Service to manage all caches with typed access
 *
 * Provides a centralized way to access cache functions with automatic type inference
 * based on the cache name.
 */
export class CacheService {
  private context: CacheContext;
  private imageTagIdsFetcher?: (ids: number[]) => Promise<Record<number, ImageTagIds>>;

  constructor(
    redis: IRedisClient,
    pg: IDbClient,
    ch: IClickhouseClient,
    packer?: IDataPacker,
    imageTagIdsFetcher?: (ids: number[]) => Promise<Record<number, ImageTagIds>>
  ) {
    this.imageTagIdsFetcher = imageTagIdsFetcher;
    this.context = {
      redis: packer ? withRedisPacking(redis, packer) : redis,
      pg: {
        query: async <T = any>(query: string, params?: any[]) => {
          const result = await pg.query(query, params);
          return result.rows as T[];
        },
      },
      ch: {
        query: async <T = any>(query: string, params?: any[]) => {
          const result = await ch.query({
            query: params ? query.replace(/\$(\d+)/g, (_, i) => String(params[parseInt(i) - 1])) : query,
            format: 'JSONEachRow',
          });
          return (await result.json()) as T[];
        },
      },
    };
  }

  /**
   * Fetch items from a cache by name
   * Type is automatically inferred from the cache name
   */
  async fetch<K extends keyof typeof caches>(
    name: K,
    ids: number[]
  ): Promise<Awaited<ReturnType<(typeof caches)[K]['fetch']>>> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.fetch(this.context, ids) as any;
  }

  /**
   * Fetch image tag IDs keyed by imageId.
   *
   * Replaces the retired `image:tagIds` Redis hash cache. Uses an injected
   * fetcher when the consumer supplies one (e.g. civitai backs this with its
   * already-warm `tagIdsForImagesCache`), otherwise falls back to an uncached
   * direct DB fetch (used by test/CLI/gated paths). No `image:tagIds` Redis
   * keys are ever written by this package again.
   */
  async fetchImageTagIds(ids: number[]): Promise<Record<number, ImageTagIds>> {
    if (!ids.length) return {};
    if (this.imageTagIdsFetcher) return this.imageTagIdsFetcher(ids);
    // Fallback: uncached direct DB fetch (no redis writes). Used by consumers
    // that don't inject a cache-backed impl (e.g. test/CLI/gated paths).
    return fetchImageTagIdsFromDb(this.context, ids);
  }

  /**
   * Bust (invalidate) cache entries by ID
   */
  async bust<K extends keyof typeof caches>(
    name: K,
    ids: number | number[],
    options?: { debounceTime?: number }
  ): Promise<void> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.bust(this.context, ids, options);
  }

  /**
   * Refresh cache entries by ID
   */
  async refresh<K extends keyof typeof caches>(name: K, ids: number | number[]): Promise<void> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.refresh(this.context, ids);
  }

  /**
   * Get multiple keys from Redis (batch get)
   * Provides direct access to Redis for feed operations
   */
  async mGet<T>(keys: string[]): Promise<(T | null)[]> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.mGet<T>(keys);
  }

  /**
   * Set a key-value pair in Redis with optional expiration
   * Provides direct access to Redis for feed operations
   */
  async set<T>(key: string, value: T, options?: { EX?: number }): Promise<void> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.set<T>(key, value, options);
  }

  /**
   * Add values to a Redis set
   * Provides direct access to Redis for feed operations
   */
  async sAdd<T>(key: string, values: T[]): Promise<void> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.sAdd<T>(key, values);
  }
}

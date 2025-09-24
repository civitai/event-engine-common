import { RedisWithHelpers, SimpleClickhouse, withRedisHelpers } from '../utils/query-utils';
import { EntityType, EntityMetricMap, ENTITY_METRIC_TYPES } from '../types/metric-types';
import { IClickhouseClient, IRedisClient } from '../types/package-stubs';
import { chunk, sleep } from '../utils/basic';
import { cacheKeys } from '../utils/cache-keys';

const FETCH_BATCH_SIZE = 1000;
const CACHE_TTL = 24 * 60 * 60; // 24 hours
const MISS_CACHE_TTL = 5 * 60; // 5 minutes
const CACHE_SLIDE_CHANCE = 0.1; // 10% chance of sliding the TTL on each access
const LOCK_DURATION = 2; // 2 seconds lock
const LOCK_RETRY_DELAY = 200; // 100ms delay between retries
const LOCK_MAX_RETRIES = 10; // Maximum number of retry attempts

export class MetricService {
  private ch: SimpleClickhouse;
  private redis: RedisWithHelpers;
  constructor(ch: IClickhouseClient, redis: IRedisClient) {
    this.ch = new SimpleClickhouse(ch);
    this.redis = withRedisHelpers(redis);
  }

  private getCacheKey(entityType: EntityType, id: number): string {
    return cacheKeys.metric(entityType, id);
  }

  private getLockKey(entityType: EntityType, id: number): string {
    return cacheKeys.metricLock(entityType, id);
  }


  /**
   * Fetch metrics for entities of a specific type.
   * The return type is automatically inferred based on the entityType parameter.
   *
   * @example
   * const articleMetrics = await service.fetch('Article', [1, 2, 3])
   * // Return type is Record<number, ArticleMetrics>
   *
   * const imageMetrics = await service.fetch('Image', [4, 5, 6])
   * // Return type is Record<number, ImageMetrics>
   */
  public async fetch<T extends EntityType>(entityType: T, ids: number[]): Promise<Record<number, EntityMetricMap[T]>> {
    if (!ids.length) return {};

    const results: Record<number, EntityMetricMap[T]> = {};
    const uniqueIds = [...new Set(ids)];
    const cacheMisses: number[] = [];

    // Step 1: Lookup all IDs in Redis using Promise.all
    const cacheResults = await this.redis.run(uniqueIds.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id))));

    // Step 2: Process cache results
    const slideTTLKeys: string[] = [];
    for (let i in uniqueIds) {
      const id = uniqueIds[i];
      const cacheResult = cacheResults[i] as Record<string, string> | null;

      if (cacheResult && Object.keys(cacheResult).length > 0) {
        const entries = Object.entries(cacheResult);
        // Check if this is a "not found" entry
        if (cacheResult.notFound === '1' && entries.length === 1) {
          continue; // Skip not found entries
        }

        // Convert string values back to numbers for metric fields
        const metrics: any = {};
        for (const [key, value] of entries) {
          if (key === 'notFound') continue;
          metrics[key] = parseInt(value, 10);
        }
        results[id] = metrics as EntityMetricMap[T];

        // Mark for potential TTL sliding (only for non-notFound entries)
        if (Math.random() < CACHE_SLIDE_CHANCE) {
          slideTTLKeys.push(this.getCacheKey(entityType, id));
        }
      } else {
        cacheMisses.push(id);
      }
    }

    // Step 3: Slide TTLs for hot cache entries
    if (slideTTLKeys.length > 0) {
      await this.redis.run(slideTTLKeys.map((key) => this.redis.expire(key, CACHE_TTL)));
    }

    // Step 4: Handle cache misses with lock mechanism to prevent stampedes
    if (cacheMisses.length > 0) {
      // Try to acquire locks for cache misses
      const lockedIds: number[] = [];
      const othersLocked: number[] = [];

      const gotLock = await this.redis.run(cacheMisses.map(
        (id) => this.redis.setNxKeepTtlWithEx(this.getLockKey(entityType, id), '1', LOCK_DURATION)
      ));

      // Separate IDs we locked vs IDs someone else is fetching
      for (let i = 0; i < cacheMisses.length; i++) {
        if (gotLock[i]) lockedIds.push(cacheMisses[i]);
        else othersLocked.push(cacheMisses[i]);
      }

      // Fetch data for IDs we successfully locked
      if (lockedIds.length > 0) {
        const freshData = await this.fetchFromClickhouse(entityType, lockedIds);

        // Cache the results and release locks
        const cacheAndLockOps: Promise<any>[] = [];

        for (const id of lockedIds) {
          if (freshData[id]) {
            // Cache found metrics with CACHE_TTL
            const metricsToCache: Record<string, string> = {};
            for (const [key, value] of Object.entries(freshData[id])) {
              metricsToCache[key] = value.toString();
            }

            cacheAndLockOps.push(
              this.redis.hSetEx(this.getCacheKey(entityType, id), metricsToCache, CACHE_TTL)
            );

            results[id] = freshData[id];
          } else {
            // Cache not found with MISS_CACHE_TTL
            cacheAndLockOps.push(
              this.redis.hSetEx(this.getCacheKey(entityType, id), { notFound: '1' }, MISS_CACHE_TTL)
            );
          }

          // Release lock
          cacheAndLockOps.push(this.redis.del(this.getLockKey(entityType, id)));
        }

        await this.redis.run(cacheAndLockOps);
      }

      // For IDs where someone else has the lock, wait and retry fetching from cache
      let retry = 0;
      while (othersLocked.length > 0 && retry < LOCK_MAX_RETRIES){
        // Wait for other processes to populate cache
        await sleep(LOCK_RETRY_DELAY);
        retry++;

        // Try to fetch from cache again
        const retryResults = await this.redis.run(
          othersLocked.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id)))
        );

        // Collect found results
        const found = [];
        for (let i of othersLocked) {
          const id = othersLocked[i];
          const cacheResult = retryResults[i];
          if (cacheResult && Object.keys(cacheResult).length > 0) {
            found.push(id);
            const entries = Object.entries(cacheResult);
            // Check if this is a "not found" entry
            if (cacheResult.notFound === '1' && entries.length === 1) {
              continue; // Skip not found entries
            }

            // Convert string values back to numbers for metric fields
            const metrics: any = {};
            for (const [key, value] of entries) {
              if (key === 'notFound') continue;
              metrics[key] = parseInt(value, 10);
            }
            results[id] = metrics as EntityMetricMap[T];
          }
        }

        // Remove found IDs from waitForOthersIds
        for (const id of found) {
          const index = othersLocked.indexOf(id);
          if (index > -1) othersLocked.splice(index, 1);
        }
      }
    }

    // Augment all results with zeros for missing fields and ensure all requested IDs have results
    const completeResults: Record<number, EntityMetricMap[T]> = {};
    // Initialize all fields with zeros
    const baseMetrics: any = {};
    for (const metricType of ENTITY_METRIC_TYPES[entityType]) baseMetrics[metricType] = 0;
    for (const id of uniqueIds) {
      if (results[id]) {
        completeResults[id] = {...baseMetrics, ...results[id]};
      } else {
        completeResults[id] = {...baseMetrics};
      }
    }

    return completeResults;
  }

  private async fetchFromClickhouse<T extends EntityType>(entityType: T, ids: number[]): Promise<Record<number, EntityMetricMap[T]>> {
    const metrics: Record<number, EntityMetricMap[T]> = {} as Record<number, EntityMetricMap[T]>;

    const batches = chunk(ids, FETCH_BATCH_SIZE);
    for (const batch of batches) {
      const rawMetrics = await this.ch.query<{ entityId: number; metricType: string; value: number }>`
                SELECT
                    entityId,
                    metricType,
                    sum(metricValue) as value
                FROM entityMetricEvents
                WHERE entityType = ${entityType}
                    AND entityId IN (${batch})
                    AND metricType IN (${ENTITY_METRIC_TYPES[entityType]})
                GROUP BY entityId, metricType
                HAVING value > 0
            `;
      for (const { entityId, metricType, value } of rawMetrics) {
        metrics[entityId] ??= {} as EntityMetricMap[T];
        (metrics[entityId] as any)[metricType] = value;
      }
    }

    return metrics;
  }

  public async fetchTimeframes<T extends EntityType>(
    entityType: T,
    ids: number[]
  ): Promise<Record<number, Record<Timeframes, EntityMetricMap[T]>>> {
    if (!ids.length) return {};

    const results: Record<number, Record<Timeframes, EntityMetricMap[T]>> = {};
    const uniqueIds = [...new Set(ids)];

    const baseMetrics: any = {};
    for (const metricType of ENTITY_METRIC_TYPES[entityType])
      baseMetrics[metricType] = 0;

    const batches = chunk(uniqueIds, FETCH_BATCH_SIZE);
    for (const batch of batches) {
      const rawMetrics = await this.ch.query<TimeframeMetricRow>`
        SELECT
          entityId,
          metricType,
          sumIf(total, day >= today()) AS Day,
          sumIf(total, day >= subtractWeeks(today(), 1)) AS Week,
          sumIf(total, day >= subtractMonths(today(), 1)) AS Month,
          sumIf(total, day >= subtractYears(today(), 1))  AS Year,
          sum(total) AS AllTime
        FROM entityMetricDailyAgg
        WHERE entityType = ${entityType}
          AND entityId IN (${batch})
          AND metricType IN (${ENTITY_METRIC_TYPES[entityType]})
        GROUP BY entityId, metricType
      `;

      for (const row of rawMetrics) {
        const { entityId, metricType, ...timeframeValues } = row;

        // Initialize metric objects if they don't exist
        results[entityId] ??= {} as Record<Timeframes, EntityMetricMap[T]>;

        // Assign values for each timeframe using the matching property names
        for (const timeframe of TIMEFRAMES) {
          results[entityId][timeframe] ??= {...baseMetrics} as EntityMetricMap[T];
          (results[entityId][timeframe] as any)[metricType] = timeframeValues[timeframe];
        }
      }
    }

    // Populate missing results with zeros
    for (const id of uniqueIds) {
      if (results[id]) continue;
      results[id] = {} as Record<Timeframes, EntityMetricMap[T]>;
      for (const timeframe of TIMEFRAMES) {
        results[id][timeframe] = {...baseMetrics} as EntityMetricMap[T];
      }
    }

    return results;
  }

  public async bustCache<T extends EntityType>(entityType: T, ids: number | number[]): Promise<void> {
    ids = Array.isArray(ids) ? ids : [ids];
    if (!ids.length) return;
    const uniqueIds = [...new Set(ids)];
    await this.redis.run(uniqueIds.map((id) => this.redis.del(this.getCacheKey(entityType, id))));
  }
}

const TIMEFRAMES = ['Day', 'Week', 'Month', 'Year', 'AllTime'] as const;
type Timeframes = typeof TIMEFRAMES[number];
type TimeframeMetricRow = {
  entityId: number;
  metricType: string;
  Day: number;
  Week: number;
  Month: number;
  Year: number;
  AllTime: number;
};
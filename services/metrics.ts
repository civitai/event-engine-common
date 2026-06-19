import { RedisWithHelpers, SimpleClickhouse, withRedisHelpers } from '../utils/query-utils';
import { EntityType, EntityMetricMap, ENTITY_METRIC_TYPES } from '../types/metric-types';
import { IClickhouseClient, IRedisClient } from '../types/package-stubs';
import { chunk, sleep } from '../utils/basic';
import { cacheKeys } from '../utils/cache-keys';
import { logger } from '../utils/logger';

const FETCH_BATCH_SIZE = 1000;
// 12h. Measured live (2026-06-17): the `metrics:<entityType>:<id>` hashes are
// ~17.5 GiB on next-redis-cluster (~18%, 2nd-largest consumer). Metrics are the
// source-of-truth-in-ClickHouse repopulated on miss, and hot entries slide their
// TTL (CACHE_SLIDE_CHANCE) so they stay resident regardless — so lowering the cap
// from 24h only shortens how long COLD entries linger, ~halving the cold tail.
const CACHE_TTL = 12 * 60 * 60; // 12 hours
const MISS_CACHE_TTL = 5 * 60; // 5 minutes
const CACHE_SLIDE_CHANCE = 0.1; // 10% chance of sliding the TTL on each access
// Stampede-lock TTL. This is the *backstop* expiry if a holder pod dies mid
// populate; while the holder is alive it heartbeats the lock (see
// LOCK_HEARTBEAT_MS) so the lock never lapses mid-query. Kept short so a truly
// dead holder's ids unblock quickly.
//
// History: this was 2s with no heartbeat. When ClickHouse degraded and a
// populate query ran longer than 2s, the lock expired *mid-query*, so the next
// incoming request for the same ids re-acquired it and fired a DUPLICATE query.
// Under load this re-fire loop compounded every 2s into a thundering herd that
// saturated CH's simultaneous-query cap (2026-06 cutover incident). Heartbeating
// the lock for the real query duration removes that re-fire entirely.
const LOCK_DURATION = 10; // 10s backstop TTL (heartbeated while holder alive)
const LOCK_HEARTBEAT_MS = 5000; // re-extend held locks every 5s during a populate
const LOCK_RETRY_DELAY = 200; // delay between waiter cache-poll retries
const LOCK_MAX_RETRIES = 15; // waiter cache-poll attempts (~3s) before giving up

// Describes which ClickHouse table the read path pulls per-day totals from,
// and whether that table still needs the per-(entity,metric,day) argMax dedup.
//
// - `entityMetricDailyAgg_new` is a ReplacingMergeTree(refreshedAt): the agg MV
//   re-inserts each row with a new refreshedAt and old versions linger until a
//   background merge, so a read MUST argMax(total, refreshedAt) per day before
//   summing or it over-counts (up to ~2x). -> needsArgMaxDedup: true.
// - `entityMetricDailyAgg_v2` is a read VIEW that already returns FINAL per-day
//   totals directly (no append-churn, always fresh). -> needsArgMaxDedup: false.
export type AggSource = { table: string; needsArgMaxDedup: boolean };

// Default source preserves byte-identical legacy behavior when no provider is
// supplied (framework-free callers, tests). The owning app passes a provider
// that flips `table`/`needsArgMaxDedup` off a feature flag for a reversible
// cutover; it is resolved fresh on every CH query so the flag stays live even
// though MetricService is constructed once and reused.
const DEFAULT_AGG_SOURCE: AggSource = {
  table: 'entityMetricDailyAgg_new',
  needsArgMaxDedup: true,
};

export type AggSourceProvider = () => Promise<AggSource> | AggSource;

export class MetricService {
  private ch: SimpleClickhouse;
  private redis: RedisWithHelpers;
  private aggSourceProvider: AggSourceProvider;
  constructor(ch: IClickhouseClient, redis: IRedisClient, aggSourceProvider?: AggSourceProvider) {
    this.ch = new SimpleClickhouse(ch);
    this.redis = withRedisHelpers(redis);
    this.aggSourceProvider = aggSourceProvider ?? (() => DEFAULT_AGG_SOURCE);
    logger.metric('Initialized with ClickHouse and Redis clients');
    logger.metric('Redis client type:', typeof redis);
    logger.metric('Redis client constructor:', redis.constructor.name);
    logger.metric('withRedisHelpers result type:', typeof this.redis);
    logger.metric('Redis helpers available:', Object.getOwnPropertyNames(this.redis));
  }

  private getCacheKey(entityType: EntityType, id: number): string {
    return cacheKeys.metric(entityType, id);
  }

  private getLockKey(entityType: EntityType, id: number): string {
    return cacheKeys.metricLock(entityType, id);
  }

  // Keep the stampede locks we currently hold alive for the full duration of a
  // populate by periodically re-extending their TTL. The lock acquire sets a
  // short backstop TTL (LOCK_DURATION) that only matters if the holder pod dies;
  // while it's alive this re-arms that TTL every LOCK_HEARTBEAT_MS so the lock
  // never lapses mid-query (which would let other pods re-fire duplicate
  // queries). Returns a function that cancels the heartbeat. Uses a recursive
  // setTimeout (not setInterval) so a slow Redis round-trip can't overlap beats.
  private startLockHeartbeat(entityType: EntityType, ids: number[]): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const beat = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          await this.redis.run(
            ids.map((id) => this.redis.expire(this.getLockKey(entityType, id), LOCK_DURATION))
          );
        } catch (error) {
          logger.error('MetricService', 'Lock heartbeat failed:', error);
        }
        if (!stopped) beat();
      }, LOCK_HEARTBEAT_MS);
      // Don't let a pending heartbeat keep the process alive on shutdown.
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    };

    beat();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  // Build the `(entityId, metricType, day, total)` subquery the timeframe/sum
  // aggregations read from. When the source still has append-churn we argMax
  // per (entity, metric, day); when it's the already-FINAL v2 view we select
  // total directly (argMax over a single version is a no-op cost we skip).
  private buildPerDaySource(
    source: AggSource,
    entityType: EntityType,
    ids: number[],
    metricTypes: readonly string[]
  ): string {
    const idList = ids.join(',');
    const metricList = metricTypes.map((mt) => `'${mt}'`).join(',');
    const where = `WHERE entityType = '${entityType}'
              AND entityId IN (${idList})
              AND metricType IN (${metricList})`;
    if (source.needsArgMaxDedup) {
      return `(
            SELECT entityId, metricType, day, argMax(total, refreshedAt) AS total
            FROM ${source.table}
            ${where}
            GROUP BY entityId, metricType, day
          )`;
    }
    return `(
            SELECT entityId, metricType, day, total
            FROM ${source.table}
            ${where}
          )`;
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
    const startTime = Date.now();
    logger.metric(`fetch() called for entityType: ${entityType}, ids: [${ids.join(', ')}]`);
    if (!ids.length) {
      logger.metric('No IDs provided, returning empty result');
      return {};
    }

    const results: Record<number, EntityMetricMap[T]> = {};
    const uniqueIds = [...new Set(ids)];
    const cacheMisses: number[] = [];

    // Step 1: Lookup all IDs in Redis using Promise.all
    logger.metric(`Looking up ${uniqueIds.length} IDs in Redis cache`);
    logger.metric(`About to call redis.run with ${uniqueIds.length} operations`);
    logger.metric('Redis run function:', typeof this.redis.run);

    let cacheResults;
    try {
      const operations = uniqueIds.map((id) => {
        logger.metric(`Creating hGetAll operation for key: ${this.getCacheKey(entityType, id)}`);
        return this.redis.hGetAll(this.getCacheKey(entityType, id));
      });
      logger.metric(`Created ${operations.length} hGetAll operations`);
      logger.metric('Calling redis.run with operations...');

      cacheResults = await this.redis.run(operations);
      logger.metric(`Redis cache lookup completed for ${uniqueIds.length} keys`);
    } catch (error) {
      logger.error('MetricService', 'Redis cache lookup failed:', error);
      // @ts-ignore TS2339
      logger.error('MetricService', 'Error stack:', error.stack);
      logger.logObject('MetricService', 'Redis client state:', {
        redisType: typeof this.redis,
        runType: typeof this.redis.run,
        hasRun: 'run' in this.redis
      });
      throw error;
    }

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
      logger.metric(`Sliding TTL for ${slideTTLKeys.length} hot cache entries`);
      try {
        await this.redis.run(slideTTLKeys.map((key) => this.redis.expire(key, CACHE_TTL)));
        logger.metric(`TTL sliding completed for ${slideTTLKeys.length} keys`);
      } catch (error) {
        logger.error('MetricService', 'TTL sliding failed:', error);
        throw error;
      }
    }

    // Step 4: Handle cache misses with lock mechanism to prevent stampedes
    if (cacheMisses.length > 0) {
      // Try to acquire locks for cache misses
      const lockedIds: number[] = [];
      const othersLocked: number[] = [];

      logger.metric(`Attempting to acquire locks for ${cacheMisses.length} cache misses`);
      let gotLock;
      try {
        gotLock = await this.redis.run(cacheMisses.map(
          (id) => this.redis.setNxKeepTtlWithEx(this.getLockKey(entityType, id), '1', LOCK_DURATION)
        ));
        logger.metric('Lock acquisition completed');
      } catch (error) {
        logger.error('MetricService', 'Lock acquisition failed:', error);
        throw error;
      }

      // Separate IDs we locked vs IDs someone else is fetching
      for (let i = 0; i < cacheMisses.length; i++) {
        if (gotLock[i]) lockedIds.push(cacheMisses[i]);
        else othersLocked.push(cacheMisses[i]);
      }

      // Fetch data for IDs we successfully locked
      if (lockedIds.length > 0) {
        logger.metric(`Fetching fresh data from ClickHouse for ${lockedIds.length} locked IDs: [${lockedIds.join(', ')}]`);

        // Heartbeat the locks we hold so they can't expire while this (possibly
        // slow) populate runs. Without this, a query slower than LOCK_DURATION
        // lets the lock lapse mid-flight and other pods re-acquire it and fire
        // duplicate queries for the same ids -> thundering herd. Always stopped
        // and the locks always released in the `finally` below.
        const stopHeartbeat = this.startLockHeartbeat(entityType, lockedIds);
        try {
          const freshData = await this.fetchFromClickhouse(entityType, lockedIds);
          logger.metric(`ClickHouse fetch completed, got data for ${Object.keys(freshData).length} entities`);

          // Cache the results. Lock release is handled in `finally` so it runs
          // even if the populate or this cache write throws.
          const cacheOps: Promise<any>[] = [];
          for (const id of lockedIds) {
            if (freshData[id]) {
              // Cache found metrics with CACHE_TTL
              const metricsToCache: Record<string, string> = {};
              for (const [key, value] of Object.entries(freshData[id])) {
                metricsToCache[key] = value.toString();
              }

              cacheOps.push(
                this.redis.hSetEx(this.getCacheKey(entityType, id), metricsToCache, CACHE_TTL)
              );

              results[id] = freshData[id];
            } else {
              // Cache not found with MISS_CACHE_TTL
              cacheOps.push(
                this.redis.hSetEx(this.getCacheKey(entityType, id), { notFound: '1' }, MISS_CACHE_TTL)
              );
            }
          }

          logger.metric(`Executing ${cacheOps.length} cache operations`);
          await this.redis.run(cacheOps);
          logger.metric('Cache operations completed successfully');
        } catch (error) {
          logger.error('MetricService', 'Populate/cache operations failed:', error);
          throw error;
        } finally {
          // Stop heartbeating and release EVERY lock we acquired, even on error.
          // Previously a thrown CH/cache error skipped the lock-release ops and
          // left the locks dangling until their TTL, blocking all waiters for
          // those ids for the full duration.
          stopHeartbeat();
          try {
            await this.redis.run(
              lockedIds.map((id) => this.redis.del(this.getLockKey(entityType, id)))
            );
            logger.metric(`Released ${lockedIds.length} populate locks`);
          } catch (releaseError) {
            logger.error('MetricService', 'Lock release failed:', releaseError);
          }
        }
      }

      // For IDs where someone else has the lock, wait and retry fetching from cache
      let retry = 0;
      if (othersLocked.length > 0) {
        logger.metric(`Waiting for ${othersLocked.length} IDs locked by other processes: [${othersLocked.join(', ')}]`);
      }
      while (othersLocked.length > 0 && retry < LOCK_MAX_RETRIES){
        // Wait for other processes to populate cache
        logger.metric(`Retry ${retry + 1}/${LOCK_MAX_RETRIES}: waiting ${LOCK_RETRY_DELAY}ms for other processes`);
        await sleep(LOCK_RETRY_DELAY);
        retry++;

        // Try to fetch from cache again
        logger.metric(`Retry attempt ${retry}: fetching ${othersLocked.length} IDs from cache`);
        let retryResults;
        try {
          retryResults = await this.redis.run(
            othersLocked.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id)))
          );
          logger.metric('Retry cache fetch completed');
        } catch (error) {
          logger.error('MetricService', `Retry cache fetch failed on attempt ${retry}:`, error);
          throw error;
        }

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

    const totalTime = Date.now() - startTime;
    logger.metric(`fetch() completed in ${totalTime}ms for entityType: ${entityType}, returned ${Object.keys(completeResults).length} results`);
    return completeResults;
  }

  private async fetchFromClickhouse<T extends EntityType>(entityType: T, ids: number[]): Promise<Record<number, EntityMetricMap[T]>> {
    const startTime = Date.now();
    logger.clickhouse(`fetchFromClickhouse() called for entityType: ${entityType}, ${ids.length} IDs: [${ids.join(', ')}]`);
    const metrics: Record<number, EntityMetricMap[T]> = {} as Record<number, EntityMetricMap[T]>;

    const batches = chunk(ids, FETCH_BATCH_SIZE);
    logger.clickhouse(`Processing ${batches.length} batches of max ${FETCH_BATCH_SIZE} IDs each`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();
      logger.clickhouse(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} IDs: [${batch.join(', ')}]`);

      let rawMetrics;
      try {
        logger.clickhouse(`Executing ClickHouse query for batch ${batchIndex + 1}`);
        // Source table + dedup mode resolved fresh per query so the owning app's
        // feature flag stays live even though this service is a reused singleton.
        const source = await this.aggSourceProvider();
        const perDaySource = this.buildPerDaySource(
          source,
          entityType,
          batch,
          ENTITY_METRIC_TYPES[entityType]
        );
        rawMetrics = await this.ch.query<{ entityId: number; metricType: string; value: number }>(`
          SELECT
            entityId,
            metricType,
            sum(total) AS value
          FROM ${perDaySource}
          GROUP BY entityId, metricType
          HAVING value > 0;
        `);
        const batchTime = Date.now() - batchStartTime;
        logger.clickhouse(`ClickHouse query completed for batch ${batchIndex + 1} in ${batchTime}ms, got ${rawMetrics.length} rows`);
      } catch (error) {
        logger.error('ClickHouse', `Query failed for batch ${batchIndex + 1}:`, error);
        throw error;
      }

      logger.clickhouse(`Processing ${rawMetrics.length} metric rows from batch ${batchIndex + 1}`);
      for (const { entityId, metricType, value } of rawMetrics) {
        metrics[entityId] ??= {} as EntityMetricMap[T];
        (metrics[entityId] as any)[metricType] = value;
      }
      logger.clickhouse(`Completed processing batch ${batchIndex + 1}, current total entities: ${Object.keys(metrics).length}`);
    }

    const totalTime = Date.now() - startTime;
    logger.clickhouse(`fetchFromClickhouse() completed in ${totalTime}ms, returning metrics for ${Object.keys(metrics).length} entities`);
    return metrics;
  }

  public async fetchTimeframes<T extends EntityType>(
    entityType: T,
    ids: number[]
  ): Promise<Record<number, Record<Timeframes, EntityMetricMap[T]>>> {
    const startTime = Date.now();
    logger.metric(`fetchTimeframes() called for entityType: ${entityType}, ${ids.length} IDs: [${ids.join(', ')}]`);
    if (!ids.length) {
      logger.metric('No IDs provided for fetchTimeframes, returning empty result');
      return {};
    }

    const results: Record<number, Record<Timeframes, EntityMetricMap[T]>> = {};
    const uniqueIds = [...new Set(ids)];

    const baseMetrics: any = {};
    for (const metricType of ENTITY_METRIC_TYPES[entityType])
      baseMetrics[metricType] = 0;

    const batches = chunk(uniqueIds, FETCH_BATCH_SIZE);
    logger.clickhouse(`fetchTimeframes processing ${batches.length} batches`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();
      logger.clickhouse(`fetchTimeframes processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} IDs`);

      let rawMetrics;
      try {
        logger.clickhouse(`Executing ClickHouse timeframes query for batch ${batchIndex + 1}`);
        // See fetchFromClickhouse: source/dedup resolved fresh per query.
        const source = await this.aggSourceProvider();
        const perDaySource = this.buildPerDaySource(
          source,
          entityType,
          batch,
          ENTITY_METRIC_TYPES[entityType]
        );
        rawMetrics = await this.ch.query<TimeframeMetricRow>(`
          SELECT
            entityId,
            metricType,
            sumIf(total, day >= today()) AS Day,
            sumIf(total, day >= subtractWeeks(today(), 1)) AS Week,
            sumIf(total, day >= subtractMonths(today(), 1)) AS Month,
            sumIf(total, day >= subtractYears(today(), 1))  AS Year,
            sum(total) AS AllTime
          FROM ${perDaySource}
          GROUP BY entityId, metricType
        `);
        const batchTime = Date.now() - batchStartTime;
        logger.clickhouse(`ClickHouse timeframes query completed for batch ${batchIndex + 1} in ${batchTime}ms, got ${rawMetrics.length} rows`);
      } catch (error) {
        logger.error('ClickHouse', `Timeframes query failed for batch ${batchIndex + 1}:`, error);
        throw error;
      }

      logger.clickhouse(`Processing ${rawMetrics.length} timeframe rows from batch ${batchIndex + 1}`);
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
      logger.clickhouse(`Completed processing timeframes batch ${batchIndex + 1}`);
    }

    // Populate missing results with zeros
    for (const id of uniqueIds) {
      if (results[id]) continue;
      results[id] = {} as Record<Timeframes, EntityMetricMap[T]>;
      for (const timeframe of TIMEFRAMES) {
        results[id][timeframe] = {...baseMetrics} as EntityMetricMap[T];
      }
    }

    const totalTime = Date.now() - startTime;
    logger.metric(`fetchTimeframes() completed in ${totalTime}ms, returning data for ${Object.keys(results).length} entities`);
    return results;
  }

  public async bustCache<T extends EntityType>(entityType: T, ids: number | number[]): Promise<void> {
    ids = Array.isArray(ids) ? ids : [ids];
    logger.metric(`bustCache() called for entityType: ${entityType}, ${Array.isArray(ids) ? ids.length : 1} IDs`);
    if (!ids.length) {
      logger.metric('No IDs provided for bustCache, returning');
      return;
    }
    const uniqueIds = [...new Set(ids)];
    logger.metric(`Deleting cache for ${uniqueIds.length} unique IDs`);
    try {
      await this.redis.run(uniqueIds.map((id) => this.redis.del(this.getCacheKey(entityType, id))));
      logger.metric(`Cache bust completed for ${uniqueIds.length} keys`);
    } catch (error) {
      logger.error('MetricService', 'Cache bust failed:', error);
      throw error;
    }
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

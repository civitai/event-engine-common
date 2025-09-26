"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricService = void 0;
const query_utils_1 = require("../utils/query-utils");
const metric_types_1 = require("../types/metric-types");
const basic_1 = require("../utils/basic");
const cache_keys_1 = require("../utils/cache-keys");
const logger_1 = require("../utils/logger");
const FETCH_BATCH_SIZE = 1000;
const CACHE_TTL = 24 * 60 * 60; // 24 hours
const MISS_CACHE_TTL = 5 * 60; // 5 minutes
const CACHE_SLIDE_CHANCE = 0.1; // 10% chance of sliding the TTL on each access
const LOCK_DURATION = 2; // 2 seconds lock
const LOCK_RETRY_DELAY = 200; // 100ms delay between retries
const LOCK_MAX_RETRIES = 10; // Maximum number of retry attempts
class MetricService {
    constructor(ch, redis) {
        this.ch = new query_utils_1.SimpleClickhouse(ch);
        this.redis = (0, query_utils_1.withRedisHelpers)(redis);
        logger_1.logger.metric('Initialized with ClickHouse and Redis clients');
        logger_1.logger.metric('Redis client type:', typeof redis);
        logger_1.logger.metric('Redis client constructor:', redis.constructor.name);
        logger_1.logger.metric('withRedisHelpers result type:', typeof this.redis);
        logger_1.logger.metric('Redis helpers available:', Object.getOwnPropertyNames(this.redis));
    }
    getCacheKey(entityType, id) {
        return cache_keys_1.cacheKeys.metric(entityType, id);
    }
    getLockKey(entityType, id) {
        return cache_keys_1.cacheKeys.metricLock(entityType, id);
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
    async fetch(entityType, ids) {
        const startTime = Date.now();
        logger_1.logger.metric(`fetch() called for entityType: ${entityType}, ids: [${ids.join(', ')}]`);
        if (!ids.length) {
            logger_1.logger.metric('No IDs provided, returning empty result');
            return {};
        }
        const results = {};
        const uniqueIds = [...new Set(ids)];
        const cacheMisses = [];
        // Step 1: Lookup all IDs in Redis using Promise.all
        logger_1.logger.metric(`Looking up ${uniqueIds.length} IDs in Redis cache`);
        logger_1.logger.metric(`About to call redis.run with ${uniqueIds.length} operations`);
        logger_1.logger.metric('Redis run function:', typeof this.redis.run);
        let cacheResults;
        try {
            const operations = uniqueIds.map((id) => {
                logger_1.logger.metric(`Creating hGetAll operation for key: ${this.getCacheKey(entityType, id)}`);
                return this.redis.hGetAll(this.getCacheKey(entityType, id));
            });
            logger_1.logger.metric(`Created ${operations.length} hGetAll operations`);
            logger_1.logger.metric('Calling redis.run with operations...');
            cacheResults = await this.redis.run(operations);
            logger_1.logger.metric(`Redis cache lookup completed for ${uniqueIds.length} keys`);
        }
        catch (error) {
            logger_1.logger.error('MetricService', 'Redis cache lookup failed:', error);
            // @ts-ignore TS2339
            logger_1.logger.error('MetricService', 'Error stack:', error.stack);
            logger_1.logger.logObject('MetricService', 'Redis client state:', {
                redisType: typeof this.redis,
                runType: typeof this.redis.run,
                hasRun: 'run' in this.redis
            });
            throw error;
        }
        // Step 2: Process cache results
        const slideTTLKeys = [];
        for (let i in uniqueIds) {
            const id = uniqueIds[i];
            const cacheResult = cacheResults[i];
            if (cacheResult && Object.keys(cacheResult).length > 0) {
                const entries = Object.entries(cacheResult);
                // Check if this is a "not found" entry
                if (cacheResult.notFound === '1' && entries.length === 1) {
                    continue; // Skip not found entries
                }
                // Convert string values back to numbers for metric fields
                const metrics = {};
                for (const [key, value] of entries) {
                    if (key === 'notFound')
                        continue;
                    metrics[key] = parseInt(value, 10);
                }
                results[id] = metrics;
                // Mark for potential TTL sliding (only for non-notFound entries)
                if (Math.random() < CACHE_SLIDE_CHANCE) {
                    slideTTLKeys.push(this.getCacheKey(entityType, id));
                }
            }
            else {
                cacheMisses.push(id);
            }
        }
        // Step 3: Slide TTLs for hot cache entries
        if (slideTTLKeys.length > 0) {
            logger_1.logger.metric(`Sliding TTL for ${slideTTLKeys.length} hot cache entries`);
            try {
                await this.redis.run(slideTTLKeys.map((key) => this.redis.expire(key, CACHE_TTL)));
                logger_1.logger.metric(`TTL sliding completed for ${slideTTLKeys.length} keys`);
            }
            catch (error) {
                logger_1.logger.error('MetricService', 'TTL sliding failed:', error);
                throw error;
            }
        }
        // Step 4: Handle cache misses with lock mechanism to prevent stampedes
        if (cacheMisses.length > 0) {
            // Try to acquire locks for cache misses
            const lockedIds = [];
            const othersLocked = [];
            logger_1.logger.metric(`Attempting to acquire locks for ${cacheMisses.length} cache misses`);
            let gotLock;
            try {
                gotLock = await this.redis.run(cacheMisses.map((id) => this.redis.setNxKeepTtlWithEx(this.getLockKey(entityType, id), '1', LOCK_DURATION)));
                logger_1.logger.metric('Lock acquisition completed');
            }
            catch (error) {
                logger_1.logger.error('MetricService', 'Lock acquisition failed:', error);
                throw error;
            }
            // Separate IDs we locked vs IDs someone else is fetching
            for (let i = 0; i < cacheMisses.length; i++) {
                if (gotLock[i])
                    lockedIds.push(cacheMisses[i]);
                else
                    othersLocked.push(cacheMisses[i]);
            }
            // Fetch data for IDs we successfully locked
            if (lockedIds.length > 0) {
                logger_1.logger.metric(`Fetching fresh data from ClickHouse for ${lockedIds.length} locked IDs: [${lockedIds.join(', ')}]`);
                const freshData = await this.fetchFromClickhouse(entityType, lockedIds);
                logger_1.logger.metric(`ClickHouse fetch completed, got data for ${Object.keys(freshData).length} entities`);
                // Cache the results and release locks
                const cacheAndLockOps = [];
                for (const id of lockedIds) {
                    if (freshData[id]) {
                        // Cache found metrics with CACHE_TTL
                        const metricsToCache = {};
                        for (const [key, value] of Object.entries(freshData[id])) {
                            metricsToCache[key] = value.toString();
                        }
                        cacheAndLockOps.push(this.redis.hSetEx(this.getCacheKey(entityType, id), metricsToCache, CACHE_TTL));
                        results[id] = freshData[id];
                    }
                    else {
                        // Cache not found with MISS_CACHE_TTL
                        cacheAndLockOps.push(this.redis.hSetEx(this.getCacheKey(entityType, id), { notFound: '1' }, MISS_CACHE_TTL));
                    }
                    // Release lock
                    cacheAndLockOps.push(this.redis.del(this.getLockKey(entityType, id)));
                }
                logger_1.logger.metric(`Executing ${cacheAndLockOps.length} cache and lock operations`);
                try {
                    await this.redis.run(cacheAndLockOps);
                    logger_1.logger.metric('Cache and lock operations completed successfully');
                }
                catch (error) {
                    logger_1.logger.error('MetricService', 'Cache and lock operations failed:', error);
                    throw error;
                }
            }
            // For IDs where someone else has the lock, wait and retry fetching from cache
            let retry = 0;
            if (othersLocked.length > 0) {
                logger_1.logger.metric(`Waiting for ${othersLocked.length} IDs locked by other processes: [${othersLocked.join(', ')}]`);
            }
            while (othersLocked.length > 0 && retry < LOCK_MAX_RETRIES) {
                // Wait for other processes to populate cache
                logger_1.logger.metric(`Retry ${retry + 1}/${LOCK_MAX_RETRIES}: waiting ${LOCK_RETRY_DELAY}ms for other processes`);
                await (0, basic_1.sleep)(LOCK_RETRY_DELAY);
                retry++;
                // Try to fetch from cache again
                logger_1.logger.metric(`Retry attempt ${retry}: fetching ${othersLocked.length} IDs from cache`);
                let retryResults;
                try {
                    retryResults = await this.redis.run(othersLocked.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id))));
                    logger_1.logger.metric('Retry cache fetch completed');
                }
                catch (error) {
                    logger_1.logger.error('MetricService', `Retry cache fetch failed on attempt ${retry}:`, error);
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
                        const metrics = {};
                        for (const [key, value] of entries) {
                            if (key === 'notFound')
                                continue;
                            metrics[key] = parseInt(value, 10);
                        }
                        results[id] = metrics;
                    }
                }
                // Remove found IDs from waitForOthersIds
                for (const id of found) {
                    const index = othersLocked.indexOf(id);
                    if (index > -1)
                        othersLocked.splice(index, 1);
                }
            }
        }
        // Augment all results with zeros for missing fields and ensure all requested IDs have results
        const completeResults = {};
        // Initialize all fields with zeros
        const baseMetrics = {};
        for (const metricType of metric_types_1.ENTITY_METRIC_TYPES[entityType])
            baseMetrics[metricType] = 0;
        for (const id of uniqueIds) {
            if (results[id]) {
                completeResults[id] = { ...baseMetrics, ...results[id] };
            }
            else {
                completeResults[id] = { ...baseMetrics };
            }
        }
        const totalTime = Date.now() - startTime;
        logger_1.logger.metric(`fetch() completed in ${totalTime}ms for entityType: ${entityType}, returned ${Object.keys(completeResults).length} results`);
        return completeResults;
    }
    async fetchFromClickhouse(entityType, ids) {
        const startTime = Date.now();
        logger_1.logger.clickhouse(`fetchFromClickhouse() called for entityType: ${entityType}, ${ids.length} IDs: [${ids.join(', ')}]`);
        const metrics = {};
        const batches = (0, basic_1.chunk)(ids, FETCH_BATCH_SIZE);
        logger_1.logger.clickhouse(`Processing ${batches.length} batches of max ${FETCH_BATCH_SIZE} IDs each`);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchStartTime = Date.now();
            logger_1.logger.clickhouse(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} IDs: [${batch.join(', ')}]`);
            let rawMetrics;
            try {
                logger_1.logger.clickhouse(`Executing ClickHouse query for batch ${batchIndex + 1}`);
                rawMetrics = await this.ch.query `
                SELECT
                    entityId,
                    metricType,
                    sum(metricValue) as value
                FROM entityMetricEvents
                WHERE entityType = '${entityType}'
                    AND entityId IN (${batch})
                    AND metricType IN (${metric_types_1.ENTITY_METRIC_TYPES[entityType].map(v => `'${v}'`).join(',')})
                GROUP BY entityId, metricType
                HAVING value > 0
            `;
                const batchTime = Date.now() - batchStartTime;
                logger_1.logger.clickhouse(`ClickHouse query completed for batch ${batchIndex + 1} in ${batchTime}ms, got ${rawMetrics.length} rows`);
            }
            catch (error) {
                logger_1.logger.error('ClickHouse', `Query failed for batch ${batchIndex + 1}:`, error);
                throw error;
            }
            logger_1.logger.clickhouse(`Processing ${rawMetrics.length} metric rows from batch ${batchIndex + 1}`);
            for (const { entityId, metricType, value } of rawMetrics) {
                metrics[entityId] ?? (metrics[entityId] = {});
                metrics[entityId][metricType] = value;
            }
            logger_1.logger.clickhouse(`Completed processing batch ${batchIndex + 1}, current total entities: ${Object.keys(metrics).length}`);
        }
        const totalTime = Date.now() - startTime;
        logger_1.logger.clickhouse(`fetchFromClickhouse() completed in ${totalTime}ms, returning metrics for ${Object.keys(metrics).length} entities`);
        return metrics;
    }
    async fetchTimeframes(entityType, ids) {
        var _a;
        const startTime = Date.now();
        logger_1.logger.metric(`fetchTimeframes() called for entityType: ${entityType}, ${ids.length} IDs: [${ids.join(', ')}]`);
        if (!ids.length) {
            logger_1.logger.metric('No IDs provided for fetchTimeframes, returning empty result');
            return {};
        }
        const results = {};
        const uniqueIds = [...new Set(ids)];
        const baseMetrics = {};
        for (const metricType of metric_types_1.ENTITY_METRIC_TYPES[entityType])
            baseMetrics[metricType] = 0;
        const batches = (0, basic_1.chunk)(uniqueIds, FETCH_BATCH_SIZE);
        logger_1.logger.clickhouse(`fetchTimeframes processing ${batches.length} batches`);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchStartTime = Date.now();
            logger_1.logger.clickhouse(`fetchTimeframes processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} IDs`);
            let rawMetrics;
            try {
                logger_1.logger.clickhouse(`Executing ClickHouse timeframes query for batch ${batchIndex + 1}`);
                rawMetrics = await this.ch.query `
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
            AND metricType IN (${metric_types_1.ENTITY_METRIC_TYPES[entityType]})
          GROUP BY entityId, metricType
        `;
                const batchTime = Date.now() - batchStartTime;
                logger_1.logger.clickhouse(`ClickHouse timeframes query completed for batch ${batchIndex + 1} in ${batchTime}ms, got ${rawMetrics.length} rows`);
            }
            catch (error) {
                logger_1.logger.error('ClickHouse', `Timeframes query failed for batch ${batchIndex + 1}:`, error);
                throw error;
            }
            logger_1.logger.clickhouse(`Processing ${rawMetrics.length} timeframe rows from batch ${batchIndex + 1}`);
            for (const row of rawMetrics) {
                const { entityId, metricType, ...timeframeValues } = row;
                // Initialize metric objects if they don't exist
                results[entityId] ?? (results[entityId] = {});
                // Assign values for each timeframe using the matching property names
                for (const timeframe of TIMEFRAMES) {
                    (_a = results[entityId])[timeframe] ?? (_a[timeframe] = { ...baseMetrics });
                    results[entityId][timeframe][metricType] = timeframeValues[timeframe];
                }
            }
            logger_1.logger.clickhouse(`Completed processing timeframes batch ${batchIndex + 1}`);
        }
        // Populate missing results with zeros
        for (const id of uniqueIds) {
            if (results[id])
                continue;
            results[id] = {};
            for (const timeframe of TIMEFRAMES) {
                results[id][timeframe] = { ...baseMetrics };
            }
        }
        const totalTime = Date.now() - startTime;
        logger_1.logger.metric(`fetchTimeframes() completed in ${totalTime}ms, returning data for ${Object.keys(results).length} entities`);
        return results;
    }
    async bustCache(entityType, ids) {
        ids = Array.isArray(ids) ? ids : [ids];
        logger_1.logger.metric(`bustCache() called for entityType: ${entityType}, ${Array.isArray(ids) ? ids.length : 1} IDs`);
        if (!ids.length) {
            logger_1.logger.metric('No IDs provided for bustCache, returning');
            return;
        }
        const uniqueIds = [...new Set(ids)];
        logger_1.logger.metric(`Deleting cache for ${uniqueIds.length} unique IDs`);
        try {
            await this.redis.run(uniqueIds.map((id) => this.redis.del(this.getCacheKey(entityType, id))));
            logger_1.logger.metric(`Cache bust completed for ${uniqueIds.length} keys`);
        }
        catch (error) {
            logger_1.logger.error('MetricService', 'Cache bust failed:', error);
            throw error;
        }
    }
}
exports.MetricService = MetricService;
const TIMEFRAMES = ['Day', 'Week', 'Month', 'Year', 'AllTime'];

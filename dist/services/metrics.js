"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricService = void 0;
const query_utils_1 = require("../utils/query-utils");
const metric_types_1 = require("../types/metric-types");
const basic_1 = require("../utils/basic");
const cache_keys_1 = require("../utils/cache-keys");
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
        if (!ids.length)
            return {};
        const results = {};
        const uniqueIds = [...new Set(ids)];
        const cacheMisses = [];
        // Step 1: Lookup all IDs in Redis using Promise.all
        const cacheResults = await this.redis.run(uniqueIds.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id))));
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
            await this.redis.run(slideTTLKeys.map((key) => this.redis.expire(key, CACHE_TTL)));
        }
        // Step 4: Handle cache misses with lock mechanism to prevent stampedes
        if (cacheMisses.length > 0) {
            // Try to acquire locks for cache misses
            const lockedIds = [];
            const othersLocked = [];
            const gotLock = await this.redis.run(cacheMisses.map((id) => this.redis.setNxKeepTtlWithEx(this.getLockKey(entityType, id), '1', LOCK_DURATION)));
            // Separate IDs we locked vs IDs someone else is fetching
            for (let i = 0; i < cacheMisses.length; i++) {
                if (gotLock[i])
                    lockedIds.push(cacheMisses[i]);
                else
                    othersLocked.push(cacheMisses[i]);
            }
            // Fetch data for IDs we successfully locked
            if (lockedIds.length > 0) {
                const freshData = await this.fetchFromClickhouse(entityType, lockedIds);
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
                await this.redis.run(cacheAndLockOps);
            }
            // For IDs where someone else has the lock, wait and retry fetching from cache
            let retry = 0;
            while (othersLocked.length > 0 && retry < LOCK_MAX_RETRIES) {
                // Wait for other processes to populate cache
                await (0, basic_1.sleep)(LOCK_RETRY_DELAY);
                retry++;
                // Try to fetch from cache again
                const retryResults = await this.redis.run(othersLocked.map((id) => this.redis.hGetAll(this.getCacheKey(entityType, id))));
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
        return completeResults;
    }
    async fetchFromClickhouse(entityType, ids) {
        const metrics = {};
        const batches = (0, basic_1.chunk)(ids, FETCH_BATCH_SIZE);
        for (const batch of batches) {
            const rawMetrics = await this.ch.query `
                SELECT
                    entityId,
                    metricType,
                    sum(metricValue) as value
                FROM entityMetricEvents
                WHERE entityType = ${entityType}
                    AND entityId IN (${batch})
                    AND metricType IN (${metric_types_1.ENTITY_METRIC_TYPES[entityType]})
                GROUP BY entityId, metricType
                HAVING value > 0
            `;
            for (const { entityId, metricType, value } of rawMetrics) {
                metrics[entityId] ?? (metrics[entityId] = {});
                metrics[entityId][metricType] = value;
            }
        }
        return metrics;
    }
    async fetchTimeframes(entityType, ids) {
        var _a;
        if (!ids.length)
            return {};
        const results = {};
        const uniqueIds = [...new Set(ids)];
        const baseMetrics = {};
        for (const metricType of metric_types_1.ENTITY_METRIC_TYPES[entityType])
            baseMetrics[metricType] = 0;
        const batches = (0, basic_1.chunk)(uniqueIds, FETCH_BATCH_SIZE);
        for (const batch of batches) {
            const rawMetrics = await this.ch.query `
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
        return results;
    }
    async bustCache(entityType, ids) {
        ids = Array.isArray(ids) ? ids : [ids];
        if (!ids.length)
            return;
        const uniqueIds = [...new Set(ids)];
        await this.redis.run(uniqueIds.map((id) => this.redis.del(this.getCacheKey(entityType, id))));
    }
}
exports.MetricService = MetricService;
const TIMEFRAMES = ['Day', 'Week', 'Month', 'Year', 'AllTime'];

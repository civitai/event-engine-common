import { EntityType, EntityMetricMap } from '../types/metric-types';
import { IClickhouseClient, IRedisClient } from '../types/package-stubs';
export declare class MetricService {
    private ch;
    private redis;
    constructor(ch: IClickhouseClient, redis: IRedisClient);
    private getCacheKey;
    private getLockKey;
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
    fetch<T extends EntityType>(entityType: T, ids: number[]): Promise<Record<number, EntityMetricMap[T]>>;
    private fetchFromClickhouse;
    fetchTimeframes<T extends EntityType>(entityType: T, ids: number[]): Promise<Record<number, Record<Timeframes, EntityMetricMap[T]>>>;
    bustCache<T extends EntityType>(entityType: T, ids: number | number[]): Promise<void>;
}
declare const TIMEFRAMES: readonly ["Day", "Week", "Month", "Year", "AllTime"];
type Timeframes = typeof TIMEFRAMES[number];
export {};

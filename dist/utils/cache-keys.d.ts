import { EntityType } from '../types/metric-types';
export declare const cacheKeys: {
    metric: (entityType: EntityType, id: number) => string;
    metricLock: (entityType: EntityType, id: number) => string;
};

/**
 * Barrel export for all cache modules
 * Import with: import * as caches from '../caches'
 */

export { userData } from './userData.cache';
export { modelData } from './modelData.cache';

// Export types
export type { UserCacheData } from './userData.cache';
export type { ModelCacheData } from './modelData.cache';
export type { CacheContext, CacheConfig, Cache } from './base';

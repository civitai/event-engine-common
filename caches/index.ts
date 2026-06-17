/**
 * Barrel export for all cache modules
 * Import with: import * as caches from '../caches'
 */

export { userData } from './userData.cache';
export { modelData, modelFullData, modelTagIds } from './modelData.cache';
export {
  tagData,
  cosmeticData,
  userCosmetics,
  profilePictures,
} from './imageData.cache';
// NOTE: fetchImageTagIdsFromDb is intentionally NOT re-exported here. The
// `caches` barrel is consumed via `import * as caches` and indexed by
// `keyof typeof caches` in CacheService.fetch<K> — every member must be a
// cache object ({ fetch, bust, refresh }). A plain function in this namespace
// breaks that constraint. Import it directly from './imageData.cache' instead.

// Export types
export type { UserCacheData } from './userData.cache';
export type { ModelCacheData, ModelTagIdsData } from './modelData.cache';
export type {
  ImageTagIds,
  TagData,
  CosmeticData,
  UserCosmeticData,
  ProfilePictureData,
} from './imageData.cache';
export type { CacheContext, CacheConfig, Cache } from './base';

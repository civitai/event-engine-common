/**
 * Barrel export for all cache modules
 * Import with: import * as caches from '../caches'
 */

export { userData } from './userData.cache';
export { modelData, modelFullData, modelTagIds } from './modelData.cache';
export {
  imageTagIds,
  tagData,
  cosmeticData,
  userCosmetics,
  profilePictures,
} from './imageData.cache';

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

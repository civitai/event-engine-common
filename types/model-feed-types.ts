/**
 * Model Feed Types
 *
 * Types and enums specific to the Model Feed
 * Ported from the main Civitai codebase for use in event-engine-common
 *
 * IMPORTANT: NO `any` types allowed in this file.
 * Use `unknown` with type guards or explicit interfaces for JSON fields.
 */

// ============================================================================
// Enums
// ============================================================================

export enum ModelSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  HighestRated = 'Highest Rated',
  MostLiked = 'Most Liked',
  MostDownloaded = 'Most Downloaded',
  MostDiscussed = 'Most Discussed',
  MostCollected = 'Most Collected',
  ImageCount = 'Most Images',
}

export enum ModelType {
  Checkpoint = 'Checkpoint',
  TextualInversion = 'TextualInversion',
  Hypernetwork = 'Hypernetwork',
  AestheticGradient = 'AestheticGradient',
  LORA = 'LORA',
  Controlnet = 'Controlnet',
  Poses = 'Poses',
  Wildcards = 'Wildcards',
  Other = 'Other',
  LoCon = 'LoCon',
  DoRA = 'DoRA',
  VAE = 'VAE',
  Upscaler = 'Upscaler',
  MotionModule = 'MotionModule',
  Workflows = 'Workflows',
  Detection = 'Detection',
}

export enum ModelStatus {
  Draft = 'Draft',
  Published = 'Published',
  Unpublished = 'Unpublished',
  UnpublishedViolation = 'UnpublishedViolation',
  GatherInterest = 'GatherInterest',
  Scheduled = 'Scheduled',
  Deleted = 'Deleted',
}

export enum CheckpointType {
  Merge = 'Merge',
  Trained = 'Trained',
}

export enum ModelModifier {
  Archived = 'Archived',
  TakenDown = 'TakenDown',
}

export enum Availability {
  Public = 'Public',
  Private = 'Private',
  EarlyAccess = 'EarlyAccess',
  Unsearchable = 'Unsearchable',
}

export enum CommercialUse {
  None = 'None',
  Image = 'Image',
  Rent = 'Rent',
  RentCivit = 'RentCivit',
  Sell = 'Sell',
}

// ============================================================================
// Period / Time Frame Types
// ============================================================================

export type MetricTimeframe = 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime';

// ============================================================================
// Model Version Types
// ============================================================================

/**
 * Model version details as stored in cache
 */
export interface ModelFeedVersionDetails {
  id: number;
  index: number;
  name: string;
  earlyAccessTimeFrame: number;
  baseModel: string;
  baseModelType: string | null;
  createdAt: Date;
  trainingStatus: string | null;
  description: string | null;
  trainedWords: string[];
  vaeId: number | null;
  publishedAt: Date | null;
  status: string;
  covered: boolean;
  availability: string;
  nsfwLevel: number;
}

// ============================================================================
// User Types
// ============================================================================

/**
 * User data from cache
 */
export interface ModelFeedUserData {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
}

/**
 * Profile picture data
 */
export interface ModelFeedProfilePicture {
  id: number;
  name: string | null;
  url: string;
  nsfwLevel: number;
  hash: string | null;
  userId: number;
  ingestion: string;
  type: string;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * User cosmetic data
 */
export interface ModelFeedUserCosmetic {
  cosmeticId: number;
  data: Record<string, unknown> | null;
  cosmetic: {
    id: number;
    name: string;
    type: string;
    source: string;
    data: Record<string, unknown>;
  };
}

// ============================================================================
// Cosmetic Types
// ============================================================================

/**
 * Content decoration cosmetic for models
 */
export interface ModelFeedContentCosmetic {
  id: number;
  type: string;
  name: string;
  data: {
    url?: string;
    offset?: number;
    crop?: string;
    cssFrame?: string;
    glow?: boolean;
    texture?: { url: string; size: { width: number; height: number } };
    lights?: number;
  };
  equippedToId: number;
  claimKey: string | null;
  // userData from UserCosmetic.data (matches legacy output)
  userData: Record<string, unknown> | null;
}

// ============================================================================
// Cache Data Types
// ============================================================================

/**
 * Model data from cache (versions, hashes, tags)
 */
export interface ModelFeedCacheData {
  modelId: number;
  hashes: string[];
  tags: { tagId: number; name: string }[];
  versions: ModelFeedVersionDetails[];
}

// ============================================================================
// Document Types
// ============================================================================

/**
 * Model document as stored in Meilisearch
 */
export interface ModelDocument {
  // Primary
  id: number;

  // Basic fields
  name: string;
  type: string;
  nsfw: boolean;
  // Array of individual NSFW levels (powers of 2: 1, 2, 4, 8, 16) for Meilisearch filtering
  nsfwLevels: number[];
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  locked: boolean;

  // Timestamps
  createdAt: Date;
  lastVersionAt: Date;
  lastVersionAtUnix: number;
  publishedAt: Date | null;
  publishedAtUnix: number | null;
  earlyAccessDeadline: Date | null;
  earlyAccessDeadlineUnix: number | null;

  // Metrics
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
  imageCount: number;

  // User
  userId: number;

  // Filtering arrays
  tagIds: number[];
  baseModels: string[];
  modelVersionIds: number[];

  // Permissions
  allowNoCredit: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  allowCommercialUse: string[];

  // Features
  supportsGeneration: boolean;
  fromPlatform: boolean;

  // Checkpoint-specific
  checkpointType: string | null;
}

// ============================================================================
// Populated Output Types
// ============================================================================

/**
 * User object in populated model
 */
export interface PopulatedModelUser {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
  profilePicture: ModelFeedProfilePicture | null;
  cosmetics: ModelFeedUserCosmetic[];
}

/**
 * Image for model version (matches ImagesForModelVersions from image.service.ts)
 */
export interface ModelVersionImage {
  id: number;
  userId: number;
  name: string;
  url: string;
  nsfwLevel: number;
  width: number;
  height: number;
  hash: string;
  modelVersionId: number;
  type: string;
  metadata: Record<string, unknown> | null;
  tags?: number[];
  availability: string;
  sizeKB?: number;
  onSite: boolean;
  hasMeta: boolean;
  remixOfId?: number | null;
  hasPositivePrompt?: boolean;
  poi?: boolean;
  minor?: boolean;
}

/**
 * Normalized rank object (no period suffix)
 */
export interface ModelRank {
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
}

/**
 * Fully populated model with images (matches getModelsWithImagesAndModelVersions output)
 * This is the primary output type for the model feed
 *
 * Note: This explicitly lists fields to match legacy output exactly.
 * Fields like lastVersionAtUnix, publishedAtUnix are NOT included as they
 * are Meilisearch-specific and not returned by getModelsWithImagesAndModelVersions.
 */
export interface PopulatedModel {
  // Primary
  id: number;

  // Basic fields (from getModelsRaw SQL query)
  name: string;
  type: string;
  nsfw: boolean;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  locked: boolean;

  // Timestamps (Date objects, not Unix timestamps)
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  earlyAccessDeadline: Date | null;

  // userId (also present as user.id, but legacy includes it at root level)
  userId: number;

  // User object
  user: PopulatedModelUser;

  // Model cosmetic (simplified format matching legacy output)
  cosmetic: {
    id: number;
    data: {
      url?: string;
      offset?: number;
      crop?: string;
      cssFrame?: string;
      glow?: boolean;
      texture?: { url: string; size: { width: number; height: number } };
      lights?: number;
    };
    equippedToId: number;
    claimKey: string | null;
    userData: Record<string, unknown> | null;
  } | null;

  // Tags (simplified - just IDs)
  tags: number[];

  // Hashes (lowercase)
  hashes: string[];

  // Normalized rank (no period suffix)
  rank: ModelRank;

  // Single version (first/primary version after filtering)
  version: ModelFeedVersionDetails;

  // Images for the version
  images: ModelVersionImage[];

  // Generation support
  canGenerate: boolean;
}

// ============================================================================
// Query Input Types
// ============================================================================

/**
 * Complete input for querying models
 */
export interface ModelQueryInput {
  // Pagination (handled by Feed context)
  // Note: limit and cursor are added by FeedQueryInput

  // Text search
  query?: string;

  // Sorting
  sort?: ModelSort;
  period?: MetricTimeframe;
  periodMode?: 'stats' | 'published';

  // ID filters
  ids?: number[];
  modelVersionIds?: number[];

  // User filters
  userId?: number;
  username?: string;
  followed?: boolean;
  hidden?: boolean;
  excludedUserIds?: number[];

  // Content filters
  tag?: string;
  tagname?: string;
  tagIds?: number[];
  excludedTagIds?: number[];
  types?: string[];
  baseModels?: string[];
  checkpointType?: string;

  // Status filters
  status?: string[];
  archived?: boolean;
  pending?: boolean;
  availability?: string;
  earlyAccess?: boolean;

  // Permission filters
  allowNoCredit?: boolean;
  allowDifferentLicense?: boolean;
  allowDerivatives?: boolean;
  allowCommercialUse?: string[];

  // Feature filters
  supportsGeneration?: boolean;
  fromPlatform?: boolean;
  needsReview?: boolean;
  isFeatured?: boolean;

  // Collection/Club filters
  collectionId?: number;
  collectionTagId?: number;
  clubId?: number;

  // NSFW/Safety
  browsingLevel?: number;
  disablePoi?: boolean;
  disableMinor?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;

  // File filters
  fileFormats?: string[];

  // NSFW restrictions
  nsfwRestrictedBaseModels?: string[];

  // Session context
  currentUserId?: number;
  isModerator?: boolean;

  // Include options for conditional data fetching
  include?: Array<'details' | 'cosmetics'>;
  includeCosmetics?: boolean;
  includeDetails?: boolean;

  // Existence checking (for post-filter)
  enableExistenceCheck?: boolean;
}

// ============================================================================
// Database Query Result Types
// ============================================================================

/**
 * Base model query result from PostgreSQL
 */
export interface ModelBaseQueryResult {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  locked: boolean;
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  earlyAccessDeadline: Date | null;
  userId: number;
  allowNoCredit: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  allowCommercialUse: string[];
  checkpointType: string | null;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
  imageCount: number;
}

/**
 * Model version aggregated data
 */
export interface ModelVersionAggResult {
  modelId: number;
  versionIds: number[];
  baseModels: string[];
  hasTraining: boolean;
}

/**
 * Generation coverage result
 */
export interface GenerationCoverageResult {
  modelId: number;
  covered: boolean;
}

/**
 * Tag lookup result
 */
export interface TagLookupResult {
  id: number;
}

/**
 * User lookup result
 */
export interface UserLookupResult {
  id: number;
}

/**
 * Followed user result
 */
export interface FollowedUserResult {
  targetUserId: number;
}

/**
 * Hidden model result
 */
export interface HiddenModelResult {
  modelId: number;
}

/**
 * Collection model result
 */
export interface CollectionModelResult {
  modelId: number;
}

/**
 * Featured model result
 */
export interface FeaturedModelResult {
  modelId: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert browsing level flag to array of levels
 */
export function browsingLevelToArray(flag: number): number[] {
  const levels: number[] = [];
  // PG = 1, PG13 = 2, R = 4, X = 8, XXX = 16
  for (const level of [1, 2, 4, 8, 16]) {
    if ((flag & level) !== 0) {
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Get all valid nsfwLevel values that pass bitwise AND check with browsingLevel.
 * This is needed because Meilisearch doesn't support bitwise operations.
 * Documents have composite nsfwLevel values (e.g., 15 = 1+2+4+8), not just single levels.
 * A document is visible if (document.nsfwLevel & browsingLevel) != 0
 */
export function getValidNsfwLevels(browsingLevel: number): number[] {
  const valid: number[] = [];
  // Max possible nsfwLevel is 31 (1+2+4+8+16)
  for (let i = 1; i <= 31; i++) {
    if ((i & browsingLevel) !== 0) {
      valid.push(i);
    }
  }
  return valid;
}

/**
 * Get period in milliseconds
 */
export function getPeriodMs(period: string): number {
  const periodMs: Record<string, number> = {
    Day: 24 * 60 * 60 * 1000,
    Week: 7 * 24 * 60 * 60 * 1000,
    Month: 30 * 24 * 60 * 60 * 1000,
    Year: 365 * 24 * 60 * 60 * 1000,
  };
  return periodMs[period] ?? 0;
}

/**
 * NSFW level flags
 */
export const nsfwBrowsingLevelsFlag = 4 | 8 | 16; // R | X | XXX

/**
 * Check if browsing level includes NSFW content
 */
export function includesNsfwContent(browsingLevel: number): boolean {
  return (browsingLevel & nsfwBrowsingLevelsFlag) !== 0;
}

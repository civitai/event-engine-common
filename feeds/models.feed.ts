import { createFeed } from './base';
import type { FeedContext } from './types';
import type {
  ModelDocument,
  ModelQueryInput,
  PopulatedModel,
  ModelBaseQueryResult,
  ModelFeedVersionDetails,
  ModelFeedCacheData,
  ModelFeedProfilePicture,
  ModelFeedUserCosmetic,
  ModelFeedContentCosmetic,
  PopulatedModelUser,
  TagLookupResult,
  UserLookupResult,
  FollowedUserResult,
  HiddenModelResult,
  CollectionModelResult,
  FeaturedModelResult,
  ModelVersionImage,
  ModelRank,
} from '../types/model-feed-types';
import {
  ModelSort,
  browsingLevelToArray,
  getPeriodMs,
  nsfwBrowsingLevelsFlag,
} from '../types/model-feed-types';
import { chunk } from '../utils/basic';
import {
  NSFW_RESTRICTED_BASE_MODELS,
  FEATURED_MODEL_COLLECTION_ID,
} from '../constants/feed.constants';

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Schema for Model Feed
 * Matches the structure needed for model queries
 */
const schema = {
  // Primary
  id: { type: 'number' as const, primary: true, filterable: true },

  // Basic fields
  name: { type: 'string' as const },
  type: { type: 'string' as const, filterable: true },
  nsfw: { type: 'boolean' as const, filterable: true },
  nsfwLevel: { type: 'number' as const, filterable: true },
  minor: { type: 'boolean' as const, filterable: true },
  poi: { type: 'boolean' as const, filterable: true },
  sfwOnly: { type: 'boolean' as const, filterable: true },
  status: { type: 'string' as const, filterable: true },
  mode: { type: 'string' as const, filterable: true },
  availability: { type: 'string' as const, filterable: true },
  locked: { type: 'boolean' as const, filterable: true },

  // Timestamps
  lastVersionAt: { type: 'Date' as const, sortable: true },
  lastVersionAtUnix: { type: 'number' as const, filterable: true, sortable: true },
  publishedAtUnix: { type: 'number' as const, filterable: true },
  earlyAccessDeadlineUnix: { type: 'number' as const, filterable: true },

  // Metrics - need to be both sortable and filterable for cursor pagination
  downloadCount: { type: 'number' as const, sortable: true, filterable: true },
  thumbsUpCount: { type: 'number' as const, sortable: true, filterable: true },
  thumbsDownCount: { type: 'number' as const, sortable: true, filterable: true },
  commentCount: { type: 'number' as const, sortable: true, filterable: true },
  collectedCount: { type: 'number' as const, sortable: true, filterable: true },
  tippedAmountCount: { type: 'number' as const, sortable: true, filterable: true },
  imageCount: { type: 'number' as const, sortable: true, filterable: true },

  // User
  userId: { type: 'number' as const, filterable: true },

  // Arrays for filtering
  tagIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  baseModels: { type: 'array' as const, arrayType: 'string' as const, filterable: true },
  modelVersionIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },

  // Permissions
  allowNoCredit: { type: 'boolean' as const, filterable: true },
  allowDerivatives: { type: 'boolean' as const, filterable: true },
  allowDifferentLicense: { type: 'boolean' as const, filterable: true },
  allowCommercialUse: { type: 'array' as const, arrayType: 'string' as const, filterable: true },

  // Features
  supportsGeneration: { type: 'boolean' as const, filterable: true },
  fromPlatform: { type: 'boolean' as const, filterable: true },

  // Checkpoint
  checkpointType: { type: 'string' as const, filterable: true },
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build Meilisearch filter string helper
 */
function makeFilter(field: string, operator: string): string {
  return `${field} ${operator}`;
}

/**
 * Quote array of strings for Meilisearch
 */
function strArray(arr: string[]): string {
  return arr.map((s) => `'${s}'`).join(',');
}

// ============================================================================
// createDocuments Implementation
// ============================================================================

/**
 * Partial document for metrics-only updates
 */
type ModelMetricsPartial = Pick<
  ModelDocument,
  | 'id'
  | 'downloadCount'
  | 'thumbsUpCount'
  | 'thumbsDownCount'
  | 'commentCount'
  | 'collectedCount'
  | 'tippedAmountCount'
  | 'imageCount'
>;

/**
 * Version aggregation query result
 */
type VersionAggQueryResult = {
  modelId: number;
  versionIds: number[];
  baseModels: string[];
  hasTraining: boolean;
};

/**
 * Generation coverage query result
 */
type GenerationCoverageQueryResult = {
  modelId: number;
};

/**
 * Create documents for Meilisearch from model IDs
 * Replicates logic from models.search-index.ts and ModelMetric table
 */
async function createDocuments(
  ctx: FeedContext<'Model'>,
  ids: number[],
  type: 'full' | 'metrics' = 'full'
): Promise<ModelDocument[]> {
  // For metrics-only updates, just fetch and update metrics
  if (type === 'metrics') {
    const metricsData = await ctx.metric.fetch(ids);
    const partialDocs: ModelMetricsPartial[] = ids.map((id) => {
      const m = metricsData[id];
      return {
        id,
        downloadCount: m?.downloadCount ?? 0,
        thumbsUpCount: m?.thumbsUpCount ?? 0,
        thumbsDownCount: m?.thumbsDownCount ?? 0,
        commentCount: m?.commentCount ?? 0,
        collectedCount: m?.collectedCount ?? 0,
        tippedAmountCount: m?.tippedAmount ?? 0,
        imageCount: m?.imageCount ?? 0,
      };
    });
    // Cast is acceptable here as Meilisearch partial update
    return partialDocs as ModelDocument[];
  }

  // Full document creation
  const batches = chunk(ids, 1000);
  const allDocs: ModelDocument[] = [];

  for (const batch of batches) {
    // Step 1: Fetch base model data from PostgreSQL via ModelMetric
    const models = await ctx.pg.query<ModelBaseQueryResult>(`
      SELECT
        mm."modelId" as id,
        m.name,
        m.type,
        m.nsfw,
        mm."nsfwLevel",
        mm.minor,
        mm.poi,
        m."sfwOnly",
        mm.status,
        mm.mode,
        mm.availability,
        m.locked,
        m."createdAt",
        mm."lastVersionAt",
        m."publishedAt",
        m."earlyAccessDeadline",
        mm."userId",
        m."allowNoCredit",
        m."allowDerivatives",
        m."allowDifferentLicense",
        m."allowCommercialUse",
        m."checkpointType",
        mm."downloadCount",
        mm."thumbsUpCount",
        mm."thumbsDownCount",
        mm."commentCount",
        mm."collectedCount",
        mm."tippedAmountCount",
        mm."imageCount"
      FROM "ModelMetric" mm
      JOIN "Model" m ON m.id = mm."modelId"
      WHERE mm."modelId" = ANY($1)
    `, [batch]);

    if (models.length === 0) continue;

    const modelIds = models.map((m) => m.id);

    // Step 2: Fetch tag IDs from cache
    const tagData = await ctx.cache.fetch('modelTagIds', modelIds);

    // Step 3: Fetch version aggregation data
    const versionAgg = await ctx.pg.query<VersionAggQueryResult>(`
      SELECT
        mv."modelId",
        array_agg(mv.id) as "versionIds",
        array_agg(DISTINCT mv."baseModel") FILTER (WHERE mv."baseModel" IS NOT NULL) as "baseModels",
        bool_or(mv."trainingStatus" IS NOT NULL) as "hasTraining"
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ANY($1)
        AND mv.status = 'Published'
      GROUP BY mv."modelId"
    `, [modelIds]);

    const versionDataMap = versionAgg.reduce((acc, v) => {
      acc[v.modelId] = v;
      return acc;
    }, {} as Record<number, VersionAggQueryResult>);

    // Step 4: Fetch generation coverage
    const genCoverage = await ctx.pg.query<GenerationCoverageQueryResult>(`
      SELECT DISTINCT mv."modelId"
      FROM "GenerationCoverage" gc
      JOIN "ModelVersion" mv ON mv.id = gc."modelVersionId"
      WHERE mv."modelId" = ANY($1) AND gc.covered = true
    `, [modelIds]);

    const genCoverageSet = new Set(genCoverage.map((g) => g.modelId));

    // Step 5: Transform to documents
    const docs: ModelDocument[] = models.map((model) => {
      const vData = versionDataMap[model.id];
      const tags = tagData[model.id]?.tags ?? [];

      return {
        // Primary
        id: model.id,

        // Basic fields
        name: model.name,
        type: model.type,
        nsfw: model.nsfw,
        nsfwLevel: model.nsfwLevel,
        minor: model.minor,
        poi: model.poi,
        sfwOnly: model.sfwOnly,
        status: model.status,
        mode: model.mode,
        availability: model.availability,
        locked: model.locked,

        // Timestamps
        createdAt: model.createdAt,
        lastVersionAt: model.lastVersionAt,
        lastVersionAtUnix: model.lastVersionAt?.getTime() ?? 0,
        publishedAt: model.publishedAt,
        publishedAtUnix: model.publishedAt?.getTime() ?? null,
        earlyAccessDeadline: model.earlyAccessDeadline,
        earlyAccessDeadlineUnix: model.earlyAccessDeadline?.getTime() ?? null,

        // Metrics
        downloadCount: model.downloadCount,
        thumbsUpCount: model.thumbsUpCount,
        thumbsDownCount: model.thumbsDownCount,
        commentCount: model.commentCount,
        collectedCount: model.collectedCount,
        tippedAmountCount: model.tippedAmountCount,
        imageCount: model.imageCount,

        // User
        userId: model.userId,

        // Arrays
        tagIds: tags,
        baseModels: vData?.baseModels ?? [],
        modelVersionIds: vData?.versionIds ?? [],

        // Permissions
        allowNoCredit: model.allowNoCredit,
        allowDerivatives: model.allowDerivatives,
        allowDifferentLicense: model.allowDifferentLicense,
        allowCommercialUse: model.allowCommercialUse,

        // Features
        supportsGeneration: genCoverageSet.has(model.id),
        fromPlatform: vData?.hasTraining ?? false,

        // Checkpoint
        checkpointType: model.checkpointType,
      };
    });

    allDocs.push(...docs);
  }

  return allDocs;
}

// ============================================================================
// queryDocuments Implementation
// ============================================================================

/**
 * Query documents from Meilisearch
 * Replicates filter logic from getModelsRaw
 */
async function queryDocuments(
  ctx: FeedContext<'Model'>,
  input: ModelQueryInput
): Promise<ModelDocument[]> {
  console.log('[ModelFeed:queryDocuments] Starting query with input:', {
    sort: input.sort,
    userId: input.userId,
    browsingLevel: input.browsingLevel,
    currentUserId: input.currentUserId,
    isModerator: input.isModerator,
    limit: ctx.pagination.limit,
  });
  const queryStart = Date.now();

  try {
    const {
      query,
      sort = ModelSort.Newest,
      period,
      periodMode,
      types,
      baseModels,
      checkpointType,
      status,
      archived,
      availability,
      earlyAccess,
      allowNoCredit,
      allowDifferentLicense,
      allowDerivatives,
      allowCommercialUse,
      supportsGeneration,
      fromPlatform,
      isFeatured,
      collectionId,
      collectionTagId,
      disablePoi,
      disableMinor,
      poiOnly,
      minorOnly,
      excludedTagIds,
      excludedUserIds,
      isModerator,
      currentUserId,
    } = input;
    let { browsingLevel, userId, tagIds = [], ids = [] } = input;

    const sorts: string[] = [];
    const filters: string[] = [];

    // ========================================================================
    // Step 1: Pre-query database lookups
    // ========================================================================

    // Handle tag name to ID lookup
    if (input.tag || input.tagname) {
      const tagResult = await ctx.pg.query<TagLookupResult>(
        `SELECT id FROM "Tag" WHERE name = $1`,
        [input.tag ?? input.tagname]
      );
      if (tagResult.length) {
        tagIds = [...tagIds, tagResult[0].id];
      }
    }

    // Handle username to userId lookup
    if (input.username && !userId) {
      const userResult = await ctx.pg.query<UserLookupResult>(
        `SELECT id FROM "User" WHERE username = $1`,
        [input.username]
      );
      if (userResult.length === 0) {
        console.log('[ModelFeed:queryDocuments] User not found, returning empty');
        return [];
      }
      userId = userResult[0].id;
    }

    // Handle followed users filter
    if (input.followed && currentUserId) {
      const followed = await ctx.pg.query<FollowedUserResult>(
        `SELECT "targetUserId" FROM "UserEngagement"
         WHERE "userId" = $1 AND type = 'Follow'`,
        [currentUserId]
      );
      if (followed.length === 0) {
        console.log('[ModelFeed:queryDocuments] No followed users, returning empty');
        return [];
      }
      const followedUserIds = followed.map((f) => f.targetUserId);
      filters.push(makeFilter('userId', `IN [${followedUserIds.join(',')}]`));
    }

    // Handle hidden models filter
    if (input.hidden && currentUserId) {
      const hidden = await ctx.pg.query<HiddenModelResult>(
        `SELECT "modelId" FROM "ModelEngagement"
         WHERE "userId" = $1 AND type = 'Hide'`,
        [currentUserId]
      );
      if (hidden.length === 0) {
        console.log('[ModelFeed:queryDocuments] No hidden models, returning empty');
        return [];
      }
      const hiddenModelIds = hidden.map((h) => h.modelId);
      filters.push(makeFilter('id', `IN [${hiddenModelIds.join(',')}]`));
    }

    // Handle collection filtering
    if (collectionId) {
      const collectionModels = await ctx.pg.query<CollectionModelResult>(
        `SELECT "modelId" FROM "CollectionItem"
         WHERE "collectionId" = $1 AND "modelId" IS NOT NULL
         ${collectionTagId ? `AND "tagId" = ${collectionTagId}` : ''}`,
        [collectionId]
      );
      if (collectionModels.length === 0) {
        console.log('[ModelFeed:queryDocuments] No models in collection, returning empty');
        return [];
      }
      const collectionModelIds = collectionModels.map((c) => c.modelId);
      filters.push(makeFilter('id', `IN [${collectionModelIds.join(',')}]`));
    }

    // Handle featured models
    if (isFeatured) {
      const featured = await ctx.pg.query<FeaturedModelResult>(
        `SELECT "modelId" FROM "CollectionItem"
         WHERE "collectionId" = $1 AND "modelId" IS NOT NULL`,
        [FEATURED_MODEL_COLLECTION_ID]
      );
      if (featured.length === 0) {
        console.log('[ModelFeed:queryDocuments] No featured models, returning empty');
        return [];
      }
      const featuredModelIds = featured.map((f) => f.modelId);
      filters.push(makeFilter('id', `IN [${featuredModelIds.join(',')}]`));
    }

    // ========================================================================
    // Step 2: Build Meilisearch filters
    // ========================================================================

    // NSFW Level filtering
    if (browsingLevel) {
      const levels = browsingLevelToArray(browsingLevel);
      filters.push(makeFilter('nsfwLevel', `IN [${levels.join(',')}]`));
    }

    // POI/Minor filtering
    if (disablePoi) {
      filters.push(makeFilter('poi', '!= true'));
    }
    if (disableMinor) {
      filters.push(makeFilter('minor', '!= true'));
    }

    // Moderator-only filters
    if (isModerator) {
      if (poiOnly) {
        filters.push(makeFilter('poi', '= true'));
      }
      if (minorOnly) {
        filters.push(makeFilter('minor', '= true'));
      }
    }

    // Status filtering (default: Published for non-moderators)
    if (!isModerator || !status?.length) {
      filters.push(makeFilter('status', `= 'Published'`));
    } else if (status.length) {
      filters.push(makeFilter('status', `IN [${strArray(status)}]`));
    }

    // Availability filtering
    if (availability) {
      filters.push(makeFilter('availability', `= '${availability}'`));
    } else if (!isModerator) {
      filters.push(makeFilter('availability', `!= 'Private'`));
    }

    // Archived filtering
    if (!archived) {
      filters.push(makeFilter('mode', `!= 'Archived'`));
    }

    // Type filtering
    if (types?.length) {
      filters.push(makeFilter('type', `IN [${strArray(types)}]`));
    }

    // Base model filtering
    if (baseModels?.length) {
      filters.push(makeFilter('baseModels', `IN [${strArray(baseModels)}]`));
    }

    // Checkpoint type filtering
    if (checkpointType) {
      filters.push(makeFilter('checkpointType', `= '${checkpointType}'`));
    }

    // Tag filtering
    if (tagIds.length) {
      filters.push(makeFilter('tagIds', `IN [${tagIds.join(',')}]`));
    }
    if (excludedTagIds?.length) {
      filters.push(makeFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
    }

    // User filtering
    if (userId) {
      filters.push(makeFilter('userId', `= ${userId}`));
    } else if (excludedUserIds?.length) {
      filters.push(makeFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));
    }

    // ID filtering
    if (ids.length) {
      filters.push(makeFilter('id', `IN [${ids.join(',')}]`));
    }
    if (input.modelVersionIds?.length) {
      filters.push(makeFilter('modelVersionIds', `IN [${input.modelVersionIds.join(',')}]`));
    }

    // Permission filters
    if (allowNoCredit !== undefined) {
      filters.push(makeFilter('allowNoCredit', `= ${allowNoCredit}`));
    }
    if (allowDerivatives !== undefined) {
      filters.push(makeFilter('allowDerivatives', `= ${allowDerivatives}`));
    }
    if (allowDifferentLicense !== undefined) {
      filters.push(makeFilter('allowDifferentLicense', `= ${allowDifferentLicense}`));
    }
    if (allowCommercialUse?.length) {
      filters.push(makeFilter('allowCommercialUse', `IN [${strArray(allowCommercialUse)}]`));
    }

    // Feature filters
    if (supportsGeneration) {
      filters.push(makeFilter('supportsGeneration', '= true'));
    }
    if (fromPlatform) {
      filters.push(makeFilter('fromPlatform', '= true'));
    }

    // Early access filtering
    if (earlyAccess) {
      const now = Date.now();
      filters.push(makeFilter('earlyAccessDeadlineUnix', `>= ${now}`));
    }

    // Period filtering (for published date mode)
    if (period && period !== 'AllTime' && periodMode !== 'stats') {
      const periodMs = getPeriodMs(period);
      const afterDate = Date.now() - periodMs;
      filters.push(makeFilter('lastVersionAtUnix', `>= ${afterDate}`));
    }

    // ========================================================================
    // Step 3: Build sort order
    // ========================================================================

    if (sort === ModelSort.HighestRated || sort === ModelSort.MostLiked) {
      sorts.push('thumbsUpCount:desc', 'downloadCount:desc');
    } else if (sort === ModelSort.MostDownloaded) {
      sorts.push('downloadCount:desc', 'thumbsUpCount:desc');
    } else if (sort === ModelSort.MostDiscussed) {
      sorts.push('commentCount:desc', 'thumbsUpCount:desc');
    } else if (sort === ModelSort.MostCollected) {
      sorts.push('collectedCount:desc', 'thumbsUpCount:desc');
    } else if (sort === ModelSort.ImageCount) {
      sorts.push('imageCount:desc', 'thumbsUpCount:desc');
    } else if (sort === ModelSort.Oldest) {
      sorts.push('lastVersionAtUnix:asc');
    } else {
      // Newest (default)
      sorts.push('lastVersionAtUnix:desc');
    }
    sorts.push('id:desc'); // Secondary sort for consistency

    // ========================================================================
    // Step 4: Execute search
    // ========================================================================

    const { limit, offset = 0 } = ctx.pagination;
    const finalFilter = filters.length ? filters.join(' AND ') : undefined;

    console.log('[ModelFeed:queryDocuments] Final search params:', {
      query,
      filterCount: filters.length,
      sorts,
      limit: limit + 1,
      offset,
    });

    const searchStart = Date.now();
    const result = await ctx.index.search<ModelDocument>(query ?? null, {
      filter: finalFilter,
      sort: sorts,
      limit: limit + 1, // Get one extra to determine if there's a next page
      offset,
    });

    console.log(`[ModelFeed:queryDocuments] Search completed in ${Date.now() - searchStart}ms, returned ${result.hits.length} hits`);
    console.log(`[ModelFeed:queryDocuments] Total query time: ${Date.now() - queryStart}ms`);

    return result.hits;

  } catch (error) {
    console.error('[ModelFeed:queryDocuments] ERROR:', error);
    throw error;
  }
}

// ============================================================================
// populateDocuments Implementation
// ============================================================================

/**
 * Cosmetic query result from UserCosmetic table
 */
type CosmeticQueryResult = {
  equippedToId: number;
  cosmeticId: number;
  claimKey: string | null;
  userData: Record<string, unknown> | null;
};

/**
 * Cosmetic data from cache
 */
type CosmeticCacheData = {
  id: number;
  name: string;
  type: string;
  source: string;
  data: Record<string, unknown>;
};

/**
 * Helper: Fetch model cosmetics
 */
async function fetchModelCosmetics(
  ctx: FeedContext<'Model'>,
  modelIds: number[]
): Promise<Record<number, ModelFeedContentCosmetic>> {
  if (modelIds.length === 0) return {};

  const results = await ctx.pg.query<CosmeticQueryResult>(
    `SELECT "equippedToId", "cosmeticId", "claimKey", data as "userData"
     FROM "UserCosmetic"
     WHERE "equippedToId" = ANY($1) AND "equippedToType" = 'Model'::"CosmeticEntity"`,
    [modelIds]
  );

  if (results.length === 0) return {};

  const cosmeticIds = results.map((r) => r.cosmeticId);
  const cosmeticsData = await ctx.cache.fetch('cosmeticData', cosmeticIds);

  const mapped: Record<number, ModelFeedContentCosmetic> = {};
  for (const row of results) {
    const cosmetic = cosmeticsData[row.cosmeticId] as CosmeticCacheData | undefined;
    if (cosmetic) {
      // Merge userData.lights into data.lights (matching appendFn behavior)
      const data = { ...cosmetic.data } as ModelFeedContentCosmetic['data'];
      if (row.userData && typeof row.userData === 'object' && 'lights' in row.userData) {
        data.lights = (row.userData as { lights?: number }).lights;
      }

      mapped[row.equippedToId] = {
        id: cosmetic.id,
        type: cosmetic.type,
        name: cosmetic.name,
        data,
        equippedToId: row.equippedToId,
        claimKey: row.claimKey,
        // Include userData to match legacy output
        userData: row.userData,
      };
    }
  }
  return mapped;
}

/**
 * Cached images data format for model versions
 * Matches CachedImagesForModelVersions from image.service.ts
 */
type CachedImagesForModelVersions = {
  modelVersionId: number;
  images: ModelVersionImage[];
  cachedAt?: Date;
  notFound?: boolean;
  debounce?: boolean;
};

/**
 * Image data from cache for model versions (indexed by version ID)
 */
type ModelVersionImagesCache = Record<number, {
  modelVersionId: number;
  images: ModelVersionImage[];
}>;

/**
 * Populate documents with additional data
 * Replicates the logic from getModelsWithImagesAndModelVersions
 */
async function populateDocuments(
  ctx: FeedContext<'Model'>,
  documents: ModelDocument[],
  input: ModelQueryInput
): Promise<PopulatedModel[]> {
  console.log('[ModelFeed:populateDocuments] Starting with', documents.length, 'documents');

  if (documents.length === 0) return [];

  const { currentUserId, isModerator, period = 'AllTime' } = input;
  // Always include cosmetics for getModelsWithImagesAndModelVersions compatibility
  const includeCosmetics = input.includeCosmetics ?? true;

  const modelIds = documents.map((d) => d.id);
  const userIds = [...new Set(documents.map((d) => d.userId))];

  // ========================================================================
  // Step 1: Fetch all required data in parallel
  // ========================================================================

  console.log('[ModelFeed:populateDocuments] Fetching data for', modelIds.length, 'models,', userIds.length, 'users');

  // Type aliases for cache results
  type ModelFullDataResult = Awaited<ReturnType<typeof ctx.cache.fetch<'modelFullData'>>>;
  type UserDataResult = Awaited<ReturnType<typeof ctx.cache.fetch<'userData'>>>;
  type UserCosmeticsResult = Awaited<ReturnType<typeof ctx.cache.fetch<'userCosmetics'>>>;
  type CosmeticDataResult = Awaited<ReturnType<typeof ctx.cache.fetch<'cosmeticData'>>>;
  type ModelCosmeticsResult = Record<number, ModelFeedContentCosmetic>;

  // Empty objects for conditional fetches
  const emptyUserCosmetics: UserCosmeticsResult = {};
  const emptyModelCosmetics: ModelCosmeticsResult = {};

  // Profile pictures are stored in packed cache (matches main codebase)
  const PROFILE_PICTURES_CACHE_KEY = 'packed:caches:profile-pictures';

  const [
    modelData,
    usersData,
    profilePicturesRaw,
    userCosmetics,
    modelCosmetics,
  ]: [
    ModelFullDataResult,
    UserDataResult,
    (ModelFeedProfilePicture | null)[],
    UserCosmeticsResult,
    ModelCosmeticsResult,
  ] = await Promise.all([
    ctx.cache.fetch('modelFullData', modelIds),
    ctx.cache.fetch('userData', userIds),
    // Read profile pictures from packed cache (same cache main codebase uses)
    ctx.cache.mGet<ModelFeedProfilePicture>(userIds.map((id) => `${PROFILE_PICTURES_CACHE_KEY}:${id}`)),
    includeCosmetics
      ? ctx.cache.fetch('userCosmetics', userIds)
      : Promise.resolve(emptyUserCosmetics),
    includeCosmetics
      ? fetchModelCosmetics(ctx, modelIds)
      : Promise.resolve(emptyModelCosmetics),
  ]);

  // Build profile pictures map from raw results (strip cachedAt - internal cache field)
  const profilePictures: Record<number, ModelFeedProfilePicture> = {};
  for (let i = 0; i < userIds.length; i++) {
    const pic = profilePicturesRaw[i];
    if (pic) {
      const { cachedAt, ...profilePicture } = pic as ModelFeedProfilePicture & { cachedAt?: unknown };
      profilePictures[userIds[i]] = profilePicture;
    }
  }

  // Fetch cosmetic details for user cosmetics
  const cosmeticIds = [...new Set(
    Object.values(userCosmetics).flatMap((uc) =>
      Array.isArray(uc?.cosmetics) ? uc.cosmetics.map((c: { cosmeticId: number }) => c.cosmeticId) : []
    )
  )];
  const cosmeticsData: CosmeticDataResult = cosmeticIds.length > 0
    ? await ctx.cache.fetch('cosmeticData', cosmeticIds)
    : {};

  // ========================================================================
  // Step 2: Filter versions and collect version IDs for image fetching
  // ========================================================================

  console.log('[ModelFeed:populateDocuments] Filtering versions...');

  const nsfwRestrictedBaseModels = input.nsfwRestrictedBaseModels ?? NSFW_RESTRICTED_BASE_MODELS;

  // First pass: filter versions and collect version IDs
  type FilteredModelData = {
    doc: ModelDocument;
    data: ModelFeedCacheData;
    version: ModelFeedVersionDetails;
  };

  const filteredModels: FilteredModelData[] = [];

  for (const doc of documents) {
    const data = modelData[doc.id] as ModelFeedCacheData | undefined;
    if (!data) continue;

    // Skip TakenDown models
    if (doc.mode === 'TakenDown') continue;

    // Filter versions
    let versions = data.versions;

    // Only published versions for non-moderators
    if (!isModerator || !input.status?.length) {
      versions = versions.filter((v) => v.status === 'Published');
    }

    // Base model filter
    if (input.baseModels?.length) {
      versions = versions.filter((v) => input.baseModels!.includes(v.baseModel));
    }

    // Model version ID filter
    if (input.modelVersionIds?.length) {
      versions = versions.filter((v) => input.modelVersionIds!.includes(v.id));
    }

    // NSFW license restrictions - filter versions with restricted base models
    if (nsfwRestrictedBaseModels.length > 0) {
      const restrictedSet = new Set<string>(nsfwRestrictedBaseModels);
      versions = versions.filter((v) =>
        !((v.nsfwLevel & nsfwBrowsingLevelsFlag) !== 0 &&
          restrictedSet.has(v.baseModel))
      );
    }

    // Hide private versions for non-owners
    if (currentUserId !== doc.userId && !isModerator) {
      versions = versions.filter(
        (v) => v.availability === 'Public' || v.availability === 'EarlyAccess'
      );
    }

    // Skip if no versions after filtering
    if (versions.length === 0) continue;

    // Get the first (primary) version
    const version = versions[0];

    // Excluded tags check
    if (input.excludedTagIds?.length) {
      const hasExcluded = data.tags.some((t) => input.excludedTagIds!.includes(t.tagId));
      if (hasExcluded) continue;
    }

    filteredModels.push({ doc, data, version });
  }

  console.log('[ModelFeed:populateDocuments] Filtered to', filteredModels.length, 'models with valid versions');

  // ========================================================================
  // Step 3: Fetch images for model versions
  // ========================================================================

  const versionIds = filteredModels.map((m) => m.version.id);

  // Fetch images using the existing Redis cache (matches imagesForModelVersionsCache)
  // Key format: packed:caches:images-for-model-version-2:{versionId}
  // NOTE: The cached data does NOT include tags - tags are added by appendFn AFTER caching
  // So we need to fetch tags separately, just like getImagesForModelVersionCache does
  const IMAGES_CACHE_KEY = 'packed:caches:images-for-model-version-2';
  let modelVersionImages: ModelVersionImagesCache = {};
  if (versionIds.length > 0) {
    const cacheKeys = versionIds.map((id) => `${IMAGES_CACHE_KEY}:${id}`);
    const imagesResult = await ctx.cache.mGet<CachedImagesForModelVersions>(cacheKeys);

    for (let i = 0; i < versionIds.length; i++) {
      const versionId = versionIds[i];
      const cachedData = imagesResult[i];
      if (cachedData && cachedData.images) {
        modelVersionImages[versionId] = cachedData;
      }
    }

    // Fetch tags for all images (tags are stored separately, not in the image cache)
    // Key format: packed:caches:tag-ids-for-images:{imageId}
    const TAG_IDS_CACHE_KEY = 'packed:caches:tag-ids-for-images';
    const allImageIds = Object.values(modelVersionImages).flatMap((v) => v.images.map((i) => i.id));
    if (allImageIds.length > 0) {
      const tagCacheKeys = allImageIds.map((id) => `${TAG_IDS_CACHE_KEY}:${id}`);
      const tagResults = await ctx.cache.mGet<{ imageId: number; tags: number[] }>(tagCacheKeys);

      // Build a map of imageId -> tags
      const imageTags: Record<number, number[]> = {};
      for (let i = 0; i < allImageIds.length; i++) {
        const tagData = tagResults[i];
        if (tagData && tagData.tags) {
          imageTags[allImageIds[i]] = tagData.tags;
        }
      }

      // Add tags to each image
      for (const versionData of Object.values(modelVersionImages)) {
        for (const image of versionData.images) {
          image.tags = imageTags[image.id] ?? [];
        }
      }
    }
  }

  // ========================================================================
  // Step 4: Get unavailable generation resources from Redis
  // ========================================================================

  // Fetch unavailable resources from Redis (matches getUnavailableResources)
  const unavailableResourcesRaw = await ctx.cache.mGet<number[]>(['system:features:generation:unavailable-resources']);
  const unavailableResources = unavailableResourcesRaw[0] ?? [];
  const unavailableSet = new Set(unavailableResources);

  // ========================================================================
  // Step 5: Transform to output format
  // ========================================================================

  console.log('[ModelFeed:populateDocuments] Building populated models...');

  const populated: PopulatedModel[] = [];

  for (const { doc, data, version } of filteredModels) {
    // Get images for this version
    const versionImages = modelVersionImages[version.id]?.images ?? [];

    // Filter images by excluded tags if needed
    const filteredImages = input.excludedTagIds
      ? versionImages.filter(
          (img) => !img.tags || img.tags.every((id) => !input.excludedTagIds!.includes(id))
        )
      : versionImages;

    // Skip models with no images (unless owner/moderator and looking at own/specific models)
    const showImageless =
      (isModerator || doc.userId === currentUserId) &&
      (input.userId || input.username || input.status?.includes('Draft'));
    if (filteredImages.length === 0 && !showImageless) continue;

    // Determine if generation is available
    const canGenerate = version.covered === true && !unavailableSet.has(version.id);

    // Build normalized rank (no period suffix)
    const rank: ModelRank = {
      downloadCount: doc.downloadCount,
      thumbsUpCount: doc.thumbsUpCount,
      thumbsDownCount: doc.thumbsDownCount,
      commentCount: doc.commentCount,
      collectedCount: doc.collectedCount,
      tippedAmountCount: doc.tippedAmountCount,
    };

    // Build user object
    const userCacheData = usersData[doc.userId];
    const userCosmeticData = userCosmetics[doc.userId];
    const userCosmeticsArray: ModelFeedUserCosmetic[] = userCosmeticData && Array.isArray(userCosmeticData.cosmetics)
      ? userCosmeticData.cosmetics.map((uc: { cosmeticId: number; data: Record<string, unknown> | null }) => {
          const cosmetic = cosmeticsData[uc.cosmeticId] as CosmeticCacheData | undefined;
          if (!cosmetic) return null;
          return {
            cosmeticId: uc.cosmeticId,
            data: uc.data,
            cosmetic: {
              id: cosmetic.id,
              name: cosmetic.name,
              type: cosmetic.type,
              source: cosmetic.source,
              data: cosmetic.data,
            },
          };
        }).filter((c): c is ModelFeedUserCosmetic => c !== null)
      : [];

    // Get profile picture directly from packed cache (already has all fields)
    const profilePicture = profilePictures[doc.userId] ?? null;

    // Helper to convert string "null" to actual null (cache serialization issue)
    const normalizeNull = <T>(value: T | "null" | undefined): T | null => {
      if (value === "null" || value === undefined) return null;
      return value as T;
    };

    const user: PopulatedModelUser = {
      id: doc.userId,
      username: normalizeNull(userCacheData?.username),
      deletedAt: normalizeNull(userCacheData?.deletedAt),
      image: normalizeNull(userCacheData?.image),
      profilePicture,
      cosmetics: userCosmeticsArray,
    };

    // Get the model cosmetic and format it to match legacy
    const rawCosmetic = modelCosmetics[doc.id];
    const cosmetic = rawCosmetic ? {
      id: rawCosmetic.id,
      data: rawCosmetic.data,
      equippedToId: rawCosmetic.equippedToId,
      claimKey: rawCosmetic.claimKey,
      userData: rawCosmetic.userData,
    } : null;

    // Build the populated model (matching getModelsWithImagesAndModelVersions output exactly)
    // Only include fields that legacy returns - no Meilisearch-specific fields
    populated.push({
      // Primary
      id: doc.id,

      // Basic fields
      name: doc.name,
      type: doc.type,
      nsfw: doc.nsfw,
      nsfwLevel: doc.nsfwLevel,
      minor: doc.minor,
      poi: doc.poi,
      sfwOnly: doc.sfwOnly,
      status: doc.status,
      mode: doc.mode,
      availability: doc.availability,
      locked: doc.locked,

      // Timestamps (Date objects)
      createdAt: doc.createdAt,
      lastVersionAt: doc.lastVersionAt,
      publishedAt: doc.publishedAt,
      earlyAccessDeadline: doc.earlyAccessDeadline,

      // userId at root level (matches legacy output)
      userId: doc.userId,

      // Populated fields
      user,
      cosmetic,
      tags: data.tags.map((t) => t.tagId),
      hashes: data.hashes.map((h) => h.toLowerCase()),
      rank,
      // Normalize version dates (pg returns strings, Prisma returns Date objects)
      version: {
        ...version,
        createdAt: version.createdAt instanceof Date ? version.createdAt : new Date(version.createdAt),
        publishedAt: version.publishedAt ? (version.publishedAt instanceof Date ? version.publishedAt : new Date(version.publishedAt)) : null,
      },
      images: filteredImages,
      canGenerate,
    });
  }

  console.log('[ModelFeed:populateDocuments] Completed, returning', populated.length, 'populated models');
  return populated;
}

// ============================================================================
// Export Feed
// ============================================================================

export const ModelsFeed = createFeed({
  entityType: 'Model' as const,
  name: 'metrics_models_v1',
  connection: {
    host: process.env.FEED_MODEL_HOST,
    apiKey: process.env.FEED_MODEL_API_KEY,
  },
  schema,
  createDocuments,
  queryDocuments,
  populateDocuments,
  getCursor: (doc) => String(doc.lastVersionAtUnix ?? doc.id),
});

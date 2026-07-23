import { createCache, CacheContext } from './base';
import type { ModelFeedVersionDetails, ModelFeedCacheData } from '../types/model-feed-types';

// ============================================================================
// Basic Model Data Cache (existing)
// ============================================================================

export type ModelCacheData = {
  modelId: number;
  name: string;
  type: string;
  nsfw: boolean;
  userId: number;
};

/**
 * Cache for basic model metadata
 * Used for simple model lookups
 */
export const modelData = createCache<ModelCacheData>({
  redisKey: 'model:data',
  idKey: 'modelId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const models = await pg.query<ModelCacheData>(
      `SELECT
        id as "modelId",
        name,
        type,
        nsfw,
        "userId"
       FROM "Model"
       WHERE id = ANY($1)`,
      [ids]
    );
    return models;
  },
  ttl: 60 * 60 * 24, // 24 hours
});

// ============================================================================
// Full Model Data Cache (for feed)
// ============================================================================

/**
 * Version details from database query
 */
type VersionQueryResult = ModelFeedVersionDetails & { modelId: number };

/**
 * Hash query result
 */
type HashQueryResult = {
  modelId: number;
  hash: string;
};

/**
 * Tag query result
 */
type TagQueryResult = {
  modelId: number;
  tagId: number;
  name: string;
};

/**
 * Cache for full model data including versions, hashes, and tags
 * Used by the model feed for populating documents
 */
export const modelFullData = createCache<ModelFeedCacheData>({
  redisKey: 'model:full-data',
  idKey: 'modelId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    // Fetch versions
    const versions = await pg.query<VersionQueryResult>(
      `SELECT
        mv."id",
        mv.index,
        mv."modelId",
        mv."name",
        mv."earlyAccessTimeFrame",
        mv."baseModel",
        mv."baseModelType",
        mv."createdAt",
        mv."trainingStatus",
        mv."publishedAt",
        mv."status",
        mv."flags",
        mv.availability,
        mv."nsfwLevel",
        mv."description",
        mv."trainedWords",
        (SELECT rr."resourceId" FROM "RecommendedResource" rr
         WHERE rr."sourceId" = mv.id
           AND rr.settings->>'isLinkedComponent' = 'true'
           AND rr.settings->>'componentType' = 'VAE'
         LIMIT 1) AS "vaeId",
        COALESCE((
          SELECT gc.covered
          FROM "GenerationCoverage" gc
          WHERE gc."modelVersionId" = mv.id
        ), false) AS covered
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ANY($1)
      ORDER BY mv."modelId", mv.index`,
      [ids]
    );

    // Fetch hashes
    const hashes = await pg.query<HashQueryResult>(
      `SELECT "modelId", hash
       FROM "ModelHash"
       WHERE
         "modelId" = ANY($1)
         AND "hashType" = 'SHA256'
         AND "fileType" IN ('Model', 'Pruned Model')`,
      [ids]
    );

    // Fetch tags
    const tags = await pg.query<TagQueryResult>(
      `SELECT tom."modelId", tom."tagId", t.name
       FROM "TagsOnModels" tom
       JOIN "Tag" t ON t.id = tom."tagId"
       WHERE tom."modelId" = ANY($1)`,
      [ids]
    );

    // Build results record
    const results: ModelFeedCacheData[] = [];

    // Group versions by model
    const versionsByModel = versions.reduce((acc, { modelId, ...version }) => {
      acc[modelId] ??= [];
      acc[modelId].push(version);
      return acc;
    }, {} as Record<number, ModelFeedVersionDetails[]>);

    // Group hashes by model
    const hashesByModel = hashes.reduce((acc, { modelId, hash }) => {
      acc[modelId] ??= [];
      acc[modelId].push(hash);
      return acc;
    }, {} as Record<number, string[]>);

    // Group tags by model
    const tagsByModel = tags.reduce((acc, { modelId, tagId, name }) => {
      acc[modelId] ??= [];
      acc[modelId].push({ tagId, name });
      return acc;
    }, {} as Record<number, { tagId: number; name: string }[]>);

    // Build cache data for each model
    for (const modelId of ids) {
      results.push({
        modelId,
        versions: versionsByModel[modelId] ?? [],
        hashes: hashesByModel[modelId] ?? [],
        tags: tagsByModel[modelId] ?? [],
      });
    }

    return results;
  },
  ttl: 60 * 60 * 24, // 24 hours
});

// ============================================================================
// Model Tag IDs Cache
// ============================================================================

export type ModelTagIdsData = {
  modelId: number;
  tags: number[];
};

/**
 * Cache for model tag IDs only (lightweight)
 * Used for filtering in createDocuments
 */
export const modelTagIds = createCache<ModelTagIdsData>({
  redisKey: 'model:tag-ids',
  idKey: 'modelId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const tags = await pg.query<{ modelId: number; tagId: number }>(
      `SELECT "modelId", "tagId"
       FROM "TagsOnModels"
       WHERE "modelId" = ANY($1)`,
      [ids]
    );

    // Group by model
    const tagsByModel = tags.reduce((acc, { modelId, tagId }) => {
      acc[modelId] ??= [];
      acc[modelId].push(tagId);
      return acc;
    }, {} as Record<number, number[]>);

    return ids.map((modelId) => ({
      modelId,
      tags: tagsByModel[modelId] ?? [],
    }));
  },
  ttl: 60 * 60 * 24, // 24 hours
});

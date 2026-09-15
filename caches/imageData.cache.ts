import { createCache, type CacheContext } from './base';

/**
 * Tag IDs associated with an image
 */
export type ImageTagIds = {
  imageId: number;
  tags: number[];
};

// Tags to always include even when filtering Rekognition tags
const ALWAYS_INCLUDE_TAGS = ['anime', 'cartoon', 'comics', 'manga', 'man', 'woman', 'men', 'women'];

/**
 * Fetch image tag IDs directly from the database (no Redis cache).
 *
 * Replaces the retired `image:tagIds` Redis hash cache, which duplicated
 * civitai's own `tagIdsForImagesCache` and was the largest memory consumer
 * on next-redis-cluster (~13% of keys / ~1.7 GiB/shard). The only reader is
 * the v1 images feed (`feeds/images.feed.ts`), which now fetches image→tagIds
 * through an INJECTED fetcher (consumer-supplied, backed by its own warm
 * cache) and falls back to this uncached direct DB read when none is injected.
 *
 * Special filtering: When an image has both WD14 and Rekognition tags,
 * Rekognition tags are filtered out EXCEPT for:
 * - Moderation type tags
 * - Tags in ALWAYS_INCLUDE_TAGS (styles and subjects)
 *
 * Returns a `Record<number, ImageTagIds>` keyed by imageId (matching the
 * shape the cache wrapper previously returned to callers).
 */
export async function fetchImageTagIdsFromDb(
  ctx: CacheContext,
  ids: number[]
): Promise<Record<number, ImageTagIds>> {
  if (!ids.length) return {};

  // Fetch tags on image
  const imageTags = await ctx.pg.query<{
    imageId: number;
    tagId: number;
    source: string;
  }>(
    `SELECT
      "imageId",
      "tagId",
      "source"
     FROM "TagsOnImageDetails"
     WHERE "imageId" = ANY($1)
       AND disabled = false`,
    [ids]
  );

  // Fetch tag metadata for filtering
  const tagIds = [...new Set(imageTags.map(t => t.tagId))];
  const tags = await ctx.pg.query<{
    id: number;
    name: string;
    type: string;
  }>(
    `SELECT id, name, type FROM "Tag" WHERE id = ANY($1)`,
    [tagIds]
  );

  const tagMap = new Map(tags.map(t => [t.id, t]));

  // Check which images have WD14 tags
  const hasWD14: Record<number, boolean> = {};
  for (const row of imageTags) {
    hasWD14[row.imageId] ??= false;
    if (row.source === 'WD14') hasWD14[row.imageId] = true;
  }

  // Group by image and collect tag IDs with filtering
  const grouped = imageTags.reduce<Record<number, ImageTagIds>>((acc, row) => {
    const key = row.imageId;
    if (!acc[key]) {
      acc[key] = { imageId: row.imageId, tags: [] };
    }

    const tag = tagMap.get(row.tagId);
    if (!tag) return acc;

    // Apply filtering logic: if image has WD14 tags, filter Rekognition tags
    let canAdd = true;
    if (row.source === 'Rekognition' && hasWD14[row.imageId]) {
      // Keep only Moderation tags or tags in ALWAYS_INCLUDE_TAGS
      if (tag.type !== 'Moderation' && !ALWAYS_INCLUDE_TAGS.includes(tag.name)) {
        canAdd = false;
      }
    }

    if (canAdd) {
      acc[key].tags.push(row.tagId);
    }
    return acc;
  }, {});

  return grouped;
}

/**
 * Tag data
 */
export type TagData = {
  id: number;
  name: string;
  type: number;
  nsfwLevel: number;
};

/**
 * Cache for tag data
 * Fetches full tag information by tag ID
 */
export const tagData = createCache<TagData>({
  redisKey: 'tag:data',
  idKey: 'id',
  // A tag NAME is a string even when it is all digits ('1', '2girls' etc.).
  fieldTypes: { id: 'number', name: 'string', type: 'number', nsfwLevel: 'number' },
  async fetch(ctx: CacheContext, ids: number[]): Promise<TagData[]> {
    return await ctx.pg.query<TagData>(
      `SELECT
        id,
        name,
        type,
        "nsfwLevel"
       FROM "Tag"
       WHERE id = ANY($1)`,
      [ids]
    );
  },
  ttl: 60 * 60 * 24, // 24 hours
});

/**
 * Cosmetic data
 */
export type CosmeticData = {
  id: number;
  name: string;
  type: string;
  data: Record<string, unknown>;
  source: string;
};

/**
 * Cache for cosmetic data
 * Fetches cosmetic information by cosmetic ID
 */
export const cosmeticData = createCache<CosmeticData>({
  redisKey: 'cosmetic:data',
  idKey: 'id',
  fieldTypes: {
    id: 'number',
    name: 'string',
    type: 'string',
    data: 'json',
    source: 'string',
  },
  async fetch(ctx: CacheContext, ids: number[]): Promise<CosmeticData[]> {
    return await ctx.pg.query<CosmeticData>(
      `SELECT
        id,
        name,
        type,
        data,
        source
       FROM "Cosmetic"
       WHERE id = ANY($1)`,
      [ids]
    );
  },
  ttl: 60 * 60 * 24, // 24 hours
});

/**
 * User cosmetics (equipped cosmetics for users)
 */
export type UserCosmeticData = {
  userId: number;
  cosmetics: Array<{
    cosmeticId: number;
    data: Record<string, unknown>;
  }>;
};

/**
 * Cache for user cosmetics
 * Fetches equipped cosmetics for users
 */
export const userCosmetics = createCache<UserCosmeticData>({
  redisKey: 'user:cosmetics',
  idKey: 'userId',
  fieldTypes: { userId: 'number', cosmetics: 'json' },
  async fetch(ctx: CacheContext, ids: number[]): Promise<UserCosmeticData[]> {
    const cosmetics = await ctx.pg.query<{
      userId: number;
      cosmeticId: number;
      data: Record<string, unknown>;
    }>(
      `SELECT
        "userId",
        "cosmeticId",
        data
       FROM "UserCosmetic"
       WHERE "userId" = ANY($1)
         AND "equippedAt" IS NOT NULL
         AND "equippedToId" IS NULL`,
      [ids]
    );

    // Group by user
    const grouped = cosmetics.reduce<Record<number, UserCosmeticData>>((acc, row) => {
      if (!acc[row.userId]) {
        acc[row.userId] = { userId: row.userId, cosmetics: [] };
      }
      acc[row.userId].cosmetics.push({
        cosmeticId: row.cosmeticId,
        data: row.data,
      });
      return acc;
    }, {});

    return Object.values(grouped);
  },
  ttl: 60 * 60 * 24, // 24 hours
});

/**
 * Profile picture data
 */
export type ProfilePictureData = {
  userId: number;
  id: number;
  name: string | null;
  url: string;
  nsfwLevel: number;
  hash: string | null;
  ingestion: string;
  type: string;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Cache for user profile pictures
 * Fetches profile picture information for users
 */
export const profilePictures = createCache<ProfilePictureData>({
  redisKey: 'user:profilePicture',
  idKey: 'userId',
  fieldTypes: {
    userId: 'number',
    id: 'number',
    name: 'string?',
    url: 'string',
    nsfwLevel: 'number',
    hash: 'string?',
    ingestion: 'string',
    type: 'string',
    width: 'number?',
    height: 'number?',
    metadata: 'json?',
  },
  async fetch(ctx: CacheContext, ids: number[]): Promise<ProfilePictureData[]> {
    return await ctx.pg.query<ProfilePictureData>(
      `SELECT
        u.id as "userId",
        i.id,
        i.name,
        i.url,
        i."nsfwLevel",
        i.hash,
        i.ingestion,
        i.type,
        i.width,
        i.height,
        i.metadata
       FROM "User" u
       JOIN "Image" i ON i.id = u."profilePictureId"
       WHERE u.id = ANY($1)`,
      [ids]
    );
  },
  ttl: 60 * 60 * 24, // 24 hours
});

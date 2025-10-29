import { createFeed } from './base';
import type { ImageMetrics } from '../types/metric-types';

/**
 * Schema for image feed documents
 * Defines the structure stored in Meilisearch
 */
const schema = {
  id: { type: 'number' as const, primary: true, filterable: true },
  userId: { type: 'number' as const, filterable: true },
  postId: { type: 'number' as const, filterable: true },
  modelVersionId: { type: 'number' as const, filterable: true },
  nsfw: { type: 'boolean' as const, filterable: true },
  width: { type: 'number' as const, sortable: true },
  height: { type: 'number' as const, sortable: true },
  createdAt: { type: 'Date' as const, sortable: true },
  // Metrics
  heartCount: { type: 'number' as const, sortable: true },
  likeCount: { type: 'number' as const, sortable: true },
  commentCount: { type: 'number' as const, sortable: true },
} as const;

/**
 * Document type stored in Meilisearch
 */
type ImageDocument = {
  id: number;
  userId: number;
  postId: number | null;
  modelVersionId: number | null;
  nsfw: boolean;
  width: number;
  height: number;
  createdAt: Date;
  heartCount: number;
  likeCount: number;
  commentCount: number;
};

/**
 * Query input type
 * Defines filters that can be applied when querying
 */
type ImageQueryInput = {
  nsfw?: boolean;
  userId?: number;
  modelVersionId?: number;
};

/**
 * Populated image type returned to API
 * Includes additional data from caches
 */
type PopulatedImage = ImageDocument & {
  url: string;
  username: string;
  // ... other populated fields as needed
};

/**
 * Image Feed
 * Manages the Meilisearch index for images with metrics and caching
 *
 * All types are inferred from the function signatures:
 * - TInput from queryDocuments input parameter
 * - TDocument from createDocuments return type
 * - TPopulated from populateDocuments return type
 */
export const ImageFeed = createFeed({
  entityType: 'Image' as const,
  name: 'images',
  connection: {
    host: process.env.MEILISEARCH_IMAGE_INDEX_URL!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  },
  schema,

  /**
   * Create documents for Meilisearch from entity IDs
   * Fetches base data from PostgreSQL and metrics from ClickHouse
   *
   * Return type explicitly defined to infer TDocument
   */
  async createDocuments(ctx, ids, type = 'full') {
    // Fetch base data from PostgreSQL
    const images = await ctx.pg.query<Omit<ImageDocument, 'heartCount' | 'likeCount' | 'commentCount'>>(
      `SELECT
        id,
        "userId",
        "postId",
        "modelVersionId",
        nsfw,
        width,
        height,
        "createdAt"
       FROM "Image"
       WHERE id = ANY($1)`,
      [ids]
    );

    // Fetch metrics from ClickHouse
    const imageIds = images.map((img) => img.id);
    const metricsData = await ctx.metric.fetch(imageIds);

    // Combine base data with metrics
    return images.map((img): ImageDocument => {
      const imgMetrics = metricsData[img.id] as ImageMetrics | undefined;
      return {
        ...img,
        heartCount: imgMetrics?.Heart ?? 0,
        likeCount: imgMetrics?.Like ?? 0,
        commentCount: imgMetrics?.commentCount ?? 0,
      };
    });
  },

  /**
   * Query documents from Meilisearch with filters and pagination
   *
   * Input parameter contains only custom filters (no limit/cursor)
   * Pagination is accessed via ctx.pagination
   * Return type explicitly defined to match TDocument
   */
  async queryDocuments(ctx, input: ImageQueryInput): Promise<ImageDocument[]> {
    // Access pagination from context instead of input
    const { limit, cursor } = ctx.pagination;
    const { nsfw, userId, modelVersionId } = input;

    // Build filter string
    const filters: string[] = [];
    if (nsfw !== undefined) filters.push(`nsfw = ${nsfw}`);
    if (userId) filters.push(`userId = ${userId}`);
    if (modelVersionId) filters.push(`modelVersionId = ${modelVersionId}`);

    // Parse cursor for pagination
    let cursorFilter = '';
    if (cursor) {
      const [createdAt, id] = cursor.split(':');
      cursorFilter = `createdAt < ${createdAt} OR (createdAt = ${createdAt} AND id < ${id})`;
      if (filters.length) cursorFilter = ` AND (${cursorFilter})`;
    }

    // Search Meilisearch
    const result = await ctx.index.search<ImageDocument>(null, {
      filter: filters.join(' AND ') + cursorFilter,
      sort: ['createdAt:desc', 'id:desc'],
      limit,
      offset: 0,
    });

    return result.hits;
  },

  /**
   * Populate documents with additional data from caches
   * Adds user information and other related data
   *
   * Documents parameter is typed as TDocument
   * Return type explicitly defined to infer TPopulated
   */
  async populateDocuments(ctx, documents) {
    // documents is typed as ImageDocument[] through inference
    const userIds = [...new Set(documents.map((d) => d.userId))];
    const users = await ctx.cache.fetch('userData', userIds);

    // Combine documents with cached data
    return documents.map((doc): PopulatedImage => ({
      ...doc,
      url: `https://image.civitai.com/${doc.id}`,
      username: users[doc.userId]?.username ?? 'unknown',
    }));
  },
});

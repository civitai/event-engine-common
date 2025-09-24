import type { MeiliSearch, SearchResponse } from 'meilisearch';
import type { ModelFeedInput } from '../../types/meilisearch/inputs';
import type { ModelRawItem, ModelFeedResponse } from '../../types/meilisearch/documents';
import { METRICS_MODELS_INDEX_CONFIG, INDEX_NAMES } from '../../types/meilisearch/index-configs';
import { MODEL_SORT_OPTIONS } from '../../types/meilisearch/inputs';

export class ModelFeedService {
  constructor(private client: MeiliSearch) {}

  /**
   * Get models feed using the METRICS_MODELS_SEARCH_INDEX
   * Replicates the functionality of getModelsRawMeili
   */
  async getModelsFeed(input: ModelFeedInput): Promise<ModelFeedResponse> {
    const {
      take = 20,
      offset = 0,
      sort = 'Newest',
      browsingLevel = 1, // PG by default
      excludedUserIds = [],
      ...restInput
    } = input;

    try {
      const index = this.client.index(INDEX_NAMES.MODELS);

      // Build filters
      const filters: string[] = [];

      // NSFW Level filtering
      if (browsingLevel) {
        const nsfwLevels = this.getNsfwLevelsFromBrowsingLevel(browsingLevel);
        filters.push(`nsfwLevel IN [${nsfwLevels.join(', ')}]`);
      }

      // User exclusions
      if (excludedUserIds.length > 0) {
        filters.push(`NOT userId IN [${excludedUserIds.join(', ')}]`);
      }

      // Status filtering (default to published)
      const status = input.status || ['Published'];
      if (status.length > 0) {
        filters.push(`status IN [${status.map(s => `"${s}"`).join(', ')}]`);
      }

      // Type filtering
      if (input.types?.length) {
        filters.push(`type IN [${input.types.map(t => `"${t}"`).join(', ')}]`);
      }

      // Base model filtering
      if (input.baseModels?.length) {
        filters.push(`baseModel IN [${input.baseModels.map(bm => `"${bm}"`).join(', ')}]`);
      }

      // Early access filtering
      if (input.earlyAccess !== undefined) {
        filters.push(`earlyAccess = ${input.earlyAccess}`);
      }

      // Generation support filtering
      if (input.supportsGeneration !== undefined) {
        filters.push(`supportsGeneration = ${input.supportsGeneration}`);
      }

      // POI filtering
      if (input.disablePoi) {
        filters.push(`NOT poi = true`);
      }
      if (input.poiOnly) {
        filters.push(`poi = true`);
      }

      // Minor filtering
      if (input.disableMinor) {
        filters.push(`NOT minor = true`);
      }
      if (input.minorOnly) {
        filters.push(`minor = true`);
      }

      // Featured filtering
      if (input.isFeatured !== undefined) {
        filters.push(`isFeatured = ${input.isFeatured}`);
      }

      // Collection filtering
      if (input.collectionId) {
        filters.push(`collectionId = ${input.collectionId}`);
      }

      // Club filtering
      if (input.clubId) {
        filters.push(`clubId = ${input.clubId}`);
      }

      // User filtering
      if (input.user) {
        filters.push(`userId = ${input.user}`);
      }

      // Build sort
      const sortConfig = MODEL_SORT_OPTIONS[sort];
      const searchSort = sortConfig
        ? [`${sortConfig.field}:${sortConfig.direction}`]
        : ['publishedAtUnix:desc']; // default

      const searchOptions = {
        offset,
        limit: take + 1, // Get one extra to determine if there are more results
        sort: searchSort,
        filter: filters.length > 0 ? filters : undefined,
      };

      const searchResponse: SearchResponse<ModelRawItem> = await index.search('', searchOptions);
      const hits = searchResponse.hits || [];

      // Determine next cursor
      const hasMore = hits.length > take;
      const results = hasMore ? hits.slice(0, take) : hits;
      const nextCursor = hasMore ? offset + take : undefined;

      return {
        items: results,
        nextCursor,
        isPrivate: false, // TODO: implement private logic if needed
      };
    } catch (error) {
      console.error('Error in ModelFeedService.getModelsFeed:', error);
      return {
        items: [],
        nextCursor: undefined,
        isPrivate: false
      };
    }
  }

  /**
   * Convert browsing level flags to NSFW level array
   * Based on browsing level constants from the main app
   */
  private getNsfwLevelsFromBrowsingLevel(browsingLevel: number): number[] {
    const levels: number[] = [];

    // PG = 1, PG13 = 2, R = 4, X = 8, XXX = 16
    if (browsingLevel & 1) levels.push(1);   // PG
    if (browsingLevel & 2) levels.push(2);   // PG13
    if (browsingLevel & 4) levels.push(3);   // R
    if (browsingLevel & 8) levels.push(4);   // X
    if (browsingLevel & 16) levels.push(5);  // XXX

    return levels;
  }

  /**
   * Validate that a filter attribute is configured for the index
   */
  validateFilterAttribute(attribute: string): boolean {
    return METRICS_MODELS_INDEX_CONFIG.filterableAttributes.includes(attribute);
  }

  /**
   * Validate that a sort attribute is configured for the index
   */
  validateSortAttribute(attribute: string): boolean {
    return METRICS_MODELS_INDEX_CONFIG.sortableAttributes.includes(attribute);
  }
}

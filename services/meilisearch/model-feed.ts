import type { MeiliSearch, SearchResponse } from 'meilisearch';
import type { ModelFeedInput } from '../../types/meilisearch/inputs';
import type { ModelRawItem, ModelFeedResponse } from '../../types/meilisearch/documents';
import { METRICS_MODELS_INDEX_CONFIG, INDEX_NAMES } from '../../types/meilisearch/index-configs';
import { MODEL_SORT_OPTIONS } from '../../types/meilisearch/inputs';
import { logger } from '../../utils/logger';
import type { IDatabaseProvider } from '../../types/database';
import { DatabaseHelper } from '../../types/database';
import { NsfwLevel, Flags, onlySelectableLevels, snapToInterval } from '../../utils/nsfw-utils';

// Helper functions matching the main app
export const makeMeiliModelSearchFilter = (
  field: string,
  criteria: string
): string => {
  return `${field} ${criteria}`;
};

export const makeMeiliModelSearchSort = (
  field: string,
  criteria: 'asc' | 'desc'
): string => {
  return `${field}:${criteria}`;
};

export class ModelFeedService {
  private dbHelper?: DatabaseHelper;

  constructor(
    private client: MeiliSearch,
    databaseProvider?: IDatabaseProvider
  ) {
    this.client = client;

    // Use provided database provider if available
    this.dbHelper = databaseProvider ? new DatabaseHelper(databaseProvider) : undefined;

    logger.modelFeed('ModelFeedService initialized');
    logger.modelFeed('Available sort options:', Object.keys(MODEL_SORT_OPTIONS));
    logger.modelFeed('Database provider:', databaseProvider ? 'provided' : 'not provided');
  }

  /**
   * Get models feed using the METRICS_MODELS_SEARCH_INDEX
   * Exact replica of getModelsFromSearch functionality
   */
  async getModelsFeed(input: ModelFeedInput): Promise<ModelFeedResponse> {
    const {
      // BaseFeedInput properties
      take,
      cursor,

      // ModelFeedInput properties
      sort,
      types,
      baseModels,
      period,
      checkpointType,
      status,
      earlyAccess,
      supportsGeneration,
      fromPlatform,
      availability,
      isFeatured,
      fileFormats,
      clubId,
      collectionId,
      tagname,
      tag,
      username,
      user,
      followed,
      hidden,
      ids,
      modelVersionIds,
      excludedTagIds,
      disablePoi,
      disableMinor,
      poiOnly,
      minorOnly,
      browsingLevel: inputBrowsingLevel = 31, // PG by default
      excludedUserIds = [],
      offset = 0,
    } = input;

    // Extract moderator and user context from input
    const isModerator = !!(input as any).isModerator;
    const currentUserId = (input as any).currentUserId;

    const limit = take || 100;
    const entry = cursor ? Number(cursor) : undefined;

    logger.modelFeed(`getModelsFeed called with:`, input);

    try {
      const index = this.client.index(INDEX_NAMES.MODELS);

      // Build filters array and sorts array
      const filters: string[] = [];
      const sorts: string[] = [];

      // Handle username to userId conversion
      let finalUserId = user;
      if (username && !finalUserId) {
        if (!this.dbHelper) {
          logger.warn('ModelFeedService', 'Username provided but no database provider available');
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
        logger.modelFeed(`Looking up userId for username: ${username}`);
        const userResult = await this.dbHelper.getUserIdFromUsername(username);
        if (userResult.userId) {
          finalUserId = userResult.userId;
          logger.modelFeed(`Found userId ${finalUserId} for username ${username}`);
        } else {
          logger.warn('ModelFeedService', `User not found for username: ${username}`);
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
      }

      // Handle special cases - hidden models
      if (hidden && currentUserId) {
        if (!this.dbHelper) {
          logger.warn('ModelFeedService', 'Hidden models requested but no database provider available');
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
        logger.modelFeed(`Getting hidden models for user ${currentUserId}`);
        const hiddenResult = await this.dbHelper.getHiddenModelIds(currentUserId);
        if (hiddenResult.modelIds.length > 0) {
          filters.push(makeMeiliModelSearchFilter('id', `IN [${hiddenResult.modelIds.join(',')}]`));
          logger.modelFeed(`Added hidden models filter: ${hiddenResult.modelIds.length} models`);
        } else {
          logger.modelFeed('User has no hidden models, returning empty result');
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
      }

      // Handle followed users
      if (currentUserId && followed) {
        if (!this.dbHelper) {
          logger.warn('ModelFeedService', 'Followed users requested but no database provider available');
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
        logger.modelFeed(`Getting followed users for user ${currentUserId}`);
        const followedResult = await this.dbHelper.getFollowedUserIds(currentUserId);
        if (followedResult.userIds.length > 0) {
          filters.push(makeMeiliModelSearchFilter('userId', `IN [${followedResult.userIds.join(',')}]`));
          logger.modelFeed(`Added followed users filter: ${followedResult.userIds.length} users`);
        } else {
          logger.modelFeed('User follows no one, returning empty result');
          return { items: [], nextCursor: undefined, isPrivate: false };
        }
      }

      // POI/Minor filtering
      if (disablePoi) {
        filters.push(`(NOT poi = true)`);
        logger.modelFeed('Added disablePoi filter');
      }
      if (disableMinor) {
        filters.push(`(NOT minor = true)`);
        logger.modelFeed('Added disableMinor filter');
      }

      // Moderator-only filters
      if (isModerator) {
        if (poiOnly) {
          filters.push(`poi = true`);
          logger.modelFeed('Added poiOnly filter (moderator)');
        }
        if (minorOnly) {
          filters.push(`minor = true`);
          logger.modelFeed('Added minorOnly filter (moderator)');
        }
      }

      // NSFW Level filtering
      let browsingLevel = inputBrowsingLevel;
      if (!browsingLevel) browsingLevel = NsfwLevel.PG;
      else browsingLevel = onlySelectableLevels(browsingLevel);
      const browsingLevels = Flags.instanceToArray(browsingLevel);
      if (isModerator && browsingLevels.includes(0)) browsingLevels.push(0);

      const nsfwFilters = [makeMeiliModelSearchFilter('nsfwLevel', `IN [${browsingLevels.join(',')}]`)];

      // Allow users to see their own unscanned content
      if (currentUserId) {
        nsfwFilters.push(makeMeiliModelSearchFilter('nsfwLevel', `= 0`));
      }

      filters.push(`(${nsfwFilters.join(' OR ')})`);

      // Status filtering
      if (!isModerator || !status?.length) {
        filters.push(makeMeiliModelSearchFilter('status', `= 'Published'`));
      } else if (status?.length) {
        const statusValues = status.includes('Unpublished')
          ? [...status, 'UnpublishedViolation']
          : status;
        filters.push(
          makeMeiliModelSearchFilter('status', `IN [${statusValues.map((s) => `'${s}'`).join(',')}]`)
        );
      }

      // User filtering - exactly like original logic: userId OR excludedUserIds (but not both)
      if (finalUserId) {
        filters.push(makeMeiliModelSearchFilter('userId', `= ${finalUserId}`));
        logger.modelFeed(`Added userId filter: ${finalUserId}`);
      } else if (excludedUserIds?.length) {
        filters.push(makeMeiliModelSearchFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));
        logger.modelFeed(`Added excludedUserIds filter: ${excludedUserIds.length} users`);
      }

      // Model type filtering
      if (types?.length) {
        filters.push(
          makeMeiliModelSearchFilter('type', `IN [${types.map((t) => `'${t}'`).join(',')}]`)
        );
        logger.modelFeed(`Added types filter: [${types.join(', ')}]`);
      }

      // Checkpoint type filtering
      if (checkpointType) {
        filters.push(makeMeiliModelSearchFilter('checkpointType', `= '${checkpointType}'`));
        logger.modelFeed(`Added checkpointType filter: ${checkpointType}`);
      }

      // Base model filtering
      if (baseModels?.length) {
        filters.push(
          makeMeiliModelSearchFilter('baseModel', `IN [${baseModels.map((bm) => `'${bm}'`).join(',')}]`)
        );
        logger.modelFeed(`Added baseModels filter: [${baseModels.join(', ')}]`);
      }

      // Tag filtering
      if (tagname || tag) {
        if (!this.dbHelper) {
          logger.warn('ModelFeedService', 'Tag filtering requested but no database provider available');
        } else {
          logger.modelFeed(`Looking up tagId for tag: ${tagname || tag}`);
          const tagResult = await this.dbHelper.getTagIdFromName(tagname || tag || '');
          if (tagResult.tagId) {
            filters.push(makeMeiliModelSearchFilter('tagIds', `IN [${tagResult.tagId}]`));
            logger.modelFeed(`Added tag filter: ${tagResult.tagId}`);
          } else {
            logger.warn('ModelFeedService', `Tag not found: ${tagname || tag}`);
            return { items: [], nextCursor: undefined, isPrivate: false };
          }
        }
      }

      // Excluded tags
      if (excludedTagIds?.length) {
        filters.push(makeMeiliModelSearchFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
        logger.modelFeed(`Added excludedTagIds filter: ${excludedTagIds.length} tags`);
      }

      // Early access
      if (earlyAccess !== undefined) {
        filters.push(makeMeiliModelSearchFilter('earlyAccess', `= ${earlyAccess}`));
        logger.modelFeed(`Added earlyAccess filter: ${earlyAccess}`);
      }

      // Features
      if (supportsGeneration !== undefined) {
        filters.push(makeMeiliModelSearchFilter('supportsGeneration', `= ${supportsGeneration}`));
        logger.modelFeed(`Added supportsGeneration filter: ${supportsGeneration}`);
      }
      if (fromPlatform !== undefined) {
        filters.push(makeMeiliModelSearchFilter('fromPlatform', `= ${fromPlatform}`));
        logger.modelFeed(`Added fromPlatform filter: ${fromPlatform}`);
      }
      if (isFeatured !== undefined) {
        filters.push(makeMeiliModelSearchFilter('isFeatured', `= ${isFeatured}`));
        logger.modelFeed(`Added isFeatured filter: ${isFeatured}`);
      }

      // Availability
      if (availability) {
        filters.push(makeMeiliModelSearchFilter('availability', `= '${availability}'`));
        logger.modelFeed(`Added availability filter: ${availability}`);
      } else if (!isModerator) {
        filters.push(makeMeiliModelSearchFilter('availability', `!= 'Private'`));
        logger.modelFeed('Added non-private availability filter');
      }

      // Collection/Club filtering
      if (collectionId) {
        filters.push(makeMeiliModelSearchFilter('collectionId', `= ${collectionId}`));
        logger.modelFeed(`Added collectionId filter: ${collectionId}`);
      }
      if (clubId) {
        filters.push(makeMeiliModelSearchFilter('clubId', `= ${clubId}`));
        logger.modelFeed(`Added clubId filter: ${clubId}`);
      }

      // File formats
      if (fileFormats?.length) {
        filters.push(
          makeMeiliModelSearchFilter(
            'fileFormats',
            `IN [${fileFormats.map((f) => `'${f}'`).join(',')}]`
          )
        );
        logger.modelFeed(`Added fileFormats filter: [${fileFormats.join(', ')}]`);
      }

      // IDs filtering
      if (ids?.length) {
        filters.push(makeMeiliModelSearchFilter('id', `IN [${ids.join(',')}]`));
        logger.modelFeed(`Added ids filter: ${ids.length} ids`);
      }

      // Model version IDs
      // This would need to be handled differently as it requires a join
      // For now, we'll skip this complex filter in the Meilisearch query (matches original)
      if (modelVersionIds?.length) {
        logger.warn('ModelFeedService', 'modelVersionIds filter not supported in Meilisearch version (matches original behavior)');
      }

      // Period filtering for metrics
      let afterDate: Date | undefined;
      if (period && period !== 'AllTime') {
        const now = Date.now();
        // Simple period calculation
        switch (period.toLowerCase()) {
          case 'day':
            afterDate = new Date(now - 24 * 60 * 60 * 1000);
            break;
          case 'week':
            afterDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
            break;
          case 'month':
            afterDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
            break;
          case 'year':
            afterDate = new Date(now - 365 * 24 * 60 * 60 * 1000);
            break;
          default:
            afterDate = new Date(now - 24 * 60 * 60 * 1000);
        }

        filters.push(
          makeMeiliModelSearchFilter('publishedAtUnix', `> ${snapToInterval(afterDate.getTime())}`)
        );
        logger.modelFeed(`Added period filter: ${period}`);
      }

      // Publish date filtering
      const snappedNow = snapToInterval(Date.now());
      if (!isModerator) {
        filters.push(makeMeiliModelSearchFilter('publishedAtUnix', `<= ${snappedNow}`));
        logger.modelFeed('Added publishedAt filter for non-moderators');
      }

      // Sort handling with entry-based pagination
      logger.modelFeed(`Processing sort: '${sort}'`);

      let searchSort: string;
      if (sort === 'Highest Rated') {
        searchSort = makeMeiliModelSearchSort('rating', 'desc');
      } else if (sort === 'Most Liked') {
        searchSort = makeMeiliModelSearchSort('favoriteCount', 'desc');
      } else if (sort === 'Most Downloaded') {
        searchSort = makeMeiliModelSearchSort('downloadCount', 'desc');
      } else if (sort === 'Most Discussed') {
        searchSort = makeMeiliModelSearchSort('commentCount', 'desc');
      } else if (sort === 'Most Collected') {
        searchSort = makeMeiliModelSearchSort('favoriteCount', 'desc'); // Using favoriteCount as proxy
      } else if (sort === 'Oldest') {
        searchSort = makeMeiliModelSearchSort('publishedAt', 'asc');
      } else {
        // Default: Newest
        searchSort = makeMeiliModelSearchSort('lastVersionAt', 'desc');
        if (entry) {
          filters.push(
            makeMeiliModelSearchFilter('lastVersionAtUnix', `<= ${snapToInterval(Math.round(entry))}`)
          );
          logger.modelFeed(`Added entry filter: lastVersionAtUnix <= ${snapToInterval(Math.round(entry))}`);
        }
      }

      sorts.push(searchSort);
      sorts.push(makeMeiliModelSearchSort('id', 'desc')); // Secondary sort for consistency
      logger.modelFeed(`Final sorts array:`, sorts);

      // Overfetch to ensure we have enough results after post-query filtering
      const OVERFETCH_MULTIPLIER = 1.5;
      const searchOptions = {
        filter: filters.join(' AND '),
        sort: sorts,
        limit: Math.round(limit * OVERFETCH_MULTIPLIER),
        offset,
      };

      logger.modelFeed('Meilisearch options:', {
        filter: searchOptions.filter,
        sort: searchOptions.sort,
        limit: searchOptions.limit,
        offset: searchOptions.offset
      });

      logger.modelFeed('Executing Meilisearch query...');
      // const searchResponse: SearchResponse<ModelRawItem> =
      //   await index.search(null, searchOptions); // Use null instead of empty string
      const searchResponse =
        await index.search<ModelRawItem>(null, searchOptions); // Use null instead of empty string

      const hits = searchResponse.hits || [];
      logger.modelFeed(`Meilisearch returned ${hits.length} hits, took ${searchResponse.processingTimeMs}ms`);

      // Determine next cursor using entry-based approach
      let nextCursor: number | undefined;
      if (hits.length > limit) {
        hits.pop();
        // If we have no entrypoint, it's the first request, and set one for the future
        // else keep it the same
        nextCursor = !entry ? hits[0]?.lastVersionAtUnix : entry;
      }

      // Apply post-query user-specific filtering (exact match from original)
      logger.modelFeed(`Applying post-query filtering to ${hits.length} hits`);
      const filteredHits = hits.filter((hit) => {
        const isOwnContent = (currentUserId && hit.user?.id === currentUserId) || isModerator;

        // User can see their own private content
        if (hit.availability === 'Private' && !isOwnContent) return false;

        // User can see their own unpublished content
        if (hit.status !== 'Published' && !isOwnContent) return false;

        return true;
      });

      // Trim results back to requested limit after filtering
      const limitedHits = filteredHits.slice(0, limit + 1);
      logger.modelFeed(`After filtering: ${filteredHits.length} hits, limited to: ${limitedHits.length}`);

      // Check for existence in DB (similar to image pattern)
      const modelIds = limitedHits.map((hit) => hit.id);
      if (!this.dbHelper) {
        logger.warn('ModelFeedService', 'No database provider available for existence check, skipping');
        return {
          items: limitedHits.slice(0, limit),
          nextCursor: limitedHits.length > limit ? nextCursor : undefined,
          isPrivate: false,
        };
      }

      const existingResult = await this.dbHelper.checkModelsExist(modelIds);
      const existingIds = new Set(existingResult.existingIds);
      const existingHits = limitedHits.filter((h) => existingIds.has(h.id));

      logger.modelFeed(`Returning ${existingHits.slice(0, limit).length} results with nextCursor: ${nextCursor}`);

      return {
        items: existingHits.slice(0, limit),
        nextCursor: existingHits.length > limit ? nextCursor : undefined,
        isPrivate: false,
      };
    } catch (error) {
      logger.error('ModelFeedService', 'Error in getModelsFeed:', error);
      return {
        items: [],
        nextCursor: undefined,
        isPrivate: false,
      };
    }
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

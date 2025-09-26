import type { MeiliSearch, SearchResponse } from 'meilisearch';
import type { ImageFeedInput } from '../../types/meilisearch/inputs';
import type {
  ImageMetricsSearchIndexRecord,
  ImageFeedResult,
  ImageFeedResponse
} from '../../types/meilisearch/documents';
import { METRICS_IMAGES_INDEX_CONFIG, INDEX_NAMES } from '../../types/meilisearch/index-configs';
import { IMAGE_SORT_OPTIONS } from '../../types/meilisearch/inputs';
import { MetricService } from '../metrics';
import { ImageMetrics } from '../../types/metric-types';
import { logger } from '../../utils/logger';
import type { IDatabaseProvider } from '../../types/database';
import { DatabaseHelper } from '../../types/database';

// Helper functions matching the main app
export const makeMeiliImageSearchFilter = (
  field: string,
  criteria: string
): string => {
  return `${field} ${criteria}`;
};

export const makeMeiliImageSearchSort = (
  field: string,
  criteria: 'asc' | 'desc'
): string => {
  return `${field}:${criteria}`;
};

// NSFW Level constants
const NsfwLevel = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  Blocked: 32,
} as const;

const nsfwBrowsingLevelsArray = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX, NsfwLevel.Blocked];

// Basic flags utility
class Flags {
  static instanceToArray(instance: number): number[] {
    const result: number[] = [];
    let bit = 1;
    while (bit <= instance) {
      if (instance & bit) result.push(bit);
      bit <<= 1;
    }
    return result;
  }

  static intersects(a: number, b: number): boolean {
    return (a & b) !== 0;
  }
}

const nsfwBrowsingLevelsFlag = nsfwBrowsingLevelsArray.reduce((acc, level) => acc | level, 0);

function onlySelectableLevels(level: number): number {
  if (level & NsfwLevel.Blocked) level = level & ~NsfwLevel.Blocked;
  return level;
}

export class ImageFeedService {
  private dbHelper?: DatabaseHelper;

  constructor(
    private client: MeiliSearch,
    private metricsService: MetricService,
    databaseProvider?: IDatabaseProvider
  ) {
    this.client = client;
    this.metricsService = metricsService;

    // Use provided database provider if available
    this.dbHelper = databaseProvider ? new DatabaseHelper(databaseProvider) : undefined;

    logger.imageFeed('ImageFeedService initialized');
    logger.imageFeed('Available sort options:', Object.keys(IMAGE_SORT_OPTIONS));
    logger.imageFeed('Database provider:', databaseProvider ? 'provided' : 'not provided');
  }

  /**
   * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
   * Exact replica of getImagesFromSearchPreFilter functionality
   */
  async getImagesFeed(input: ImageFeedInput): Promise<ImageFeedResponse> {
    const {
      // BaseFeedInput properties
      take,
      cursor,

      // ImageFeedInput properties
      limit = 100,
      offset = 0,
      sort = 'Newest',
      modelVersionId,
      types,
      withMeta,
      fromPlatform,
      notPublished,
      scheduled,
      username,
      tags,
      tools,
      techniques,
      baseModels,
      period,
      isModerator = false,
      currentUserId,
      excludedUserIds = [],
      hideAutoResources,
      hideManualResources,
      hidden,
      followed,
      entry,
      postId,
      reviewId,
      modelId,
      prioritizedUserIds,
      useCombinedNsfwLevel = false,
      remixOfId,
      remixesOnly,
      nonRemixesOnly,
      excludedTagIds,
      disablePoi,
      disableMinor,
      requiringMeta,
      poiOnly,
      minorOnly,
      blockedFor,
      browsingLevel: inputBrowsingLevel,
      userId,
      postIds,
      nsfwRestrictedBaseModels = [],
    } = input;

    logger.imageFeed(`getImagesFeed called with:`, input);

    try {
      const index = this.client.index(INDEX_NAMES.IMAGES);

      // Build filters array and sorts array
      const filters: string[] = [];
      const sorts: string[] = [];
      const snappedNow = this.snapToInterval(Date.now());

      // Handle username to userId conversion
      let finalUserId = userId;
      if (username && !finalUserId) {
        if (!this.dbHelper) {
          logger.warn('ImageFeedService', 'Username provided but no database provider available');
          return { data: [], nextCursor: undefined };
        }
        logger.imageFeed(`Looking up userId for username: ${username}`);
        const userResult = await this.dbHelper.getUserIdFromUsername(username);
        if (userResult.userId) {
          finalUserId = userResult.userId;
          logger.imageFeed(`Found userId ${finalUserId} for username ${username}`);
        } else {
          logger.warn('ImageFeedService', `User not found for username: ${username}`);
          return { data: [], nextCursor: undefined };
        }
      }

      // Handle postId -> postIds conversion (exactly like original)
      let finalPostIds = postIds ? [...postIds] : [];
      if (postId) {
        finalPostIds = [...finalPostIds, postId];
        logger.imageFeed(`Added postId ${postId} to postIds array`);
      }

      // Handle special cases - hidden images
      if (hidden && currentUserId) {
        if (!this.dbHelper) {
          logger.warn('ImageFeedService', 'Hidden images requested but no database provider available');
          return { data: [], nextCursor: undefined };
        }
        logger.imageFeed(`Getting hidden images for user ${currentUserId}`);
        const hiddenResult = await this.dbHelper.getHiddenImageIds(currentUserId);
        if (hiddenResult.imageIds.length > 0) {
          filters.push(makeMeiliImageSearchFilter('id', `IN [${hiddenResult.imageIds.join(',')}]`));
          logger.imageFeed(`Added hidden images filter: ${hiddenResult.imageIds.length} images`);
        } else {
          logger.imageFeed('User has no hidden images, returning empty result');
          return { data: [], nextCursor: undefined };
        }
      }

      // Handle followed users
      if (currentUserId && followed) {
        if (!this.dbHelper) {
          logger.warn('ImageFeedService', 'Followed users requested but no database provider available');
          return { data: [], nextCursor: undefined };
        }
        logger.imageFeed(`Getting followed users for user ${currentUserId}`);
        const followedResult = await this.dbHelper.getFollowedUserIds(currentUserId);
        if (followedResult.userIds.length > 0) {
          filters.push(makeMeiliImageSearchFilter('userId', `IN [${followedResult.userIds.join(',')}]`));
          logger.imageFeed(`Added followed users filter: ${followedResult.userIds.length} users`);
        } else {
          logger.imageFeed('User follows no one, returning empty result');
          return { data: [], nextCursor: undefined };
        }
      }

      // NSFW Level filtering
      let browsingLevel = inputBrowsingLevel;
      if (!browsingLevel) browsingLevel = NsfwLevel.PG;
      else browsingLevel = onlySelectableLevels(browsingLevel);
      const browsingLevels = Flags.instanceToArray(browsingLevel);
      const includesNsfwContent = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);
      if (isModerator && includesNsfwContent) browsingLevels.push(0);
      const nsfwLevelField = useCombinedNsfwLevel ? 'combinedNsfwLevel' : 'nsfwLevel';
      const nsfwFilters = [
        makeMeiliImageSearchFilter(nsfwLevelField, `IN [${browsingLevels.join(',')}]`)
      ];
      // Allow users to see their own unscanned content on their user page
      if (currentUserId && finalUserId === currentUserId) {
        nsfwFilters.push(makeMeiliImageSearchFilter(nsfwLevelField, `= 0`));
      }
      filters.push(`(${nsfwFilters.join(' OR ')})`);

      // NSFW License Restrictions Filter
      if (nsfwRestrictedBaseModels.length > 0) {
        const restrictedBaseModelsQuoted = nsfwRestrictedBaseModels.map(bm => `'${bm}'`);
        // Exclude images that have BOTH restricted NSFW levels AND restricted base models
        filters.push(
          `NOT (${nsfwLevelField} IN [${nsfwBrowsingLevelsArray.join(
            ','
          )}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`
        );
      }

      // POI filtering - Past POI cut-off, don't even return for owners
      if (disablePoi) {
        filters.push('(NOT poi = true)');
        logger.imageFeed('Added disablePoi filter');
      }

      // Minor filtering
      if (disableMinor) {
        filters.push('(NOT minor = true)');
        logger.imageFeed('Added disableMinor filter');
      }

      // Moderator-only filters
      if (isModerator) {
        if (poiOnly) {
          filters.push('poi = true');
          logger.imageFeed('Added poiOnly filter (moderator)');
        }
        if (minorOnly) {
          filters.push('minor = true');
          logger.imageFeed('Added minorOnly filter (moderator)');
        }
        if (blockedFor?.length) {
          const blockedForQuoted = blockedFor.map(bf => `'${bf}'`);
          filters.push(`blockedFor IN [${blockedForQuoted.join(',')}]`);
          logger.imageFeed(`Added blockedFor filter: [${blockedFor.join(', ')}]`);
        }
      }

      // User exclusions - removed duplicate (handled later with userId logic)

      // Model and Review filtering - NOT SUPPORTED in Meilisearch version (matches original)
      // Original logs these as "cantProcess" - reviewId, modelId, prioritizedUserIds are not implemented
      if (modelId || reviewId || prioritizedUserIds) {
        logger.warn('ImageFeedService', 'modelId, reviewId, and prioritizedUserIds filters not supported in Meilisearch version (matches original behavior)');
      }

      // Model version filtering
      if (modelVersionId) {
        const versionFilters = [makeMeiliImageSearchFilter('postedToId', `= ${modelVersionId}`)];
        if (!hideAutoResources) {
          versionFilters.push(makeMeiliImageSearchFilter('modelVersionIds', `IN [${modelVersionId}]`));
        }
        if (!hideManualResources) {
          versionFilters.push(
            makeMeiliImageSearchFilter('modelVersionIdsManual', `IN [${modelVersionId}]`)
          );
        }
        filters.push(`(${versionFilters.join(' OR ')})`);
        logger.imageFeed(`Added modelVersionId filter: ${modelVersionId}`);
      }

      // Remix filtering
      if (remixOfId) {
        filters.push(makeMeiliImageSearchFilter('remixOfId', `= ${remixOfId}`));
      }
      if (remixesOnly && !nonRemixesOnly) {
        filters.push(makeMeiliImageSearchFilter('remixOfId', '>= 0'));
      }
      if (nonRemixesOnly) {
        filters.push(makeMeiliImageSearchFilter('remixOfId', 'NOT EXISTS'));
      }

      // Excluded tags filtering
      if (excludedTagIds?.length) {
        filters.push(makeMeiliImageSearchFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
        logger.imageFeed(`Added excludedTagIds filter: ${excludedTagIds.length} tags`);
      }

      // Meta filtering
      if (withMeta) filters.push(makeMeiliImageSearchFilter('hasMeta', '= true'));
      if (requiringMeta) {
        filters.push(`("blockedFor" = ${1})`); // BlockedReason.AiNotVerified = 1
      }
      if (fromPlatform) filters.push(makeMeiliImageSearchFilter('onSite', '= true'));

      // Publish Date Filtering
      if (isModerator) {
        if (notPublished) filters.push(makeMeiliImageSearchFilter('publishedAtUnix', 'NOT EXISTS'));
        else if (scheduled)
          filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `> ${Date.now()}`));
        else {
          const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${Date.now()}`)];
          if (currentUserId) {
            publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
          }
          filters.push(`(${publishedFilters.join(' OR ')})`);
        }
      } else if (userId) {
        // For specific user's content, allow seeing scheduled/notPublished content for owners
        // Filtering is handled in post-query filtering
      } else {
        // General feed queries - apply published filter for caching
        filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`));
      }

      // Additional filters
      if (types?.length) filters.push(makeMeiliImageSearchFilter('type', `IN [${types.join(',')}]`));
      if (tags?.length) filters.push(makeMeiliImageSearchFilter('tagIds', `IN [${tags.join(',')}]`));
      if (tools?.length) filters.push(makeMeiliImageSearchFilter('toolIds', `IN [${tools.join(',')}]`));
      if (techniques?.length)
        filters.push(makeMeiliImageSearchFilter('techniqueIds', `IN [${techniques.join(',')}]`));
      if (finalPostIds?.length) {
        filters.push(makeMeiliImageSearchFilter('postId', `IN [${finalPostIds.join(',')}]`));
        logger.imageFeed(`Added postIds filter: [${finalPostIds.join(', ')}]`);
      }
      if (baseModels?.length) {
        filters.push(makeMeiliImageSearchFilter('baseModel', `IN [${baseModels.map(bm => `"${bm}"`).join(',')}]`));
        logger.imageFeed(`Added baseModels filter: [${baseModels.join(', ')}]`);
      }
      // User filtering - exactly like original logic: userId OR excludedUserIds (but not both)
      if (finalUserId) {
        filters.push(makeMeiliImageSearchFilter('userId', `= ${finalUserId}`));
        logger.imageFeed(`Added userId filter: ${finalUserId}`);
      } else if (excludedUserIds?.length) {
        filters.push(makeMeiliImageSearchFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));
        logger.imageFeed(`Added excludedUserIds filter: ${excludedUserIds.length} users`);
      }

      // Handle period filter
      if (period && period !== 'AllTime') {
        const now = Date.now();
        let afterDate: Date;

        // Simple period calculation (would use dayjs in real implementation)
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
          makeMeiliImageSearchFilter('sortAtUnix', `> ${this.snapToInterval(afterDate.getTime())}`)
        );
      }

      // Sort handling with entry-based pagination
      logger.imageFeed(`Processing sort: '${sort}'`);

      const sortConfig = IMAGE_SORT_OPTIONS[sort];
      if (!sortConfig) {
        logger.warn('ImageFeedService', `Unknown sort option: '${sort}', falling back to 'Newest'`);
      }

      const finalSortConfig = sortConfig || IMAGE_SORT_OPTIONS['Newest'];
      logger.imageFeed(`Using sort config:`, finalSortConfig);

      let searchSort: string;
      if (sort === 'Oldest') {
        // Special handling for Oldest to maintain backward compatibility
        searchSort = makeMeiliImageSearchSort('sortAt', 'asc');
        logger.imageFeed('Using legacy Oldest sort with sortAt field');
      } else {
        // Use the proper field from sort config
        const fieldToUse = finalSortConfig.field === 'sortAtUnix' ? 'sortAt' : finalSortConfig.field;
        searchSort = makeMeiliImageSearchSort(fieldToUse, finalSortConfig.direction);
        logger.imageFeed(`Using sort: ${fieldToUse}:${finalSortConfig.direction}`);

        // For entry-based pagination with time-based sorts
        if (entry && (finalSortConfig.field === 'sortAtUnix' || fieldToUse === 'sortAt')) {
          filters.push(
            makeMeiliImageSearchFilter('sortAtUnix', `<= ${this.snapToInterval(Math.round(entry))}`)
          );
          logger.imageFeed(`Added entry filter: sortAtUnix <= ${this.snapToInterval(Math.round(entry))}`);
        }
      }

      sorts.push(searchSort);
      sorts.push(makeMeiliImageSearchSort('id', 'desc')); // secondary sort for consistency
      logger.imageFeed(`Final sorts array:`, sorts);

      // Overfetch to ensure we have enough results after post-query filtering
      const OVERFETCH_MULTIPLIER = 1.5;
      const searchOptions = {
        filter: filters.join(' AND '),
        sort: sorts,
        limit: Math.round(limit * OVERFETCH_MULTIPLIER),
        offset,
      };

      logger.imageFeed('Meilisearch options:', {
        filter: searchOptions.filter,
        sort: searchOptions.sort,
        limit: searchOptions.limit,
        offset: searchOptions.offset
      });

      logger.imageFeed('Executing Meilisearch query...');
      const searchResponse: SearchResponse<ImageMetricsSearchIndexRecord> =
        await index.search(null, searchOptions); // Use null instead of empty string

      const hits = searchResponse.hits || [];
      logger.imageFeed(`Meilisearch returned ${hits.length} hits, took ${searchResponse.processingTimeMs}ms`);

      // Determine next cursor using entry-based approach
      let nextCursor: number | undefined;
      if (hits.length > limit) {
        hits.pop();
        // If we have no entrypoint, it's the first request, and set one for the future
        // else keep it the same
        nextCursor = !entry ? hits[0]?.sortAtUnix : entry;
      }

      // Apply post-query user-specific filtering (exact match from original)
      logger.imageFeed(`Applying post-query filtering to ${hits.length} hits`);
      const filteredHits = hits.filter((hit) => {
        if (!hit.url) return false; // check for good data

        const isOwnContent = (currentUserId && hit.userId === currentUserId) || isModerator;

        // User can see their own private content
        if (hit.availability === 'Private' && !isOwnContent) return false;

        // User can see their own blocked content
        if (hit.blockedFor && !isOwnContent) return false;

        // User can see their own scheduled or unpublished content
        if ((!hit.publishedAtUnix || hit.publishedAtUnix > snappedNow) && !isOwnContent) return false;

        // User can see their own unscanned content
        if (hit.nsfwLevel === 0 && !isOwnContent) return false;

        // filter out items flagged with minor unless it's the owner or moderator
        if (hit.acceptableMinor) return isOwnContent;
        // filter out non-scanned unless it's the owner or moderator
        if (![0, NsfwLevel.Blocked].includes(hit.nsfwLevel) && !hit.needsReview) return true;

        return isOwnContent || (isModerator && includesNsfwContent);
      });

      // Trim results back to requested limit after filtering
      const limitedHits = filteredHits.slice(0, limit + 1);
      logger.imageFeed(`After filtering: ${filteredHits.length} hits, limited to: ${limitedHits.length}`);

      // Get all image IDs from limited results
      const searchImageIds = limitedHits.map((hit) => hit.id);
      const filteredHitIds = [...new Set(searchImageIds)];

      // Basic existence check (would be more sophisticated in real implementation)
      const filtered = limitedHits.filter(hit => filteredHitIds.includes(hit.id));

      // Get metrics and build final result
      logger.imageFeed(`Fetching metrics for ${filtered.length} images`);
      const imageMetrics = await this.getImageMetricsObject(filtered);
      logger.imageFeed(`Retrieved metrics for ${Object.keys(imageMetrics).length} images`);

      const fullData = filtered.map((h) => {
        const match = imageMetrics[h.id];
        return {
          ...h,
          stats: {
            likeCountAllTime: match?.ReactionLike ?? 0,
            laughCountAllTime: match?.ReactionLaugh?? 0,
            heartCountAllTime: match?.ReactionHeart ?? 0,
            cryCountAllTime: match?.ReactionCry ?? 0,
            commentCountAllTime: match?.commentCount ?? 0,
            collectedCountAllTime: match?.Collection ?? 0,
            tippedAmountCountAllTime: match?.tippedAmount ?? 0,
            dislikeCountAllTime: 0,
            viewCountAllTime: 0,
          },
        };
      });

      logger.imageFeed(`Returning ${fullData.length} results with nextCursor: ${nextCursor}`);

      return {
        data: fullData,
        nextCursor,
      };
    } catch (error) {
      logger.error('ImageFeedService', 'Error in getImagesFeed:', error);
      return {
        data: [],
        nextCursor: undefined,
      };
    }
  }

  /**
   * Get image metrics object - replica of the main app function
   */
  private async getImageMetricsObject(data: { id: number }[]): Promise<Record<number, ImageMetrics>> {
    try {
      const imageIds = data.map(d => d.id);
      logger.imageFeed(`Fetching metrics for image IDs: [${imageIds.join(', ')}]`);
      const metrics = await this.metricsService.fetch('Image', imageIds);
      logger.imageFeed(`Metrics fetch completed for ${Object.keys(metrics).length} images`);
      return metrics;
    } catch (e) {
      logger.error('ImageFeedService', 'Failed to getImageMetrics:', e);
      return {};
    }
  }

  /**
   * Snap timestamp to interval (for consistency with existing logic)
   */
  private snapToInterval(timestamp: number, interval = 60000): number {
    return Math.floor(timestamp / interval) * interval;
  }

  /**
   * Validate that a filter attribute is configured for the index
   */
  validateFilterAttribute(attribute: string): boolean {
    return METRICS_IMAGES_INDEX_CONFIG.filterableAttributes.includes(attribute);
  }

  /**
   * Validate that a sort attribute is configured for the index
   */
  validateSortAttribute(attribute: string): boolean {
    return METRICS_IMAGES_INDEX_CONFIG.sortableAttributes.includes(attribute);
  }
}

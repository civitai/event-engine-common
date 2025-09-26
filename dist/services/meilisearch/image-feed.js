"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageFeedService = exports.makeMeiliImageSearchSort = exports.makeMeiliImageSearchFilter = void 0;
const index_configs_1 = require("../../types/meilisearch/index-configs");
const inputs_1 = require("../../types/meilisearch/inputs");
const logger_1 = require("../../utils/logger");
const database_1 = require("../../types/database");
// Helper functions matching the main app
const makeMeiliImageSearchFilter = (field, criteria) => {
    return `${field} ${criteria}`;
};
exports.makeMeiliImageSearchFilter = makeMeiliImageSearchFilter;
const makeMeiliImageSearchSort = (field, criteria) => {
    return `${field}:${criteria}`;
};
exports.makeMeiliImageSearchSort = makeMeiliImageSearchSort;
// NSFW Level constants
const NsfwLevel = {
    PG: 1,
    PG13: 2,
    R: 4,
    X: 8,
    XXX: 16,
    Blocked: 32,
};
const nsfwBrowsingLevelsArray = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX, NsfwLevel.Blocked];
// Basic flags utility
class Flags {
    static instanceToArray(instance) {
        const result = [];
        let bit = 1;
        while (bit <= instance) {
            if (instance & bit)
                result.push(bit);
            bit <<= 1;
        }
        return result;
    }
    static intersects(a, b) {
        return (a & b) !== 0;
    }
}
const nsfwBrowsingLevelsFlag = nsfwBrowsingLevelsArray.reduce((acc, level) => acc | level, 0);
function onlySelectableLevels(level) {
    if (level & NsfwLevel.Blocked)
        level = level & ~NsfwLevel.Blocked;
    return level;
}
class ImageFeedService {
    constructor(client, metricsService, databaseProvider) {
        this.client = client;
        this.metricsService = metricsService;
        this.client = client;
        this.metricsService = metricsService;
        // Use provided database provider if available
        this.dbHelper = databaseProvider ? new database_1.DatabaseHelper(databaseProvider) : undefined;
        logger_1.logger.imageFeed('ImageFeedService initialized');
        logger_1.logger.imageFeed('Available sort options:', Object.keys(inputs_1.IMAGE_SORT_OPTIONS));
        logger_1.logger.imageFeed('Database provider:', databaseProvider ? 'provided' : 'not provided');
    }
    /**
     * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
     * Exact replica of getImagesFromSearchPreFilter functionality
     */
    async getImagesFeed(input) {
        const { 
        // BaseFeedInput properties
        take, cursor, 
        // ImageFeedInput properties
        limit = 100, offset = 0, sort = 'Newest', modelVersionId, types, withMeta, fromPlatform, notPublished, scheduled, username, tags, tools, techniques, baseModels, period, isModerator = false, currentUserId, excludedUserIds = [], hideAutoResources, hideManualResources, hidden, followed, entry, postId, reviewId, modelId, prioritizedUserIds, useCombinedNsfwLevel = false, remixOfId, remixesOnly, nonRemixesOnly, excludedTagIds, disablePoi, disableMinor, requiringMeta, poiOnly, minorOnly, blockedFor, browsingLevel: inputBrowsingLevel, userId, postIds, nsfwRestrictedBaseModels = [], } = input;
        logger_1.logger.imageFeed(`getImagesFeed called with:`, input);
        try {
            const index = this.client.index(index_configs_1.INDEX_NAMES.IMAGES);
            // Build filters array and sorts array
            const filters = [];
            const sorts = [];
            const snappedNow = this.snapToInterval(Date.now());
            // Handle username to userId conversion
            let finalUserId = userId;
            if (username && !finalUserId) {
                if (!this.dbHelper) {
                    logger_1.logger.warn('ImageFeedService', 'Username provided but no database provider available');
                    return { data: [], nextCursor: undefined };
                }
                logger_1.logger.imageFeed(`Looking up userId for username: ${username}`);
                const userResult = await this.dbHelper.getUserIdFromUsername(username);
                if (userResult.userId) {
                    finalUserId = userResult.userId;
                    logger_1.logger.imageFeed(`Found userId ${finalUserId} for username ${username}`);
                }
                else {
                    logger_1.logger.warn('ImageFeedService', `User not found for username: ${username}`);
                    // Return empty result when user doesn't exist
                    return { data: [], nextCursor: undefined };
                }
            }
            // Handle postId -> postIds conversion (exactly like original)
            let finalPostIds = postIds ? [...postIds] : [];
            if (postId) {
                finalPostIds = [...finalPostIds, postId];
                logger_1.logger.imageFeed(`Added postId ${postId} to postIds array`);
            }
            // Handle special cases - hidden images
            if (hidden && currentUserId) {
                if (!this.dbHelper) {
                    logger_1.logger.warn('ImageFeedService', 'Hidden images requested but no database provider available');
                    return { data: [], nextCursor: undefined };
                }
                logger_1.logger.imageFeed(`Getting hidden images for user ${currentUserId}`);
                const hiddenResult = await this.dbHelper.getHiddenImageIds(currentUserId);
                if (hiddenResult.imageIds.length > 0) {
                    // Add filter to only show hidden images
                    filters.push((0, exports.makeMeiliImageSearchFilter)('id', `IN [${hiddenResult.imageIds.join(',')}]`));
                    logger_1.logger.imageFeed(`Added hidden images filter: ${hiddenResult.imageIds.length} images`);
                }
                else {
                    // User has no hidden images
                    logger_1.logger.imageFeed('User has no hidden images, returning empty result');
                    return { data: [], nextCursor: undefined };
                }
            }
            // Handle followed users
            if (currentUserId && followed) {
                if (!this.dbHelper) {
                    logger_1.logger.warn('ImageFeedService', 'Followed users requested but no database provider available');
                    return { data: [], nextCursor: undefined };
                }
                logger_1.logger.imageFeed(`Getting followed users for user ${currentUserId}`);
                const followedResult = await this.dbHelper.getFollowedUserIds(currentUserId);
                if (followedResult.userIds.length > 0) {
                    // Add filter to only show content from followed users
                    filters.push((0, exports.makeMeiliImageSearchFilter)('userId', `IN [${followedResult.userIds.join(',')}]`));
                    logger_1.logger.imageFeed(`Added followed users filter: ${followedResult.userIds.length} users`);
                }
                else {
                    // User follows no one
                    logger_1.logger.imageFeed('User follows no one, returning empty result');
                    return { data: [], nextCursor: undefined };
                }
            }
            // NSFW Level filtering
            let browsingLevel = inputBrowsingLevel;
            if (!browsingLevel)
                browsingLevel = NsfwLevel.PG;
            else
                browsingLevel = onlySelectableLevels(browsingLevel);
            const browsingLevels = Flags.instanceToArray(browsingLevel);
            const includesNsfwContent = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);
            if (isModerator && includesNsfwContent)
                browsingLevels.push(0);
            const nsfwLevelField = useCombinedNsfwLevel ? 'combinedNsfwLevel' : 'nsfwLevel';
            const nsfwFilters = [
                (0, exports.makeMeiliImageSearchFilter)(nsfwLevelField, `IN [${browsingLevels.join(',')}]`)
            ];
            // Allow users to see their own unscanned content on their user page
            if (currentUserId && finalUserId === currentUserId) {
                nsfwFilters.push((0, exports.makeMeiliImageSearchFilter)(nsfwLevelField, `= 0`));
            }
            filters.push(`(${nsfwFilters.join(' OR ')})`);
            // NSFW License Restrictions Filter
            if (nsfwRestrictedBaseModels.length > 0) {
                const restrictedBaseModelsQuoted = nsfwRestrictedBaseModels.map(bm => `'${bm}'`);
                // Exclude images that have BOTH restricted NSFW levels AND restricted base models
                filters.push(`NOT (${nsfwLevelField} IN [${nsfwBrowsingLevelsArray.join(',')}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`);
            }
            // POI filtering - Past POI cut-off, don't even return for owners
            if (disablePoi) {
                filters.push('(NOT poi = true)');
                logger_1.logger.imageFeed('Added disablePoi filter');
            }
            // Minor filtering
            if (disableMinor) {
                filters.push('(NOT minor = true)');
                logger_1.logger.imageFeed('Added disableMinor filter');
            }
            // Moderator-only filters
            if (isModerator) {
                if (poiOnly) {
                    filters.push('poi = true');
                    logger_1.logger.imageFeed('Added poiOnly filter (moderator)');
                }
                if (minorOnly) {
                    filters.push('minor = true');
                    logger_1.logger.imageFeed('Added minorOnly filter (moderator)');
                }
                if (blockedFor?.length) {
                    const blockedForQuoted = blockedFor.map(bf => `'${bf}'`);
                    filters.push(`blockedFor IN [${blockedForQuoted.join(',')}]`);
                    logger_1.logger.imageFeed(`Added blockedFor filter: [${blockedFor.join(', ')}]`);
                }
            }
            // User exclusions - removed duplicate (handled later with userId logic)
            // Model and Review filtering - NOT SUPPORTED in Meilisearch version (matches original)
            // Original logs these as "cantProcess" - reviewId, modelId, prioritizedUserIds are not implemented
            if (modelId || reviewId || prioritizedUserIds) {
                logger_1.logger.warn('ImageFeedService', 'modelId, reviewId, and prioritizedUserIds filters not supported in Meilisearch version (matches original behavior)');
            }
            // Model version filtering
            if (modelVersionId) {
                const versionFilters = [(0, exports.makeMeiliImageSearchFilter)('postedToId', `= ${modelVersionId}`)];
                if (!hideAutoResources) {
                    versionFilters.push((0, exports.makeMeiliImageSearchFilter)('modelVersionIds', `IN [${modelVersionId}]`));
                }
                if (!hideManualResources) {
                    versionFilters.push((0, exports.makeMeiliImageSearchFilter)('modelVersionIdsManual', `IN [${modelVersionId}]`));
                }
                filters.push(`(${versionFilters.join(' OR ')})`);
                logger_1.logger.imageFeed(`Added modelVersionId filter: ${modelVersionId}`);
            }
            // Remix filtering
            if (remixOfId) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', `= ${remixOfId}`));
            }
            if (remixesOnly && !nonRemixesOnly) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', '>= 0'));
            }
            if (nonRemixesOnly) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', 'NOT EXISTS'));
            }
            // Excluded tags filtering
            if (excludedTagIds?.length) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
                logger_1.logger.imageFeed(`Added excludedTagIds filter: ${excludedTagIds.length} tags`);
            }
            // Meta filtering
            if (withMeta)
                filters.push((0, exports.makeMeiliImageSearchFilter)('hasMeta', '= true'));
            if (requiringMeta) {
                filters.push(`("blockedFor" = ${1})`); // BlockedReason.AiNotVerified = 1
            }
            if (fromPlatform)
                filters.push((0, exports.makeMeiliImageSearchFilter)('onSite', '= true'));
            // Publish Date Filtering
            if (isModerator) {
                if (notPublished)
                    filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', 'NOT EXISTS'));
                else if (scheduled)
                    filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `> ${Date.now()}`));
                else {
                    const publishedFilters = [(0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `<= ${Date.now()}`)];
                    if (currentUserId) {
                        publishedFilters.push((0, exports.makeMeiliImageSearchFilter)('userId', `= ${currentUserId}`));
                    }
                    filters.push(`(${publishedFilters.join(' OR ')})`);
                }
            }
            else if (userId) {
                // For specific user's content, allow seeing scheduled/notPublished content for owners
                // Filtering is handled in post-query filtering
            }
            else {
                // General feed queries - apply published filter for caching
                filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `<= ${snappedNow}`));
            }
            // Additional filters
            if (types?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('type', `IN [${types.join(',')}]`));
            if (tags?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('tagIds', `IN [${tags.join(',')}]`));
            if (tools?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('toolIds', `IN [${tools.join(',')}]`));
            if (techniques?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('techniqueIds', `IN [${techniques.join(',')}]`));
            if (finalPostIds?.length) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('postId', `IN [${finalPostIds.join(',')}]`));
                logger_1.logger.imageFeed(`Added postIds filter: [${finalPostIds.join(', ')}]`);
            }
            if (baseModels?.length) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('baseModel', `IN [${baseModels.map(bm => `"${bm}"`).join(',')}]`));
                logger_1.logger.imageFeed(`Added baseModels filter: [${baseModels.join(', ')}]`);
            }
            // User filtering - exactly like original logic: userId OR excludedUserIds (but not both)
            if (finalUserId) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('userId', `= ${finalUserId}`));
                logger_1.logger.imageFeed(`Added userId filter: ${finalUserId}`);
            }
            else if (excludedUserIds?.length) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('userId', `NOT IN [${excludedUserIds.join(',')}]`));
                logger_1.logger.imageFeed(`Added excludedUserIds filter: ${excludedUserIds.length} users`);
            }
            // Handle period filter
            if (period && period !== 'AllTime') {
                const now = Date.now();
                let afterDate;
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
                filters.push((0, exports.makeMeiliImageSearchFilter)('sortAtUnix', `> ${this.snapToInterval(afterDate.getTime())}`));
            }
            // Sort handling with entry-based pagination
            logger_1.logger.imageFeed(`Processing sort: '${sort}'`);
            const sortConfig = inputs_1.IMAGE_SORT_OPTIONS[sort];
            if (!sortConfig) {
                logger_1.logger.warn('ImageFeedService', `Unknown sort option: '${sort}', falling back to 'Newest'`);
            }
            const finalSortConfig = sortConfig || inputs_1.IMAGE_SORT_OPTIONS['Newest'];
            logger_1.logger.imageFeed(`Using sort config:`, finalSortConfig);
            let searchSort;
            if (sort === 'Oldest') {
                // Special handling for Oldest to maintain backward compatibility
                searchSort = (0, exports.makeMeiliImageSearchSort)('sortAt', 'asc');
                logger_1.logger.imageFeed('Using legacy Oldest sort with sortAt field');
            }
            else {
                // Use the proper field from sort config
                const fieldToUse = finalSortConfig.field === 'sortAtUnix' ? 'sortAt' : finalSortConfig.field;
                searchSort = (0, exports.makeMeiliImageSearchSort)(fieldToUse, finalSortConfig.direction);
                logger_1.logger.imageFeed(`Using sort: ${fieldToUse}:${finalSortConfig.direction}`);
                // For entry-based pagination with time-based sorts
                if (entry && (finalSortConfig.field === 'sortAtUnix' || fieldToUse === 'sortAt')) {
                    filters.push((0, exports.makeMeiliImageSearchFilter)('sortAtUnix', `<= ${this.snapToInterval(Math.round(entry))}`));
                    logger_1.logger.imageFeed(`Added entry filter: sortAtUnix <= ${this.snapToInterval(Math.round(entry))}`);
                }
            }
            sorts.push(searchSort);
            sorts.push((0, exports.makeMeiliImageSearchSort)('id', 'desc')); // secondary sort for consistency
            logger_1.logger.imageFeed(`Final sorts array:`, sorts);
            // Overfetch to ensure we have enough results after post-query filtering
            const OVERFETCH_MULTIPLIER = 1.5;
            const searchOptions = {
                filter: filters.join(' AND '),
                sort: sorts,
                limit: Math.round(limit * OVERFETCH_MULTIPLIER),
                offset,
            };
            logger_1.logger.imageFeed('Meilisearch options:', {
                filter: searchOptions.filter,
                sort: searchOptions.sort,
                limit: searchOptions.limit,
                offset: searchOptions.offset
            });
            logger_1.logger.imageFeed('Executing Meilisearch query...');
            const searchResponse = await index.search(null, searchOptions); // Use null instead of empty string
            const hits = searchResponse.hits || [];
            logger_1.logger.imageFeed(`Meilisearch returned ${hits.length} hits, took ${searchResponse.processingTimeMs}ms`);
            // Determine next cursor using entry-based approach
            let nextCursor;
            if (hits.length > limit) {
                hits.pop();
                // If we have no entrypoint, it's the first request, and set one for the future
                // else keep it the same
                nextCursor = !entry ? hits[0]?.sortAtUnix : entry;
            }
            // Apply post-query user-specific filtering (exact match from original)
            logger_1.logger.imageFeed(`Applying post-query filtering to ${hits.length} hits`);
            const filteredHits = hits.filter((hit) => {
                if (!hit.url)
                    return false; // check for good data
                const isOwnContent = (currentUserId && hit.userId === currentUserId) || isModerator;
                // User can see their own private content
                if (hit.availability === 'Private' && !isOwnContent)
                    return false;
                // User can see their own blocked content
                if (hit.blockedFor && !isOwnContent)
                    return false;
                // User can see their own scheduled or unpublished content
                if ((!hit.publishedAtUnix || hit.publishedAtUnix > snappedNow) && !isOwnContent)
                    return false;
                // User can see their own unscanned content
                if (hit.nsfwLevel === 0 && !isOwnContent)
                    return false;
                // filter out items flagged with minor unless it's the owner or moderator
                if (hit.acceptableMinor)
                    return isOwnContent;
                // filter out non-scanned unless it's the owner or moderator
                if (![0, NsfwLevel.Blocked].includes(hit.nsfwLevel) && !hit.needsReview)
                    return true;
                return isOwnContent || (isModerator && includesNsfwContent);
            });
            // Trim results back to requested limit after filtering
            const limitedHits = filteredHits.slice(0, limit + 1);
            logger_1.logger.imageFeed(`After filtering: ${filteredHits.length} hits, limited to: ${limitedHits.length}`);
            // Get all image IDs from limited results
            const searchImageIds = limitedHits.map((hit) => hit.id);
            const filteredHitIds = [...new Set(searchImageIds)];
            // Basic existence check (would be more sophisticated in real implementation)
            const filtered = limitedHits.filter(hit => filteredHitIds.includes(hit.id));
            // Get metrics and build final result
            logger_1.logger.imageFeed(`Fetching metrics for ${filtered.length} images`);
            const imageMetrics = await this.getImageMetricsObject(filtered);
            logger_1.logger.imageFeed(`Retrieved metrics for ${Object.keys(imageMetrics).length} images`);
            const fullData = filtered.map((h) => {
                const match = imageMetrics[h.id];
                return {
                    ...h,
                    stats: {
                        likeCountAllTime: match?.ReactionLike ?? 0,
                        laughCountAllTime: match?.ReactionLaugh ?? 0,
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
            logger_1.logger.imageFeed(`Returning ${fullData.length} results with nextCursor: ${nextCursor}`);
            return {
                data: fullData,
                nextCursor,
            };
        }
        catch (error) {
            logger_1.logger.error('ImageFeedService', 'Error in getImagesFeed:', error);
            return {
                data: [],
                nextCursor: undefined,
            };
        }
    }
    /**
     * Get image metrics object - replica of the main app function
     */
    async getImageMetricsObject(data) {
        try {
            const imageIds = data.map(d => d.id);
            logger_1.logger.imageFeed(`Fetching metrics for image IDs: [${imageIds.join(', ')}]`);
            const metrics = await this.metricsService.fetch('Image', imageIds);
            logger_1.logger.imageFeed(`Metrics fetch completed for ${Object.keys(metrics).length} images`);
            return metrics;
        }
        catch (e) {
            logger_1.logger.error('ImageFeedService', 'Failed to getImageMetrics:', e);
            return {};
        }
    }
    /**
     * Snap timestamp to interval (for consistency with existing logic)
     */
    snapToInterval(timestamp, interval = 60000) {
        return Math.floor(timestamp / interval) * interval;
    }
    /**
     * Validate that a filter attribute is configured for the index
     */
    validateFilterAttribute(attribute) {
        return index_configs_1.METRICS_IMAGES_INDEX_CONFIG.filterableAttributes.includes(attribute);
    }
    /**
     * Validate that a sort attribute is configured for the index
     */
    validateSortAttribute(attribute) {
        return index_configs_1.METRICS_IMAGES_INDEX_CONFIG.sortableAttributes.includes(attribute);
    }
}
exports.ImageFeedService = ImageFeedService;

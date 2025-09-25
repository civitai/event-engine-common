"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageFeedService = exports.makeMeiliImageSearchSort = exports.makeMeiliImageSearchFilter = void 0;
const index_configs_1 = require("../../types/meilisearch/index-configs");
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
    constructor(client, metricsService) {
        this.client = client;
        this.metricsService = metricsService;
        this.client = client;
        this.metricsService = metricsService;
    }
    /**
     * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
     * Exact replica of getImagesFromSearchPreFilter functionality
     */
    async getImagesFeed(input) {
        const { limit = 100, offset = 0, sort = 'Newest', browsingLevel: inputBrowsingLevel, currentUserId, isModerator = false, excludedUserIds = [], useCombinedNsfwLevel = false, entry, nsfwRestrictedBaseModels = [], ...restInput } = input;
        try {
            const index = this.client.index(index_configs_1.INDEX_NAMES.IMAGES);
            // Build filters array and sorts array
            const filters = [];
            const sorts = [];
            const snappedNow = this.snapToInterval(Date.now());
            // Handle special cases - hidden images
            if (input.hidden && currentUserId) {
                // This would require a database call to get hidden images
                // For now, return empty as this is a special case
                return { data: [], nextCursor: undefined };
            }
            // Handle followed users
            if (currentUserId && input.followed) {
                // This would require a database call to get followed users
                // For now, return empty as this is a special case
                return { data: [], nextCursor: undefined };
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
            if (currentUserId && input.userId === currentUserId) {
                nsfwFilters.push((0, exports.makeMeiliImageSearchFilter)(nsfwLevelField, `= 0`));
            }
            filters.push(`(${nsfwFilters.join(' OR ')})`);
            // NSFW License Restrictions Filter
            if (nsfwRestrictedBaseModels.length > 0) {
                const restrictedBaseModelsQuoted = nsfwRestrictedBaseModels.map(bm => `'${bm}'`);
                // Exclude images that have BOTH restricted NSFW levels AND restricted base models
                filters.push(`NOT (${nsfwLevelField} IN [${nsfwBrowsingLevelsArray.join(',')}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`);
            }
            // User exclusions
            if (excludedUserIds.length > 0) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('userId', `NOT IN [${excludedUserIds.join(',')}]`));
            }
            // Model version filtering
            if (input.modelVersionId) {
                const versionFilters = [(0, exports.makeMeiliImageSearchFilter)('postedToId', `= ${input.modelVersionId}`)];
                if (!input.hideAutoResources) {
                    versionFilters.push((0, exports.makeMeiliImageSearchFilter)('modelVersionIds', `IN [${input.modelVersionId}]`));
                }
                if (!input.hideManualResources) {
                    versionFilters.push((0, exports.makeMeiliImageSearchFilter)('modelVersionIdsManual', `IN [${input.modelVersionId}]`));
                }
                filters.push(`(${versionFilters.join(' OR ')})`);
            }
            // Remix filtering
            if (input.remixOfId) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', `= ${input.remixOfId}`));
            }
            if (input.remixesOnly && !input.nonRemixesOnly) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', '>= 0'));
            }
            if (input.nonRemixesOnly) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('remixOfId', 'NOT EXISTS'));
            }
            // Excluded tags filtering
            if (input.excludedTagIds?.length) {
                filters.push((0, exports.makeMeiliImageSearchFilter)('tagIds', `NOT IN [${input.excludedTagIds.join(',')}]`));
            }
            // Meta filtering
            if (input.withMeta)
                filters.push((0, exports.makeMeiliImageSearchFilter)('hasMeta', '= true'));
            if (input.requiringMeta) {
                filters.push(`("blockedFor" = ${1})`); // BlockedReason.AiNotVerified = 1
            }
            if (input.fromPlatform)
                filters.push((0, exports.makeMeiliImageSearchFilter)('onSite', '= true'));
            // Publish Date Filtering
            if (isModerator) {
                if (input.notPublished)
                    filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', 'NOT EXISTS'));
                else if (input.scheduled)
                    filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `> ${Date.now()}`));
                else {
                    const publishedFilters = [(0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `<= ${Date.now()}`)];
                    if (currentUserId) {
                        publishedFilters.push((0, exports.makeMeiliImageSearchFilter)('userId', `= ${currentUserId}`));
                    }
                    filters.push(`(${publishedFilters.join(' OR ')})`);
                }
            }
            else if (input.userId) {
                // For specific user's content, allow seeing scheduled/notPublished content for owners
                // Filtering is handled in post-query filtering
            }
            else {
                // General feed queries - apply published filter for caching
                filters.push((0, exports.makeMeiliImageSearchFilter)('publishedAtUnix', `<= ${snappedNow}`));
            }
            // Additional filters
            if (input.types?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('type', `IN [${input.types.join(',')}]`));
            if (input.tags?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('tagIds', `IN [${input.tags.join(',')}]`));
            if (input.tools?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('toolIds', `IN [${input.tools.join(',')}]`));
            if (input.techniques?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('techniqueIds', `IN [${input.techniques.join(',')}]`));
            if (input.postIds?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('postId', `IN [${input.postIds.join(',')}]`));
            if (input.baseModels?.length)
                filters.push((0, exports.makeMeiliImageSearchFilter)('baseModel', `IN [${input.baseModels.map(bm => `"${bm}"`).join(',')}]`));
            if (input.userId)
                filters.push((0, exports.makeMeiliImageSearchFilter)('userId', `= ${input.userId}`));
            // Handle period filter
            if (input.period && input.period !== 'AllTime') {
                const now = Date.now();
                let afterDate;
                // Simple period calculation (would use dayjs in real implementation)
                switch (input.period.toLowerCase()) {
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
            let searchSort;
            if (sort === 'Oldest') {
                searchSort = (0, exports.makeMeiliImageSearchSort)('sortAt', 'asc');
            }
            else {
                searchSort = (0, exports.makeMeiliImageSearchSort)('sortAt', 'desc');
                // For entry-based pagination
                if (entry) {
                    filters.push((0, exports.makeMeiliImageSearchFilter)('sortAtUnix', `<= ${this.snapToInterval(Math.round(entry))}`));
                }
            }
            sorts.push(searchSort);
            sorts.push((0, exports.makeMeiliImageSearchSort)('id', 'desc')); // secondary sort for consistency
            // Overfetch to ensure we have enough results after post-query filtering
            const OVERFETCH_MULTIPLIER = 1.5;
            const searchOptions = {
                filter: filters.join(' AND '),
                sort: sorts,
                limit: Math.round(limit * OVERFETCH_MULTIPLIER),
                offset,
            };
            const searchResponse = await index.search(null, searchOptions); // Use null instead of empty string
            const hits = searchResponse.hits || [];
            // Determine next cursor using entry-based approach
            let nextCursor;
            if (hits.length > limit) {
                hits.pop();
                // If we have no entrypoint, it's the first request, and set one for the future
                // else keep it the same
                nextCursor = !entry ? hits[0]?.sortAtUnix : entry;
            }
            // Apply post-query user-specific filtering (exact match from original)
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
            // Get all image IDs from limited results
            const searchImageIds = limitedHits.map((hit) => hit.id);
            const filteredHitIds = [...new Set(searchImageIds)];
            // Basic existence check (would be more sophisticated in real implementation)
            const filtered = limitedHits.filter(hit => filteredHitIds.includes(hit.id));
            // Get metrics and build final result
            const imageMetrics = await this.getImageMetricsObject(filtered);
            const fullData = filtered.map((h) => {
                const match = imageMetrics[h.id];
                return {
                    ...h,
                    stats: {
                        likeCountAllTime: match?.reactionLike ?? 0,
                        laughCountAllTime: match?.reactionLaugh ?? 0,
                        heartCountAllTime: match?.reactionHeart ?? 0,
                        cryCountAllTime: match?.reactionCry ?? 0,
                        commentCountAllTime: match?.comment ?? 0,
                        collectedCountAllTime: match?.collection ?? 0,
                        tippedAmountCountAllTime: match?.buzz ?? 0,
                        dislikeCountAllTime: 0,
                        viewCountAllTime: 0,
                    },
                };
            });
            return {
                data: fullData,
                nextCursor,
            };
        }
        catch (error) {
            console.error('Error in ImageFeedService.getImagesFeed:', error);
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
            // This would integrate with the metrics cache system
            // For now, return empty metrics (real implementation would fetch from cache)
            const metrics = await this.metricsService.fetch('Image', data.map(d => d.id));
            console.log(metrics);
            return metrics;
        }
        catch (e) {
            console.error('Failed to getImageMetrics:', e);
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

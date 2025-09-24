"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageFeedService = void 0;
const index_configs_1 = require("../../types/meilisearch/index-configs");
const inputs_1 = require("../../types/meilisearch/inputs");
class ImageFeedService {
    constructor(client) {
        this.client = client;
    }
    /**
     * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
     * Replicates the functionality of getImagesFromSearchPreFilter
     */
    async getImagesFeed(input) {
        const { limit = 100, offset = 0, sort = 'Newest', browsingLevel = 1, // PG by default
        currentUserId, isModerator = false, excludedUserIds = [], useCombinedNsfwLevel = false, ...restInput } = input;
        try {
            const index = this.client.index(index_configs_1.INDEX_NAMES.METRICS_IMAGES);
            // Build filters
            const filters = [];
            const snappedNow = this.snapToInterval(Date.now());
            // NSFW Level filtering
            const nsfwLevelField = useCombinedNsfwLevel ? 'combinedNsfwLevel' : 'nsfwLevel';
            const browsingLevels = this.getNsfwLevelsFromBrowsingLevel(browsingLevel);
            const nsfwFilters = [
                `${nsfwLevelField} IN [${browsingLevels.join(', ')}]`
            ];
            // Allow users to see their own unscanned content
            if (currentUserId && input.userId === currentUserId) {
                nsfwFilters.push(`${nsfwLevelField} = 0`);
            }
            filters.push(`(${nsfwFilters.join(' OR ')})`);
            // User exclusions
            if (excludedUserIds.length > 0) {
                filters.push(`NOT userId IN [${excludedUserIds.join(', ')}]`);
            }
            // POI filtering
            if (input.disablePoi) {
                filters.push(`NOT poi = true`);
            }
            if (input.poiOnly && isModerator) {
                filters.push(`poi = true`);
            }
            // Minor filtering
            if (input.disableMinor) {
                filters.push(`NOT minor = true`);
            }
            if (input.minorOnly && isModerator) {
                filters.push(`minor = true`);
            }
            // Blocked content filtering (moderator only)
            if (isModerator && input.blockedFor?.length) {
                filters.push(`blockedFor IN [${input.blockedFor.map(b => `"${b}"`).join(', ')}]`);
            }
            // Model version filtering
            if (input.modelVersionId) {
                const versionFilters = [`postedToId = ${input.modelVersionId}`];
                if (!input.hideAutoResources) {
                    versionFilters.push(`modelVersionIds IN [${input.modelVersionId}]`);
                }
                if (!input.hideManualResources) {
                    versionFilters.push(`modelVersionIdsManual IN [${input.modelVersionId}]`);
                }
                filters.push(`(${versionFilters.join(' OR ')})`);
            }
            // Base model filtering
            if (input.baseModels?.length) {
                filters.push(`baseModel IN [${input.baseModels.map(bm => `"${bm}"`).join(', ')}]`);
            }
            // Type filtering
            if (input.types?.length) {
                filters.push(`type IN [${input.types.map(t => `"${t}"`).join(', ')}]`);
            }
            // Tools filtering
            if (input.tools?.length) {
                const toolIds = this.convertToolNamesToIds(input.tools); // Would need implementation
                if (toolIds.length > 0) {
                    filters.push(`toolIds IN [${toolIds.join(', ')}]`);
                }
            }
            // Techniques filtering
            if (input.techniques?.length) {
                const techniqueIds = this.convertTechniqueNamesToIds(input.techniques); // Would need implementation
                if (techniqueIds.length > 0) {
                    filters.push(`techniqueIds IN [${techniqueIds.join(', ')}]`);
                }
            }
            // Tags filtering
            if (input.tags?.length) {
                const tagIds = this.convertTagNamesToIds(input.tags); // Would need implementation
                if (tagIds.length > 0) {
                    filters.push(`tagIds IN [${tagIds.join(', ')}]`);
                }
            }
            // Excluded tags filtering
            if (input.excludedTagIds?.length) {
                filters.push(`NOT tagIds IN [${input.excludedTagIds.join(', ')}]`);
            }
            // Remix filtering
            if (input.remixOfId) {
                filters.push(`remixOfId = ${input.remixOfId}`);
            }
            if (input.remixesOnly && !input.nonRemixesOnly) {
                filters.push(`remixOfId >= 0`);
            }
            if (input.nonRemixesOnly) {
                filters.push(`NOT remixOfId EXISTS`);
            }
            // User filtering
            if (input.userId) {
                filters.push(`userId = ${input.userId}`);
            }
            // Post filtering
            if (input.postId) {
                filters.push(`postId = ${input.postId}`);
            }
            // Meta filtering
            if (input.withMeta !== undefined) {
                filters.push(`hasMeta = ${input.withMeta}`);
            }
            if (input.requiringMeta) {
                filters.push(`hasMeta = true`);
            }
            // On-site filtering
            if (input.fromPlatform !== undefined) {
                filters.push(`onSite = ${input.fromPlatform}`);
            }
            // Build sort
            const sortConfig = inputs_1.IMAGE_SORT_OPTIONS[sort];
            const searchSort = sortConfig
                ? [`${sortConfig.field}:${sortConfig.direction}`]
                : ['sortAtUnix:desc']; // default
            const searchOptions = {
                offset,
                limit: limit + 1, // Get one extra to determine if there are more results
                sort: searchSort,
                filter: filters.length > 0 ? filters : undefined,
            };
            const searchResponse = await index.search('', searchOptions);
            const hits = searchResponse.hits || [];
            // Post-query filtering (replicate the permission logic from getImagesFromSearchPreFilter)
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
                if ((!hit.publishedAtUnix || hit.publishedAtUnix > snappedNow) && !isOwnContent) {
                    return false;
                }
                // User can see their own unscanned content
                if (hit.nsfwLevel === 0 && !isOwnContent)
                    return false;
                // Filter out items flagged with minor unless it's the owner or moderator
                if (hit.acceptableMinor)
                    return isOwnContent;
                // Filter out non-scanned unless it's the owner or moderator
                if (![0, 5].includes(hit.nsfwLevel) && !hit.needsReview)
                    return true; // 5 = Blocked level
                return isOwnContent || isModerator;
            });
            // Trim results back to requested limit after filtering
            const limitedHits = filteredHits.slice(0, limit);
            const hasMore = filteredHits.length > limit;
            const nextCursor = hasMore ? offset + limit : undefined;
            // Augment with detailed stats (this would require metrics integration)
            const resultsWithStats = await this.augmentWithStats(limitedHits);
            return {
                data: resultsWithStats,
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
     * Augment feed results with detailed stats
     * This would integrate with the metrics system to get reaction breakdowns
     */
    async augmentWithStats(hits) {
        // TODO: Implement metrics integration
        // For now, return with basic stats structure
        return hits.map(hit => ({
            ...hit,
            stats: {
                likeCountAllTime: 0,
                laughCountAllTime: 0,
                heartCountAllTime: 0,
                cryCountAllTime: 0,
                commentCountAllTime: hit.commentCount || 0,
                collectedCountAllTime: hit.collectedCount || 0,
                tippedAmountCountAllTime: 0,
                dislikeCountAllTime: 0,
                viewCountAllTime: 0,
            },
        }));
    }
    /**
     * Convert browsing level flags to NSFW level array
     */
    getNsfwLevelsFromBrowsingLevel(browsingLevel) {
        const levels = [];
        if (browsingLevel & 1)
            levels.push(1); // PG
        if (browsingLevel & 2)
            levels.push(2); // PG13
        if (browsingLevel & 4)
            levels.push(3); // R
        if (browsingLevel & 8)
            levels.push(4); // X
        if (browsingLevel & 16)
            levels.push(5); // XXX
        return levels;
    }
    /**
     * Snap timestamp to interval (for consistency with existing logic)
     */
    snapToInterval(timestamp, interval = 60000) {
        return Math.floor(timestamp / interval) * interval;
    }
    /**
     * Convert tool names to IDs (would need cache integration)
     */
    convertToolNamesToIds(toolNames) {
        // TODO: Implement tool name to ID conversion
        return [];
    }
    /**
     * Convert technique names to IDs (would need cache integration)
     */
    convertTechniqueNamesToIds(techniqueNames) {
        // TODO: Implement technique name to ID conversion
        return [];
    }
    /**
     * Convert tag names to IDs (would need cache integration)
     */
    convertTagNamesToIds(tagNames) {
        // TODO: Implement tag name to ID conversion
        return [];
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

import type { MeiliSearch } from 'meilisearch';
import type { ImageFeedInput } from '../../types/meilisearch/inputs';
import type { ImageFeedResponse } from '../../types/meilisearch/documents';
export declare class ImageFeedService {
    private client;
    constructor(client: MeiliSearch);
    /**
     * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
     * Replicates the functionality of getImagesFromSearchPreFilter
     */
    getImagesFeed(input: ImageFeedInput): Promise<ImageFeedResponse>;
    /**
     * Augment feed results with detailed stats
     * This would integrate with the metrics system to get reaction breakdowns
     */
    private augmentWithStats;
    /**
     * Convert browsing level flags to NSFW level array
     */
    private getNsfwLevelsFromBrowsingLevel;
    /**
     * Snap timestamp to interval (for consistency with existing logic)
     */
    private snapToInterval;
    /**
     * Convert tool names to IDs (would need cache integration)
     */
    private convertToolNamesToIds;
    /**
     * Convert technique names to IDs (would need cache integration)
     */
    private convertTechniqueNamesToIds;
    /**
     * Convert tag names to IDs (would need cache integration)
     */
    private convertTagNamesToIds;
    /**
     * Validate that a filter attribute is configured for the index
     */
    validateFilterAttribute(attribute: string): boolean;
    /**
     * Validate that a sort attribute is configured for the index
     */
    validateSortAttribute(attribute: string): boolean;
}

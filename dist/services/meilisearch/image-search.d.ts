import type { IMeilisearchClient } from '../../types/package-stubs';
import type { ImageSearchInput } from '../../types/meilisearch/inputs';
import type { ImageSearchResponse } from '../../types/meilisearch/documents';
export declare class ImageSearchService {
    private client;
    constructor(client: IMeilisearchClient);
    /**
     * Search images using the METRICS_IMAGES_SEARCH_INDEX
     * Replicates the functionality of getImagesFromSearchPreFilter
     */
    searchImages(input: ImageSearchInput): Promise<ImageSearchResponse>;
    /**
     * Augment search results with detailed stats
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

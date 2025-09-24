import type { MeiliSearch } from 'meilisearch';
import type { ModelFeedInput } from '../../types/meilisearch/inputs';
import type { ModelFeedResponse } from '../../types/meilisearch/documents';
export declare class ModelFeedService {
    private client;
    constructor(client: MeiliSearch);
    /**
     * Get models feed using the METRICS_MODELS_SEARCH_INDEX
     * Replicates the functionality of getModelsRawMeili
     */
    getModelsFeed(input: ModelFeedInput): Promise<ModelFeedResponse>;
    /**
     * Convert browsing level flags to NSFW level array
     * Based on browsing level constants from the main app
     */
    private getNsfwLevelsFromBrowsingLevel;
    /**
     * Validate that a filter attribute is configured for the index
     */
    validateFilterAttribute(attribute: string): boolean;
    /**
     * Validate that a sort attribute is configured for the index
     */
    validateSortAttribute(attribute: string): boolean;
}

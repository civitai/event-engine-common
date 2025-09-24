import type { IMeilisearchClient } from '../../types/package-stubs';
import type { ModelSearchInput } from '../../types/meilisearch/inputs';
import type { ModelSearchResponse } from '../../types/meilisearch/documents';
export declare class ModelSearchService {
    private client;
    constructor(client: IMeilisearchClient);
    /**
     * Search models using the METRICS_MODELS_SEARCH_INDEX
     * Replicates the functionality of getModelsRawMeili
     */
    searchModels(input: ModelSearchInput): Promise<ModelSearchResponse>;
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

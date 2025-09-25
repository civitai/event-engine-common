import type { MeiliSearch } from 'meilisearch';
import type { ImageFeedInput } from '../../types/meilisearch/inputs';
import type { ImageFeedResponse } from '../../types/meilisearch/documents';
import { MetricService } from '../metrics';
export declare const makeMeiliImageSearchFilter: (field: string, criteria: string) => string;
export declare const makeMeiliImageSearchSort: (field: string, criteria: "asc" | "desc") => string;
export declare class ImageFeedService {
    private client;
    private metricsService;
    constructor(client: MeiliSearch, metricsService: MetricService);
    /**
     * Get images feed using the METRICS_IMAGES_SEARCH_INDEX
     * Exact replica of getImagesFromSearchPreFilter functionality
     */
    getImagesFeed(input: ImageFeedInput): Promise<ImageFeedResponse>;
    /**
     * Get image metrics object - replica of the main app function
     */
    private getImageMetricsObject;
    /**
     * Snap timestamp to interval (for consistency with existing logic)
     */
    private snapToInterval;
    /**
     * Validate that a filter attribute is configured for the index
     */
    validateFilterAttribute(attribute: string): boolean;
    /**
     * Validate that a sort attribute is configured for the index
     */
    validateSortAttribute(attribute: string): boolean;
}

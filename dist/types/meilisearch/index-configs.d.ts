export interface IndexConfig {
    searchableAttributes: string[];
    sortableAttributes: string[];
    filterableAttributes: string[];
    rankingRules?: string[];
}
export declare const MODELS_INDEX_CONFIG: IndexConfig;
export declare const METRICS_MODELS_INDEX_CONFIG: IndexConfig;
export declare const IMAGES_INDEX_CONFIG: IndexConfig;
export declare const METRICS_IMAGES_INDEX_CONFIG: IndexConfig;
export declare const INDEX_NAMES: {
    readonly MODELS: "feeds_models_v1";
    readonly IMAGES: "metrics_images_v1";
};
export type IndexName = typeof INDEX_NAMES[keyof typeof INDEX_NAMES];

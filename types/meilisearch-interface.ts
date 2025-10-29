/**
 * Meilisearch interface types
 *
 * These interfaces define the minimal Meilisearch API surface needed for the feed system,
 * allowing us to avoid a direct dependency on the meilisearch package in the common module.
 *
 * The actual MeiliSearch client from the library naturally satisfies these interfaces.
 * Usage: const client: IMeilisearch = new MeiliSearch({ host, apiKey })
 */

/**
 * Task status values from Meilisearch
 */
export type MeilisearchTaskStatus =
  | 'enqueued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * Enqueued task returned by methods that queue operations
 * This matches the EnqueuedTask type from meilisearch library
 */
export type MeilisearchTask = {
  taskUid: number;
  indexUid?: string | null;
  status: MeilisearchTaskStatus;
  type?: string;
  enqueuedAt: string;
};

/**
 * Full task details (returned when waiting for a task to complete)
 * Note: The library returns 'uid' for completed tasks, 'taskUid' for enqueued tasks
 */
export type MeilisearchFullTask = {
  uid: number; // Full task uses uid, not taskUid
  taskUid?: number; // Optional for compatibility
  indexUid?: string | null;
  status: MeilisearchTaskStatus;
  type?: string;
  enqueuedAt: string;
  batchUid?: number | null;
  canceledBy?: number | null;
  details?: Record<string, any>;
  error?: any | null;
  duration?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/**
 * Meilisearch settings type
 * Note: Using flexible types to match the actual Meilisearch library types
 */
export type MeilisearchSettings = {
  filterableAttributes?: any[] | null; // Can include GranularFilterableAttribute
  sortableAttributes?: string[] | null;
  searchableAttributes?: string[] | null;
  displayedAttributes?: string[] | null;
  rankingRules?: string[] | null;
  stopWords?: string[] | null;
  synonyms?: Record<string, any> | null;
  distinctAttribute?: string | null;
  [key: string]: any; // Allow additional properties
};

export type MeilisearchSearchOptions = {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  attributesToCrop?: string[];
};

/**
 * Hit type returned in search results
 * The actual library adds metadata fields to documents
 */
export type MeilisearchHit<T = Record<string, any>> = T & {
  _formatted?: Partial<T>;
  _matchesPosition?: any;
  _rankingScore?: number;
  _rankingScoreDetails?: any;
  _geo?: any;
};

/**
 * Search result type
 * Compatible with SearchResponse from meilisearch library
 */
export type MeilisearchSearchResult<T = Record<string, any>> = {
  hits: MeilisearchHit<T>[];
  estimatedTotalHits?: number;
  offset?: number;
  limit?: number;
  processingTimeMs?: number;
  query?: string;
  [key: string]: any; // Allow additional properties
};

export interface IMeilisearchIndex {
  /**
   * Update index settings
   */
  update(options: { primaryKey: string }): Promise<MeilisearchTask>;

  /**
   * Get current index settings
   */
  getSettings(): Promise<MeilisearchSettings>;

  /**
   * Update searchable attributes
   */
  updateSearchableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update sortable attributes
   */
  updateSortableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update filterable attributes
   */
  updateFilterableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update ranking rules
   */
  updateRankingRules(rules: string[]): Promise<MeilisearchTask>;

  /**
   * Update documents in the index
   */
  updateDocuments(documents: Array<Record<string, any>>, options?: { primaryKey?: string }): Promise<MeilisearchTask>;

  /**
   * Delete documents by IDs
   */
  deleteDocuments(ids: number[] | string[]): Promise<MeilisearchTask>;

  /**
   * Search documents
   * Note: Using flexible return type for compatibility
   */
  search<T = Record<string, any>>(
    query: string | null,
    options?: MeilisearchSearchOptions
  ): Promise<any>; // Use any for maximum compatibility
}

export interface IMeilisearch {
  /**
   * Get an existing index
   */
  getIndex(indexName: string): Promise<IMeilisearchIndex>;

  /**
   * Create a new index
   */
  createIndex(indexName: string, options?: { primaryKey?: string }): Promise<MeilisearchTask>;

  /**
   * Task client for waiting on tasks
   */
  tasks: {
    waitForTask(
      taskUid: number | MeilisearchTask,
      options?: { timeout?: number; interval?: number }
    ): Promise<MeilisearchFullTask>;
  };
}

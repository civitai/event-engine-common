/**
 * Barrel export for all feed modules
 * Import with: import * as feeds from '../common/feeds'
 */

export { ImageFeed } from './image.feed';
// Add other feeds as needed (ModelFeed, PostFeed, etc.)

// Export types
export type {
  FeedContext,
  FeedQueryInput,
  FeedAdvancedOptions,
  UpsertType,
  SchemaFieldType,
  FeedSchema,
  InferSchemaType,
  CreateFeedConfig,
} from './types';

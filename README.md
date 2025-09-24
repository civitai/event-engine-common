# Common Services

This directory contains shared services used throughout the metric event watcher application.

## Available Services

### MetricService (`services/metrics.ts`)

Handles fetching and caching of entity metrics from ClickHouse with Redis caching layer.

**Key Features:**
- Read-through cache with 24-hour TTL for found metrics, 5-minute TTL for misses
- Cache stampede prevention using distributed locks
- Batch fetching support for efficient database queries
- TTL sliding for hot cache entries (10% chance on access)
- Type-safe metric fetching with automatic inference based on entity type

**Methods:**
- `fetch<T>(entityType: T, ids: number[])` - Fetch metrics for multiple entities with caching
- `fetchTimeframes<T>(entityType: T, ids: number[])` - Fetch metrics broken down by time periods (Day, Week, Month, Year, AllTime)
- `bustCache<T>(entityType: T, ids: number | number[])` - Invalidate cached metrics for specific entities

**Usage Example:**
```typescript
const metricService = new MetricService(clickhouse, redis);

// Fetch article metrics
const articleMetrics = await metricService.fetch('Article', [1, 2, 3]);
// Returns: Record<number, ArticleMetrics>

// Fetch metrics with timeframes
const timeframeMetrics = await metricService.fetchTimeframes('Image', [4, 5, 6]);
// Returns: Record<number, Record<Timeframes, ImageMetrics>>

// Bust cache for updated entities
await metricService.bustCache('Model', [7, 8]);
```

### OutboxService (`services/outbox.ts`)

Manages outbox pattern for reliable event processing and entity state change tracking.

**Key Features:**
- Tracks entity lifecycle events (PUBLISHED, UNPUBLISHED, DELETED, UPDATED)
- Supports multiple entity types (Article, Image, Model, Post, ModelVersion)
- Simple PostgreSQL-based persistence

**Methods:**
- `add(record: OutboxRecord)` - Add a new outbox event
- `delete(id: number)` - Remove a processed outbox record

**Usage Example:**
```typescript
const outboxService = new OutboxService(pgClient);

// Add an event to the outbox
await outboxService.add({
    event: OutboxEvent.PUBLISHED,
    entityType: 'Article',
    entityId: 123
});

// Delete processed event
await outboxService.delete(recordId);
```

## Dependencies

Both services rely on the following common utilities and types:
- `utils/query-utils.ts` - Database client wrappers with helper methods
- `types/metric-types.ts` - Entity and metric type definitions
- `types/package-stubs.ts` - External package interface definitions
- `utils/cache-keys.ts` - Consistent Redis key generation
- `utils/basic.ts` - Basic utility functions (chunk, sleep, etc.)
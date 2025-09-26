import type {
  IDatabaseProvider,
  DatabaseUser,
  DatabaseUserEngagement,
  DatabaseImageEngagement,
} from '../../types/database';
import { logger } from '../../utils/logger';

// Abstract base class that provides common functionality
// Apps can extend this and implement the abstract methods with their specific database logic
export abstract class CommonDatabaseProvider implements IDatabaseProvider {
  protected componentName = 'DatabaseProvider';

  constructor() {
    logger.debug(this.componentName, 'CommonDatabaseProvider initialized');
  }

  // Abstract methods that apps must implement
  abstract findUserByUsername(username: string): Promise<DatabaseUser | null>;
  abstract findUserEngagements(userId: number, type: 'Follow'): Promise<DatabaseUserEngagement[]>;
  abstract findImageEngagements(userId: number, type: 'Hide'): Promise<DatabaseImageEngagement[]>;

  // Common utility methods that can be shared across implementations
  protected logQuery(operation: string, params: any): void {
    logger.debug(this.componentName, `Executing ${operation}:`, params);
  }

  protected logQueryResult(operation: string, resultCount: number, duration?: number): void {
    const durationStr = duration ? ` (${duration}ms)` : '';
    logger.debug(this.componentName, `${operation} completed: ${resultCount} results${durationStr}`);
  }

  protected handleQueryError(operation: string, error: any): void {
    logger.error(this.componentName, `${operation} failed:`, error);
  }
}



import type { IDatabaseProvider, DatabaseUser, DatabaseUserEngagement, DatabaseImageEngagement } from '../../types/database';
export declare abstract class CommonDatabaseProvider implements IDatabaseProvider {
    protected componentName: string;
    constructor();
    abstract findUserByUsername(username: string): Promise<DatabaseUser | null>;
    abstract findUserEngagements(userId: number, type: 'Follow'): Promise<DatabaseUserEngagement[]>;
    abstract findImageEngagements(userId: number, type: 'Hide'): Promise<DatabaseImageEngagement[]>;
    abstract isConnected(): Promise<boolean>;
    protected logQuery(operation: string, params: any): void;
    protected logQueryResult(operation: string, resultCount: number, duration?: number): void;
    protected handleQueryError(operation: string, error: any): void;
}

import { IPgClient } from '../types/package-stubs';
export declare enum OutboxEvent {
    PUBLISHED = "PUBLISHED",
    UNPUBLISHED = "UNPUBLISHED",
    DELETED = "DELETED",
    UPDATED = "UPDATED"
}
export type OutboxRecord = {
    id: number;
    event: OutboxEvent;
    entityType: 'Article' | 'Image' | 'Model' | 'Post' | 'ModelVersion';
    entityId: number;
    createdAt?: Date;
};
export declare class OutboxService {
    private pgClient;
    constructor(pgClient: IPgClient);
    add(record: Omit<OutboxRecord, 'createdAt'>): Promise<void>;
    delete(id: number): Promise<void>;
}

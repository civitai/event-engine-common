import { IPgClient } from '../types/package-stubs';

export enum OutboxEvent {
    PUBLISHED = 'PUBLISHED',
    UNPUBLISHED = 'UNPUBLISHED',
    DELETED = 'DELETED',
    UPDATED = 'UPDATED'
}

export type OutboxRecord = {
    id: number;
    event: OutboxEvent;
    entityType: 'Article' | 'Image' | 'Model' | 'Post' | 'ModelVersion';
    entityId: number;
    createdAt?: Date;
}

export class OutboxService {
    constructor(private pgClient: IPgClient) {}

    async add(record: Omit<OutboxRecord, 'createdAt'>): Promise<void> {
        const query = `
            INSERT INTO "Outbox" (event, "entityType", "entityId")
            VALUES ($1, $2, $3)
        `;

        await this.pgClient.query(query, [
            record.event,
            record.entityType,
            record.entityId
        ]);
    }

    async delete(id: number): Promise<void> {
        const query = `
            DELETE FROM "Outbox"
            WHERE id = $1
        `;
        await this.pgClient.query(query, [id]);
    }
}
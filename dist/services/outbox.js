"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxService = exports.OutboxEvent = void 0;
var OutboxEvent;
(function (OutboxEvent) {
    OutboxEvent["PUBLISHED"] = "PUBLISHED";
    OutboxEvent["UNPUBLISHED"] = "UNPUBLISHED";
    OutboxEvent["DELETED"] = "DELETED";
    OutboxEvent["UPDATED"] = "UPDATED";
    OutboxEvent["TO_SCAN"] = "TO_SCAN";
})(OutboxEvent || (exports.OutboxEvent = OutboxEvent = {}));
class OutboxService {
    constructor(pgClient) {
        this.pgClient = pgClient;
    }
    async add(record) {
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
    async delete(id) {
        const query = `
            DELETE FROM "Outbox"
            WHERE id = $1
        `;
        await this.pgClient.query(query, [id]);
    }
}
exports.OutboxService = OutboxService;

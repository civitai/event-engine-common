"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheKeys = void 0;
exports.cacheKeys = {
    metric: (entityType, id) => `metrics:${entityType}:${id}`,
    metricLock: (entityType, id) => `metrics:lock:${entityType}:${id}`
};

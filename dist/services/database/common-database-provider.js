"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommonDatabaseProvider = void 0;
const logger_1 = require("../../utils/logger");
// Abstract base class that provides common functionality
// Apps can extend this and implement the abstract methods with their specific database logic
class CommonDatabaseProvider {
    constructor() {
        this.componentName = 'DatabaseProvider';
        logger_1.logger.debug(this.componentName, 'CommonDatabaseProvider initialized');
    }
    // Common utility methods that can be shared across implementations
    logQuery(operation, params) {
        logger_1.logger.debug(this.componentName, `Executing ${operation}:`, params);
    }
    logQueryResult(operation, resultCount, duration) {
        const durationStr = duration ? ` (${duration}ms)` : '';
        logger_1.logger.debug(this.componentName, `${operation} completed: ${resultCount} results${durationStr}`);
    }
    handleQueryError(operation, error) {
        logger_1.logger.error(this.componentName, `${operation} failed:`, error);
    }
}
exports.CommonDatabaseProvider = CommonDatabaseProvider;

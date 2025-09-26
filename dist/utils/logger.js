"use strict";
// Environment-controlled logging utility
// Set DEBUG_EVENT_ENGINE=true or NODE_ENV=development to enable logging
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_LEVELS = exports.EventEngineLogger = exports.logger = void 0;
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};
exports.LOG_LEVELS = LOG_LEVELS;
class EventEngineLogger {
    constructor() {
        // Enable logging if DEBUG_EVENT_ENGINE is set or NODE_ENV is development
        this.enabled =
            process.env.DEBUG_EVENT_ENGINE === 'true' ||
                process.env.NODE_ENV === 'development' ||
                process.env.NODE_ENV === 'test';
        // Set log level from environment, default to DEBUG if enabled
        const envLogLevel = process.env.EVENT_ENGINE_LOG_LEVEL?.toUpperCase();
        this.logLevel = this.enabled ? (LOG_LEVELS[envLogLevel] ?? LOG_LEVELS.DEBUG) : LOG_LEVELS.ERROR;
        // Parse enabled components from environment
        // Format: DEBUG_EVENT_ENGINE_COMPONENTS=MetricService,ImageFeedService,Redis
        // If not set, all components are enabled by default
        const enabledComponentsEnv = process.env.DEBUG_EVENT_ENGINE_COMPONENTS;
        if (enabledComponentsEnv) {
            this.enabledComponents = new Set(enabledComponentsEnv.split(',').map(c => c.trim()));
        }
        else {
            // All components enabled by default
            this.enabledComponents = new Set(['*']);
        }
    }
    shouldLog(level, component) {
        if (!this.enabled || level < this.logLevel) {
            return false;
        }
        // If no component specified, use general enabled check
        if (!component) {
            return true;
        }
        // Check if specific component is enabled
        return this.enabledComponents.has('*') || this.enabledComponents.has(component);
    }
    formatMessage(component, message, ...args) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${component}] ${message}`;
    }
    debug(component, message, ...args) {
        if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
            console.debug(this.formatMessage(component, message), ...args);
        }
    }
    info(component, message, ...args) {
        if (this.shouldLog(LOG_LEVELS.INFO, component)) {
            console.info(this.formatMessage(component, message), ...args);
        }
    }
    warn(component, message, ...args) {
        if (this.shouldLog(LOG_LEVELS.WARN, component)) {
            console.warn(this.formatMessage(component, message), ...args);
        }
    }
    error(component, message, ...args) {
        if (this.shouldLog(LOG_LEVELS.ERROR, component)) {
            console.error(this.formatMessage(component, message), ...args);
        }
    }
    // Convenience methods for common use cases
    metric(message, ...args) {
        this.debug('MetricService', message, ...args);
    }
    redis(message, ...args) {
        this.debug('RedisHelpers', message, ...args);
    }
    clickhouse(message, ...args) {
        this.debug('ClickHouse', message, ...args);
    }
    imageFeed(message, ...args) {
        this.debug('ImageFeedService', message, ...args);
    }
    // Performance timing helpers
    time(component, label) {
        if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
            console.time(this.formatMessage(component, label));
        }
    }
    timeEnd(component, label) {
        if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
            console.timeEnd(this.formatMessage(component, label));
        }
    }
    // Structured logging for complex objects
    logObject(component, message, obj) {
        if (this.shouldLog(LOG_LEVELS.DEBUG, component)) {
            this.debug(component, message);
            console.table(obj);
        }
    }
    // Check if logging is enabled (useful for expensive operations)
    get isEnabled() {
        return this.enabled;
    }
    get isDebugEnabled() {
        return this.shouldLog(LOG_LEVELS.DEBUG);
    }
    // Check if specific component is enabled
    isComponentEnabled(component) {
        return this.shouldLog(LOG_LEVELS.DEBUG, component);
    }
}
exports.EventEngineLogger = EventEngineLogger;
// Export singleton instance
exports.logger = new EventEngineLogger();

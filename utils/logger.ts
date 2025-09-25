// Environment-controlled logging utility
// Set DEBUG_EVENT_ENGINE=true or NODE_ENV=development to enable logging

interface LogLevel {
  DEBUG: number;
  INFO: number;
  WARN: number;
  ERROR: number;
}

const LOG_LEVELS: LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class EventEngineLogger {
  private enabled: boolean;
  private logLevel: number;

  constructor() {
    // Enable logging if DEBUG_EVENT_ENGINE is set or NODE_ENV is development
    this.enabled =
      process.env.DEBUG_EVENT_ENGINE === 'true' ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test';

    // Set log level from environment, default to DEBUG if enabled
    const envLogLevel = process.env.EVENT_ENGINE_LOG_LEVEL?.toUpperCase() as keyof LogLevel;
    this.logLevel = this.enabled ? (LOG_LEVELS[envLogLevel] ?? LOG_LEVELS.DEBUG) : LOG_LEVELS.ERROR;
  }

  private shouldLog(level: number): boolean {
    return this.enabled && level >= this.logLevel;
  }

  private formatMessage(component: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${component}] ${message}`;
  }

  debug(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      console.debug(this.formatMessage(component, message), ...args);
    }
  }

  info(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.INFO)) {
      console.info(this.formatMessage(component, message), ...args);
    }
  }

  warn(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.WARN)) {
      console.warn(this.formatMessage(component, message), ...args);
    }
  }

  error(component: string, message: string, ...args: any[]): void {
    if (this.shouldLog(LOG_LEVELS.ERROR)) {
      console.error(this.formatMessage(component, message), ...args);
    }
  }

  // Convenience methods for common use cases
  metric(message: string, ...args: any[]): void {
    this.debug('MetricService', message, ...args);
  }

  redis(message: string, ...args: any[]): void {
    this.debug('RedisHelpers', message, ...args);
  }

  clickhouse(message: string, ...args: any[]): void {
    this.debug('ClickHouse', message, ...args);
  }

  // Performance timing helpers
  time(component: string, label: string): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      console.time(this.formatMessage(component, label));
    }
  }

  timeEnd(component: string, label: string): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      console.timeEnd(this.formatMessage(component, label));
    }
  }

  // Structured logging for complex objects
  logObject(component: string, message: string, obj: any): void {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      this.debug(component, message);
      console.table(obj);
    }
  }

  // Check if logging is enabled (useful for expensive operations)
  get isEnabled(): boolean {
    return this.enabled;
  }

  get isDebugEnabled(): boolean {
    return this.shouldLog(LOG_LEVELS.DEBUG);
  }
}

// Export singleton instance
export const logger = new EventEngineLogger();

// Export for testing/configuration
export { EventEngineLogger, LOG_LEVELS };
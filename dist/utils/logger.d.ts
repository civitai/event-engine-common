interface LogLevel {
    DEBUG: number;
    INFO: number;
    WARN: number;
    ERROR: number;
}
declare const LOG_LEVELS: LogLevel;
declare class EventEngineLogger {
    private enabled;
    private logLevel;
    private enabledComponents;
    constructor();
    private shouldLog;
    private formatMessage;
    debug(component: string, message: string, ...args: any[]): void;
    info(component: string, message: string, ...args: any[]): void;
    warn(component: string, message: string, ...args: any[]): void;
    error(component: string, message: string, ...args: any[]): void;
    metric(message: string, ...args: any[]): void;
    redis(message: string, ...args: any[]): void;
    clickhouse(message: string, ...args: any[]): void;
    imageFeed(message: string, ...args: any[]): void;
    time(component: string, label: string): void;
    timeEnd(component: string, label: string): void;
    logObject(component: string, message: string, obj: any): void;
    get isEnabled(): boolean;
    get isDebugEnabled(): boolean;
    isComponentEnabled(component: string): boolean;
}
export declare const logger: EventEngineLogger;
export { EventEngineLogger, LOG_LEVELS };

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleClickhouse = void 0;
exports.withRedisHelpers = withRedisHelpers;
const logger_1 = require("./logger");
class SimpleClickhouse {
    constructor(ch) {
        this.ch = ch;
    }
    async query(query, ...values) {
        if (typeof query !== 'string') {
            query = query.reduce((acc, part, i) => acc + part + this.formatSqlType(values[i] ?? ''), '');
        }
        const response = await this.ch.query({
            query,
            format: 'JSONEachRow',
        });
        const data = await response?.json();
        return data;
    }
    formatSqlType(value) {
        // Catch any dates being passed in as a string
        if (typeof value === 'string' && (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))) {
            value = new Date(value);
        }
        if (value instanceof Date)
            return "parseDateTimeBestEffort('" + value.toISOString() + "')";
        if (typeof value === 'object') {
            if (Array.isArray(value))
                return value.map(this.formatSqlType).join(',');
            if (value === null)
                return 'null';
            return JSON.stringify(value);
        }
        return value;
    }
}
exports.SimpleClickhouse = SimpleClickhouse;
const redisHelpers = (redis) => ({
    async setNxKeepTtlWithEx(key, value, ttl) {
        const script = `
            if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'KEEPTTL') then
              return redis.call('EXPIRE', KEYS[1], ARGV[2])
            else
              return 0
            end
          `;
        const result = await redis.eval(script, { keys: [key], arguments: [value, String(ttl)] });
        return result === 1;
    },
    async hSetEx(key, fields, ttl) {
        logger_1.logger.redis(`hSetEx called for key: ${key}, fields: ${Object.keys(fields).length}, ttl: ${ttl}`);
        try {
            // Use pipeline instead of multi to avoid potential transaction issues
            const pipeline = redis.multi();
            pipeline.hSet(key, fields);
            pipeline.expire(key, ttl);
            logger_1.logger.redis(`Executing hSetEx pipeline for key: ${key}`);
            const result = await pipeline.exec();
            logger_1.logger.redis(`hSetEx completed for key: ${key}`);
            return result;
        }
        catch (error) {
            logger_1.logger.error('RedisHelpers', `hSetEx failed for key: ${key}:`, error);
            // Try alternative approach: separate commands
            logger_1.logger.redis(`Trying separate commands for key: ${key}`);
            try {
                await redis.hSet(key, fields);
                await redis.expire(key, ttl);
                logger_1.logger.redis(`Separate commands succeeded for key: ${key}`);
                return [[null, 'OK'], [null, 1]]; // Mimic multi result format
            }
            catch (fallbackError) {
                logger_1.logger.error('RedisHelpers', `Fallback commands also failed for key: ${key}:`, fallbackError);
                throw fallbackError;
            }
        }
    },
    async run(ops) {
        logger_1.logger.redis(`run() called with ${ops.length} operations`);
        try {
            const results = await Promise.all(ops);
            logger_1.logger.redis('run() completed successfully');
            return results;
        }
        catch (error) {
            logger_1.logger.error('RedisHelpers', 'run() failed:', error);
            logger_1.logger.error('RedisHelpers', 'Operations types:', ops.map(op => op.constructor.name));
            throw error;
        }
    },
});
function withRedisHelpers(redis) {
    const helpers = redisHelpers(redis);
    logger_1.logger.redis('Creating proxy for Redis client');
    logger_1.logger.redis('Original client type:', typeof redis);
    logger_1.logger.redis('Helpers:', Object.keys(helpers));
    return new Proxy(redis, {
        get(target, prop, receiver) {
            if (logger_1.logger.isDebugEnabled) {
                logger_1.logger.redis(`Accessing property: ${String(prop)}`);
            }
            if (prop in helpers) {
                if (logger_1.logger.isDebugEnabled) {
                    logger_1.logger.redis(`Using helper for: ${String(prop)}`);
                }
                return helpers[prop];
            }
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function') {
                if (logger_1.logger.isDebugEnabled) {
                    logger_1.logger.redis(`Binding function: ${String(prop)}`);
                }
                return function (...args) {
                    if (logger_1.logger.isDebugEnabled) {
                        logger_1.logger.redis(`Calling ${String(prop)} with args:`, args.length);
                    }
                    try {
                        return val.apply(target, args);
                    }
                    catch (error) {
                        logger_1.logger.error('withRedisHelpers', `Function ${String(prop)} threw error:`, error);
                        throw error;
                    }
                };
            }
            return val;
        },
    });
}

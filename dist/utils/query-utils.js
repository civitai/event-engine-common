"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleClickhouse = void 0;
exports.withRedisHelpers = withRedisHelpers;
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
        console.log(`[RedisHelpers] hSetEx called for key: ${key}, fields: ${Object.keys(fields).length}, ttl: ${ttl}`);
        try {
            // Use pipeline instead of multi to avoid potential transaction issues
            const pipeline = redis.multi();
            pipeline.hSet(key, fields);
            pipeline.expire(key, ttl);
            console.log(`[RedisHelpers] Executing hSetEx pipeline for key: ${key}`);
            const result = await pipeline.exec();
            console.log(`[RedisHelpers] hSetEx completed for key: ${key}`);
            return result;
        }
        catch (error) {
            console.error(`[RedisHelpers] hSetEx failed for key: ${key}:`, error);
            // Try alternative approach: separate commands
            console.log(`[RedisHelpers] Trying separate commands for key: ${key}`);
            try {
                await redis.hSet(key, fields);
                await redis.expire(key, ttl);
                console.log(`[RedisHelpers] Separate commands succeeded for key: ${key}`);
                return [[null, 'OK'], [null, 1]]; // Mimic multi result format
            }
            catch (fallbackError) {
                console.error(`[RedisHelpers] Fallback commands also failed for key: ${key}:`, fallbackError);
                throw fallbackError;
            }
        }
    },
    async run(ops) {
        console.log(`[RedisHelpers] run() called with ${ops.length} operations`);
        try {
            const results = await Promise.all(ops);
            console.log(`[RedisHelpers] run() completed successfully`);
            return results;
        }
        catch (error) {
            console.error(`[RedisHelpers] run() failed:`, error);
            console.error(`[RedisHelpers] Operations types:`, ops.map(op => op.constructor.name));
            throw error;
        }
    },
});
function withRedisHelpers(redis) {
    const helpers = redisHelpers(redis);
    console.log(`[withRedisHelpers] Creating proxy for Redis client`);
    console.log(`[withRedisHelpers] Original client type:`, typeof redis);
    console.log(`[withRedisHelpers] Helpers:`, Object.keys(helpers));
    return new Proxy(redis, {
        get(target, prop, receiver) {
            console.log(`[withRedisHelpers] Accessing property: ${String(prop)}`);
            if (prop in helpers) {
                console.log(`[withRedisHelpers] Using helper for: ${String(prop)}`);
                return helpers[prop];
            }
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function') {
                console.log(`[withRedisHelpers] Binding function: ${String(prop)}`);
                return function (...args) {
                    console.log(`[withRedisHelpers] Calling ${String(prop)} with args:`, args.length);
                    try {
                        return val.apply(target, args);
                    }
                    catch (error) {
                        console.error(`[withRedisHelpers] Function ${String(prop)} threw error:`, error);
                        throw error;
                    }
                };
            }
            return val;
        },
    });
}

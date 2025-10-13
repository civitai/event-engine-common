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
const redisHelpers = (redis) => {
    const scripts = {
        nxWithTtl: `
      if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'KEEPTTL') then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
        return 0
      end
    `,
        hIncrIfExists: `
      if redis.call('EXISTS', KEYS[1]) == 1 then
        return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
      else
        return 0
      end
    `,
    };
    const scriptShas = {};
    const loadScripts = async () => {
        for (const [name, script] of Object.entries(scripts)) {
            if ('masters' in redis) {
                const cluster = redis;
                const masters = cluster.masters ? Object.values(cluster.masters) : [];
                for (const master of masters) {
                    const sha = await master.client.sendCommand?.(['SCRIPT', 'LOAD', script.trim()]);
                    if (sha)
                        scriptShas[name] = sha;
                }
            }
            else {
                const sha = await redis.sendCommand?.(['SCRIPT', 'LOAD', script.trim()]);
                if (sha)
                    scriptShas[name] = sha;
            }
        }
    };
    const addScripts = (redis) => {
        const executeScript = async (name, keys, args) => {
            const sha = scriptShas[name];
            if (!sha)
                return await redis.eval(scripts[name], { keys, arguments: args });
            else
                return redis.evalSha(sha, { keys, arguments: args });
        };
        return {
            async setNxKeepTtlWithEx(key, value, ttl) {
                const result = await executeScript('nxWithTtl', [key], [value, String(ttl)]);
                return result === 1;
            },
            async hIncrIfExists(key, field, incrBy = 1) {
                const result = await executeScript('hIncrIfExists', [key], [field, incrBy.toString()]);
                return result !== 0;
            },
        };
    };
    const helpers = {
        async hSetEx(key, fields, ttl) {
            return redis.multi().hSet(key, fields).expire(key, ttl).exec();
        },
        async run(ops) {
            return Promise.all(ops);
        },
        ...addScripts(redis),
    };
    return { ...helpers, loadScripts, addScripts };
};
function withRedisHelpers(redis) {
    const { addScripts, ...helpers } = redisHelpers(redis);
    return new Proxy(redis, {
        get(target, prop, receiver) {
            // Return helper functions if available
            if (prop in helpers)
                return helpers[prop];
            // Special handling for multi() to include all helpers in the pipeline
            if (prop === 'multi') {
                return () => {
                    const multi = target.multi();
                    const scripts = addScripts(multi);
                    // Create proxy for multi that includes all available multi helpers
                    return new Proxy(multi, {
                        get(multiTarget, multiProp) {
                            // Check if this is a multi-compatible helper
                            if (multiProp in scripts)
                                return scripts[multiProp];
                            // Return original multi methods
                            const val = Reflect.get(multiTarget, multiProp);
                            return typeof val === 'function' ? val.bind(multiTarget) : val;
                        }
                    });
                };
            }
            // Default behavior for other properties
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

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
        return redis.multi().hSet(key, fields).expire(key, ttl).exec();
    },
    async run(ops) {
        return Promise.all(ops);
    },
});
function withRedisHelpers(redis) {
    const helpers = redisHelpers(redis);
    return new Proxy(redis, {
        get(target, prop, receiver) {
            if (prop in helpers)
                return helpers[prop];
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
        },
    });
}

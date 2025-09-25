import { IClickhouseClient, IRedisClient } from '../types/package-stubs';

export class SimpleClickhouse {
  constructor(private ch: IClickhouseClient) {}

  public async query<T extends object>(query: TemplateStringsArray | string, ...values: any[]): Promise<T[]> {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + this.formatSqlType(values[i] ?? ''), '');
    }

    const response = await this.ch.query({
      query,
      format: 'JSONEachRow',
    });
    const data = await response?.json<T>();
    return data as T[];
  }

  private formatSqlType(value: any): string {
    // Catch any dates being passed in as a string

    
    if (typeof value === 'string' && (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))) {
      value = new Date(value);
    }
    if (value instanceof Date) return "parseDateTimeBestEffort('" + value.toISOString() + "')";
    if (typeof value === 'object') {
      if (Array.isArray(value)) return value.map(this.formatSqlType).join(',');
      if (value === null) return 'null';
      return JSON.stringify(value);
    }

    return value;
  }
}

const redisHelpers = (redis: IRedisClient) => ({
  async setNxKeepTtlWithEx(key: string, value: string, ttl: number) {
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
  async hSetEx(key: string, fields: Record<string, string>, ttl: number) {
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
    } catch (error) {
      console.error(`[RedisHelpers] hSetEx failed for key: ${key}:`, error);
      // Try alternative approach: separate commands
      console.log(`[RedisHelpers] Trying separate commands for key: ${key}`);
      try {
        await redis.hSet(key, fields);
        await redis.expire(key, ttl);
        console.log(`[RedisHelpers] Separate commands succeeded for key: ${key}`);
        return [[null, 'OK'], [null, 1]]; // Mimic multi result format
      } catch (fallbackError) {
        console.error(`[RedisHelpers] Fallback commands also failed for key: ${key}:`, fallbackError);
        throw fallbackError;
      }
    }
  },
  async run<T>(ops: Promise<T>[]) {
    console.log(`[RedisHelpers] run() called with ${ops.length} operations`);
    try {
      const results = await Promise.all(ops);
      console.log(`[RedisHelpers] run() completed successfully`);
      return results;
    } catch (error) {
      console.error(`[RedisHelpers] run() failed:`, error);
      console.error(`[RedisHelpers] Operations types:`, ops.map(op => op.constructor.name));
      throw error;
    }
  },
});

export type RedisWithHelpers = IRedisClient & ReturnType<typeof redisHelpers>;

export function withRedisHelpers(redis: IRedisClient): RedisWithHelpers {
  const helpers = redisHelpers(redis);
  console.log(`[withRedisHelpers] Creating proxy for Redis client`);
  console.log(`[withRedisHelpers] Original client type:`, typeof redis);
  console.log(`[withRedisHelpers] Helpers:`, Object.keys(helpers));

  return new Proxy(redis as RedisWithHelpers, {
    get(target, prop, receiver) {
      console.log(`[withRedisHelpers] Accessing property: ${String(prop)}`);

      if (prop in helpers) {
        console.log(`[withRedisHelpers] Using helper for: ${String(prop)}`);
        return (helpers as any)[prop];
      }

      const val = Reflect.get(target as object, prop, receiver);
      if (typeof val === 'function') {
        console.log(`[withRedisHelpers] Binding function: ${String(prop)}`);
        return function(...args: any[]) {
          console.log(`[withRedisHelpers] Calling ${String(prop)} with args:`, args.length);
          try {
            return val.apply(target, args);
          } catch (error) {
            console.error(`[withRedisHelpers] Function ${String(prop)} threw error:`, error);
            throw error;
          }
        };
      }
      return val;
    },
  });
}

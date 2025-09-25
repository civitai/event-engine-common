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
    return redis.multi().hSet(key, fields).expire(key, ttl).exec();
  },
  async run<T>(ops: Promise<T>[]) {
    return Promise.all(ops);
  },
});

export type RedisWithHelpers = IRedisClient & ReturnType<typeof redisHelpers>;

export function withRedisHelpers(redis: IRedisClient): RedisWithHelpers {
  const helpers = redisHelpers(redis);
  return new Proxy(redis as RedisWithHelpers, {
    get(target, prop, receiver) {
      if (prop in helpers) return (helpers as any)[prop];
      const val = Reflect.get(target as object, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

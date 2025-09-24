import { IClickhouseClient, IRedisClient } from '../types/package-stubs';
export declare class SimpleClickhouse {
    private ch;
    constructor(ch: IClickhouseClient);
    query<T extends object>(query: TemplateStringsArray | string, ...values: any[]): Promise<T[]>;
    private formatSqlType;
}
declare const redisHelpers: (redis: IRedisClient) => {
    setNxKeepTtlWithEx(key: string, value: string, ttl: number): Promise<boolean>;
    hSetEx(key: string, fields: Record<string, string>, ttl: number): Promise<any[]>;
    run<T>(ops: Promise<T>[]): Promise<Awaited<T>[]>;
};
export type RedisWithHelpers = IRedisClient & ReturnType<typeof redisHelpers>;
export declare function withRedisHelpers(redis: IRedisClient): RedisWithHelpers;
export {};

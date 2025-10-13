import { IClickhouseClient, IRedisClient, IRedisMulti } from '../types/package-stubs';
export declare class SimpleClickhouse {
    private ch;
    constructor(ch: IClickhouseClient);
    query<T extends object>(query: TemplateStringsArray | string, ...values: any[]): Promise<T[]>;
    private formatSqlType;
}
declare const redisHelpers: (redis: IRedisClient) => {
    loadScripts: () => Promise<void>;
    addScripts: (redis: IRedisClient | IRedisMulti) => {
        setNxKeepTtlWithEx(key: string, value: string, ttl: number): Promise<boolean>;
        hIncrIfExists(key: string, field: string, incrBy?: number): Promise<boolean>;
    };
    setNxKeepTtlWithEx(key: string, value: string, ttl: number): Promise<boolean>;
    hIncrIfExists(key: string, field: string, incrBy?: number): Promise<boolean>;
    hSetEx(key: string, fields: Record<string, string>, ttl: number): Promise<any[]>;
    run<T>(ops: Promise<T>[]): Promise<Awaited<T>[]>;
};
export type RedisWithHelpers<TRedis extends IRedisClient = IRedisClient> = Omit<TRedis, 'multi'> & Omit<ReturnType<typeof redisHelpers>, 'addScripts'> & {
    multi: () => MultiWithHelpers<TRedis>;
};
type ExtractMultiType<T> = T extends {
    multi(): infer M;
} ? M : IRedisMulti;
export type MultiWithHelpers<TRedis extends IRedisClient> = ExtractMultiType<TRedis> & ReturnType<ReturnType<typeof redisHelpers>['addScripts']>;
export declare function withRedisHelpers<TRedis extends IRedisClient>(redis: TRedis): RedisWithHelpers<TRedis>;
export {};

export interface IPgClient {
  query<R extends Record<string, any> = any, I = any[]>(
    queryTextOrConfig: string | { text: string; values?: I },
    values?: I
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
  }>;
}

export interface IClickhouseClient {
  query(params: {
    query: string;
    format?: string;
    clickhouse_settings?: Record<string, any>;
    query_params?: Record<string, unknown>;
    abort_signal?: AbortSignal;
    query_id?: string;
    session_id?: string;
  }): Promise<{ json<T>(): Promise<T> }>;
}

// Define each command as [args, returnType]
// If a command has overloads, use a union of signatures
type RedisCommands = {
  hSet: [[key: string, field: string, value: string], number] | [[key: string, fields: Record<string, string>], number];

  hGet: [[key: string, field: string], string | null];
  hGetAll: [[key: string], Record<string, string>];
  hIncrBy: [[key: string, field: string, increment: number], number];
  expire: [[key: string, seconds: number], boolean];
  set: [[key: string, value: string, options?: { EX: number }], 'OK' | null];
  sendCommand: [[args: string[]], any];
  del: [[keys: string | string[]], number];
  setNX: [[key: string, value: string, options?: { EX: number }], boolean];
  eval: [[script: string, options: { keys: string[]; arguments: string[] }], any];
};

// Utility to map commands into client methods
type ToClient<T extends Record<string, any>> = {
  [K in keyof T]: T[K] extends [infer A, infer R]
    ? (...args: A extends any[] ? A : never) => Promise<R>
    : T[K] extends [infer A1, infer R1] | [infer A2, infer R2]
    ? ((...args: A1 extends any[] ? A1 : never) => Promise<R1>) & ((...args: A2 extends any[] ? A2 : never) => Promise<R2>)
    : never;
};

// Utility to map commands into multi methods
type ToMulti<T extends Record<string, any>> = {
  [K in keyof T]: T[K] extends [infer A, any]
    ? (...args: A extends any[] ? A : never) => IRedisMulti
    : T[K] extends [infer A1, any] | [infer A2, any]
    ? ((...args: A1 extends any[] ? A1 : never) => IRedisMulti) & ((...args: A2 extends any[] ? A2 : never) => IRedisMulti)
    : never;
};

export interface IRedisClient extends ToClient<RedisCommands> {
  multi(): IRedisMulti;
}

export interface IRedisMulti extends ToMulti<RedisCommands> {
  exec(): Promise<any[]>;
}

export interface IMeilisearchClient {
  // TODO luis: stub the Meilisearch client
  // createOrUpdate
  // delete
}

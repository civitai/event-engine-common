// Tests for MetricServiceOptions.neverLowerRecentPopulate: the populate's cache write, run as
// real Lua against a real Redis.
//
// This repo has no test runner or dependencies of its own, so this file uses only Node built-ins
// (node:test, node:assert, node:net) and needs a throwaway Redis:
//
//   redis-server --port 6390 --save '' --appendonly no &
//   REDIS_URL=redis://127.0.0.1:6390 npx -y tsx --test services/metrics.never-lower.test.ts
//
// It only touches keys for the ids below, but point it at a Redis you don't mind writing to.
// tsconfig.json excludes *.test.ts, so this file is not part of the published build.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MetricService } from './metrics';
import { cacheKeys, METRIC_RECENT_EVENT_TTL } from '../utils/cache-keys';
import type { IClickhouseClient, IRedisClient } from '../types/package-stubs';

// The populate's stamp and TTLs, as MetricService defines them (literal on purpose: a test must
// not derive its expectation from the code under test).
const REFRESH_AFTER = 60 * 60;
const CACHE_TTL = 12 * 60 * 60;
const MISS_CACHE_TTL = 5 * 60;

// The existing replace script, byte for byte. Other implementations pin this text, so with the
// option off the populate must still send exactly this.
const H_REPLACE_STAMPED_EX = `
      redis.call('DEL', KEYS[1])
      local stamp = ARGV[3]
      if redis.call('EXISTS', KEYS[2]) == 1 then stamp = ARGV[4] end
      redis.call('HSET', KEYS[1], ARGV[2], stamp, unpack(ARGV, 5))
      return redis.call('EXPIRE', KEYS[1], ARGV[1])
    `;

// ---------------------------------------------------------------------------------------------
// A minimal RESP2 client: just the commands MetricService's populate path uses.

type Reply = string | number | null | Reply[];

class Resp {
  private buf = Buffer.alloc(0);
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  private constructor(private sock: net.Socket) {
    sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const parsed = this.parse(0);
        if (!parsed) break;
        this.buf = this.buf.subarray(parsed.end);
        const waiter = this.waiting.shift();
        if (!waiter) continue;
        if (parsed.value instanceof Error) waiter.reject(parsed.value);
        else waiter.resolve(parsed.value);
      }
    });
  }

  static connect(url: string): Promise<Resp> {
    const { hostname, port } = new URL(url);
    return new Promise((resolve, reject) => {
      const sock = net.connect(Number(port || 6379), hostname, () => resolve(new Resp(sock)));
      sock.once('error', reject);
    });
  }

  send(args: (string | number)[]): Promise<Reply> {
    const parts = args.map(String);
    let out = `*${parts.length}\r\n`;
    for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.sock.write(out);
    });
  }

  close() {
    this.sock.end();
  }

  private parse(at: number): { value: Reply | Error; end: number } | undefined {
    const lineEnd = this.buf.indexOf('\r\n', at);
    if (lineEnd < 0) return undefined;
    const type = String.fromCharCode(this.buf[at]);
    const line = this.buf.toString('utf8', at + 1, lineEnd);
    const next = lineEnd + 2;
    if (type === '+') return { value: line, end: next };
    if (type === '-') return { value: new Error(line), end: next };
    if (type === ':') return { value: Number(line), end: next };
    if (type === '$') {
      const len = Number(line);
      if (len < 0) return { value: null, end: next };
      if (this.buf.length < next + len + 2) return undefined;
      return { value: this.buf.toString('utf8', next, next + len), end: next + len + 2 };
    }
    if (type === '*') {
      const count = Number(line);
      if (count < 0) return { value: null, end: next };
      const items: Reply[] = [];
      let pos = next;
      for (let i = 0; i < count; i++) {
        const item = this.parse(pos);
        if (!item) return undefined;
        if (item.value instanceof Error) return item;
        items.push(item.value);
        pos = item.end;
      }
      return { value: items, end: pos };
    }
    throw new Error(`unexpected RESP type ${type}`);
  }
}

// ---------------------------------------------------------------------------------------------

let resp: Resp;
// Every script the populate sent, in order.
const evaluated: string[] = [];

const toHash = (reply: Reply): Record<string, string> => {
  const flat = reply as string[];
  const hash: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) hash[flat[i]] = flat[i + 1];
  return hash;
};

function redisClient(): IRedisClient {
  const client = {
    hGetAll: async (key: string) => toHash(await resp.send(['HGETALL', key])),
    hGet: async (key: string, field: string) => resp.send(['HGET', key, field]),
    get: async (key: string) => resp.send(['GET', key]),
    set: async (key: string, value: string, options?: { EX?: number }) =>
      resp.send(options?.EX ? ['SET', key, value, 'EX', options.EX] : ['SET', key, value]),
    del: async (key: string) => resp.send(['DEL', key]),
    expire: async (key: string, seconds: number) => resp.send(['EXPIRE', key, seconds]),
    eval: async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      evaluated.push(script);
      return resp.send(['EVAL', script, keys.length, ...keys, ...args]);
    },
    evalSha: async () => {
      throw new Error('scripts are not preloaded in these tests');
    },
    multi: () => {
      throw new Error('the populate path does not use multi');
    },
  };
  return client as unknown as IRedisClient;
}

// Answers the populate's lookup with `snapshot` for whichever of its ids are queried.
function clickhouse(snapshot: Record<number, Record<string, number>>): IClickhouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      const ids = (/entityId IN \(([^)]*)\)/.exec(query)?.[1] ?? '').split(',').map(Number);
      const rows = ids.flatMap((id) =>
        Object.entries(snapshot[id] ?? {}).map(([metricType, value]) => ({ entityId: id, metricType, value }))
      );
      return { json: async () => rows, text: async () => '', stream: () => null };
    },
  } as unknown as IClickhouseClient;
}

const ID = 424242;
const key = cacheKeys.metric('Image', ID);
const marker = cacheKeys.metricRecentEvent('Image', ID);
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function seed(hash: Record<string, string>, withMarker: boolean) {
  await resp.send(['HSET', key, ...Object.entries(hash).flat()]);
  await resp.send(['EXPIRE', key, 999]);
  if (withMarker) await resp.send(['SET', marker, '1', 'EX', METRIC_RECENT_EVENT_TTL]);
}

// Runs one populate of ID and returns the written hash, its TTL, and the stamp window.
async function populate(neverLowerRecentPopulate: boolean | undefined, snapshot: Record<string, number> | null) {
  const options = neverLowerRecentPopulate === undefined ? undefined : { neverLowerRecentPopulate };
  const service = new MetricService(clickhouse(snapshot ? { [ID]: snapshot } : {}), redisClient(), options);
  const before = nowSeconds();
  await (service as unknown as { populate(t: string, ids: number[]): Promise<unknown> }).populate('Image', [ID]);
  const after = nowSeconds();
  const hash = toHash(await resp.send(['HGETALL', key]));
  const ttl = (await resp.send(['TTL', key])) as number;
  return { hash, ttl, before, after };
}

// The stamp a populate writes: now, or (marker present) aged so it refreshes once the marker lapses.
function assertStamp(stamp: string, before: number, after: number, markerPresent: boolean) {
  const offset = markerPresent ? -REFRESH_AFTER + METRIC_RECENT_EVENT_TTL : 0;
  const value = Number(stamp);
  assert.ok(
    value >= before + offset && value <= after + offset,
    `_populatedAt ${stamp} not in [${before + offset}, ${after + offset}]`
  );
}

const withoutStamp = (hash: Record<string, string>) => {
  const { _populatedAt, ...rest } = hash;
  return rest;
};

describe('MetricService populate: neverLowerRecentPopulate', () => {
  before(async () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is not set; these tests need a throwaway Redis (see the header)');
    resp = await Resp.connect(url);
  });
  after(async () => {
    await resp.send(['DEL', key, marker]);
    resp.close();
  });
  beforeEach(async () => {
    evaluated.length = 0;
    await resp.send(['DEL', key, marker]);
  });

  describe('option off (the default)', () => {
    for (const option of [undefined, false]) {
      it(`replaces the entry and sends the existing script unchanged (option ${option})`, async () => {
        await seed({ Like: '9', Heart: '4', Cry: '1' }, true);

        const { hash, ttl, before, after } = await populate(option, { Like: 5, Heart: 7 });

        assert.deepEqual(withoutStamp(hash), { Like: '5', Heart: '7' });
        assertStamp(hash._populatedAt, before, after, true);
        assert.ok(ttl > CACHE_TTL - 5 && ttl <= CACHE_TTL, `ttl ${ttl}`);
        assert.deepEqual(evaluated, [H_REPLACE_STAMPED_EX]);
      });
    }
  });

  describe('option on, recent-event marker present', () => {
    it('never lowers a field, raises a lower one, keeps fields the snapshot lacks', async () => {
      await seed({ Like: '9', Heart: '4', Cry: '1', _populatedAt: '123' }, true);

      const { hash, ttl, before, after } = await populate(true, { Like: 5, Heart: 7 });

      // Like: cached 9 > snapshot 5, kept. Heart: snapshot 7 > cached 4, raised. Cry: kept.
      assert.deepEqual(withoutStamp(hash), { Like: '9', Heart: '7', Cry: '1' });
      assertStamp(hash._populatedAt, before, after, true);
      assert.ok(ttl > CACHE_TTL - 5 && ttl <= CACHE_TTL, `ttl ${ttl}`);
      assert.equal(evaluated.length, 1);
      assert.notEqual(evaluated[0], H_REPLACE_STAMPED_EX);
    });

    it('writes the snapshot whole into an empty entry', async () => {
      await resp.send(['SET', marker, '1', 'EX', METRIC_RECENT_EVENT_TTL]);

      const { hash, before, after } = await populate(true, { Like: 5, Heart: 7 });

      assert.deepEqual(withoutStamp(hash), { Like: '5', Heart: '7' });
      assertStamp(hash._populatedAt, before, after, true);
    });

    it('a not-found snapshot keeps the cached counts, on the miss TTL', async () => {
      await seed({ Like: '3' }, true);

      const { hash, ttl, before, after } = await populate(true, null);

      assert.deepEqual(withoutStamp(hash), { Like: '3', notFound: '1' });
      assertStamp(hash._populatedAt, before, after, true);
      assert.ok(ttl > MISS_CACHE_TTL - 5 && ttl <= MISS_CACHE_TTL, `ttl ${ttl}`);
    });
  });

  describe('option on, no marker', () => {
    it('replaces the entry as before', async () => {
      await seed({ Like: '9', Heart: '4', Cry: '1' }, false);

      const { hash, ttl, before, after } = await populate(true, { Like: 5, Heart: 7 });

      assert.deepEqual(withoutStamp(hash), { Like: '5', Heart: '7' });
      assertStamp(hash._populatedAt, before, after, false);
      assert.ok(ttl > CACHE_TTL - 5 && ttl <= CACHE_TTL, `ttl ${ttl}`);
    });

    it('a count that legitimately dropped (a removed reaction) is lowered', async () => {
      await seed({ Like: '3', Heart: '6' }, false);

      const { hash } = await populate(true, { Like: 2, Heart: 6 });

      assert.deepEqual(withoutStamp(hash), { Like: '2', Heart: '6' });
    });
  });
});

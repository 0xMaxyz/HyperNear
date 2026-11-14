import { afterEach, describe, expect, it, vi } from 'vitest';
import { HyperNearClient, ResilientProvider, type RpcTuning } from '@hypernear/client';

// a counting fake NEAR RPC behind fetch; `reply` decides each answer, `calls` records the JSON-RPC method + params
type Reply = (n: number, body: { method: string; params: Record<string, unknown> }) => Response | Promise<Response>;
const bytes = (v: unknown) => ({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1, block_hash: 'h' } });
const ok = (v: unknown) => new Response(JSON.stringify(bytes(v)));
// FastNEAR answers HTTP 429 with the JSON-RPC error as the body; a 200 with an unnamed error object reaches us as 'Unknown RPC error'
const rateLimited = () => new Response('{"jsonrpc":"2.0","error":{"code":-429,"message":"Rate limits exceeded"}}', { status: 429 });
const unnamedError = () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error"}}');
const panic = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { error: 'wasm execution failed: Smart contract panicked: no such owner', logs: [], block_height: 1, block_hash: 'h' } }));

let seq = 0;
const fresh = () => `http://rpc-${++seq}.test`; // a url is one shared gate, so every test takes its own
const FAST: Partial<RpcTuning> = { baseMs: 1, maxMs: 2 };

function fakeRpc(reply: Reply) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params });
    return reply(calls.length, body);
  });
  return calls;
}
const view = (p: ResilientProvider, method = 'get_owner', args: Record<string, unknown> = { owner: '0xa' }) => p.callFunction({ contractId: 'c.testnet', method, args });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResilientProvider', () => {
  it('turns identical concurrent views into one call', async () => {
    const calls = fakeRpc(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return ok({ nonce: 1 });
    });
    const p = new ResilientProvider(fresh(), FAST);
    const out = await Promise.all([view(p), view(p), view(p)]);
    expect(out).toEqual([{ nonce: 1 }, { nonce: 1 }, { nonce: 1 }]);
    expect(calls).toHaveLength(1);
    await view(p, 'get_owner', { owner: '0xb' });
    expect(calls).toHaveLength(2); // other args, other call
  });

  it('serves a view from the cache until the ttl runs out', async () => {
    let t = 1000;
    const calls = fakeRpc(() => ok({ nonce: calls.length }));
    const p = new ResilientProvider(fresh(), { ...FAST, ttlMs: 3000, now: () => t });
    await view(p);
    t += 2999;
    await view(p);
    expect(calls).toHaveLength(1);
    t += 2;
    expect(await view(p)).toEqual({ nonce: 2 });
    expect(calls).toHaveLength(2);
  });

  it('gives each caller its own parsed object', async () => {
    fakeRpc(() => ok({ nonce: 1 }));
    const p = new ResilientProvider(fresh(), FAST);
    const a = (await view(p)) as { nonce: number };
    a.nonce = 99;
    expect(await view(p)).toEqual({ nonce: 1 });
  });

  it('retries a 429 and an unnamed server error, then succeeds', async () => {
    const calls = fakeRpc((n) => (n === 1 ? rateLimited() : n === 2 ? unnamedError() : ok({ nonce: 7 })));
    const p = new ResilientProvider(fresh(), FAST);
    expect(await view(p)).toEqual({ nonce: 7 });
    expect(calls).toHaveLength(3);
  });

  it('retries a 5xx and a network error, and gives up after the attempt limit', async () => {
    let calls = fakeRpc((n) => (n === 1 ? new Response('x', { status: 503 }) : ok(1)));
    expect(await view(new ResilientProvider(fresh(), FAST))).toBe(1);
    expect(calls).toHaveLength(2);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(view(new ResilientProvider(fresh(), { ...FAST, attempts: 3 }))).rejects.toThrow(/fetch failed/);
    calls = fakeRpc(() => rateLimited());
    await expect(view(new ResilientProvider(fresh(), { ...FAST, attempts: 3 }))).rejects.toThrow(/Rate limits/);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a contract error', async () => {
    const calls = fakeRpc(() => panic());
    await expect(view(new ResilientProvider(fresh(), FAST))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failure', async () => {
    const calls = fakeRpc((n) => (n === 1 ? panic() : ok(2)));
    const p = new ResilientProvider(fresh(), FAST);
    await expect(view(p)).rejects.toThrow();
    expect(await view(p)).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('a write invalidates the cache, and a view that raced it is not cached', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const calls = fakeRpc(async (_i, body) => {
      if (body.method === 'send_tx') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: { SuccessValue: '' } } }));
      const mine = ++n;
      if (mine === 3) await gate; // the third view is in flight while the write lands
      return ok({ nonce: mine });
    });
    const p = new ResilientProvider(fresh(), FAST);
    expect(await view(p)).toEqual({ nonce: 1 });
    await p.sendJsonRpc('send_tx', { signed_tx_base64: 'x', wait_until: 'EXECUTED_OPTIMISTIC' });
    expect(await view(p)).toEqual({ nonce: 2 }); // not the cached 1
    expect(await view(p)).toEqual({ nonce: 2 });
    await new Promise((r) => setTimeout(r, 0));
    // a view that started before a write finished is never stored
    const racing = view(p, 'get_owner', { owner: '0xc' });
    await p.sendJsonRpc('send_tx', { signed_tx_base64: 'y', wait_until: 'EXECUTED_OPTIMISTIC' });
    release();
    expect(await racing).toEqual({ nonce: 3 });
    expect(await view(p, 'get_owner', { owner: '0xc' })).toEqual({ nonce: 4 });
    expect(calls.filter((c) => c.method === 'send_tx')).toHaveLength(2);
  });

  it('a write is shared across providers of the same url, and a write is resent only after a 429', async () => {
    let writes = 0;
    const calls = fakeRpc((_i, body) => {
      if (body.method !== 'send_tx') return ok({ nonce: calls.length });
      writes++;
      return writes === 1 ? rateLimited() : writes === 2 ? Promise.reject(new TypeError('fetch failed')) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });
    const url = fresh();
    const [a, b] = [new ResilientProvider(url, FAST), new ResilientProvider(url)];
    await view(a);
    await view(b);
    expect(calls).toHaveLength(1); // b reads a's cache
    await expect(a.sendJsonRpc('send_tx', { x: 1 })).rejects.toThrow(/fetch failed/); // 429 retried, then a network error is not
    expect(writes).toBe(2);
    await view(b);
    expect(calls.filter((c) => c.method === 'query')).toHaveLength(2); // the write cleared a's cache for b too
  });

  it('keeps access-key and block reads fresh (they feed a transaction nonce)', async () => {
    const calls = fakeRpc(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { nonce: 1 } })));
    const p = new ResilientProvider(fresh(), FAST);
    await Promise.all([p.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: 'a', public_key: 'k' }), p.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: 'a', public_key: 'k' })]);
    await p.viewBlock({ finality: 'final' });
    await p.viewBlock({ finality: 'final' });
    expect(calls).toHaveLength(4);
  });

  it('never has more than 4 requests in flight', async () => {
    let live = 0;
    let peak = 0;
    fakeRpc(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return ok(1);
    });
    const p = new ResilientProvider(fresh(), FAST);
    await Promise.all(Array.from({ length: 12 }, (_, i) => view(p, 'get_leg', { owner: '0xa', leg: i })));
    expect(peak).toBe(4);
  });
});

describe('one GET /owner worth of views', () => {
  // what GET /owner/:owner reads from the contract: 4 get_leg (Legs.registered), get_owner, get_config (the client keeps this one for good)
  const getOwner = (c: HyperNearClient) => Promise.all([...[0, 1, 2, 3].map((i) => c.getLeg('0xA', i)), c.getOwner('0xA'), c.getConfig()]);

  it('is 6 calls cold, and 5 concurrent polls plus a repeat inside the ttl add none', async () => {
    const calls = fakeRpc((_i, body) => {
      return ok(body.params.method_name === 'get_config' ? { chain_tag: 'x' } : body.params.method_name === 'get_leg' ? `0x${'1'.repeat(40)}` : { nonce: 0 });
    });
    const c = new HyperNearClient({ contractId: 'c.testnet', rpcUrl: fresh() });
    await Promise.all(Array.from({ length: 5 }, () => getOwner(c)));
    expect(calls).toHaveLength(6); // before: 5 polls x (4 + 1) + 1 = 26
    await getOwner(c);
    expect(calls).toHaveLength(6);
  });
});

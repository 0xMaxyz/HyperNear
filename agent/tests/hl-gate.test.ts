import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { HlClient, hlExchangeFetch, hlGate, type HlGateTuning } from '@perps-platform/core';
import { agentKeySigner } from '../src/market.ts';

// A counting fake of the Hyperliquid API behind fetch. `reply` sees (endpoint, body, n) with n counting every request.
type Reply = (kind: 'info' | 'exchange', body: any, n: number) => Response | Promise<Response>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const nginx429 = () => new Response('<html><body><h1>429 Too Many Requests</h1><hr>nginx/1.26.2</body></html>', { status: 429, headers: { 'content-type': 'text/html' } });
const mids = { BTC: '100000' };
const ch = { marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [], time: 1 };

let seq = 0;
const fresh = () => `http://hl-${++seq}.test`; // one url is one shared gate, so every test takes its own
const FAST: Partial<HlGateTuning> = { baseMs: 1, maxMs: 2 };

function fakeHl(reply: Reply) {
  const calls: { kind: 'info' | 'exchange'; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const kind = String(url).endsWith('/exchange') ? 'exchange' : 'info';
    calls.push({ kind, body });
    return reply(kind, body, calls.length);
  });
  return calls;
}
const client = (url: string, tuning: Partial<HlGateTuning> = FAST, signer = false) => {
  hlGate(url, tuning);
  return new HlClient({ network: 'testnet', apiUrl: url, ...(signer ? { agentSigner: agentKeySigner(generatePrivateKey()) } : {}) });
};
const cancel = (hl: HlClient) => hl.cancelOrder({ asset: 0, oid: 1 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HL /info reads', () => {
  it('turns identical concurrent reads into one request, each caller with its own copy', async () => {
    const calls = fakeHl(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return json(mids);
    });
    const hl = client(fresh());
    const [a, b, c] = await Promise.all([hl.allMids(), hl.allMids(), hl.allMids()]);
    expect(calls).toHaveLength(1);
    a.BTC = 'x';
    expect(b.BTC).toBe('100000');
    expect(c).toEqual(mids);
  });

  it('shares between HlClient objects of one api url, and keeps different bodies apart', async () => {
    const calls = fakeHl(() => json({ role: 'user' }));
    const url = fresh();
    await client(url).userRole({ user: '0x1111111111111111111111111111111111111111' });
    await client(url).userRole({ user: '0x1111111111111111111111111111111111111111' });
    expect(calls).toHaveLength(1);
    await client(url).userRole({ user: '0x2222222222222222222222222222222222222222' });
    expect(calls).toHaveLength(2);
  });

  it('serves from the cache until the ttl, and keeps meta much longer than a balance', async () => {
    let t = 0;
    const calls = fakeHl((_k, b) => json(b.type === 'meta' ? { universe: [], marginTables: [] } : mids));
    const hl = client(fresh(), { ...FAST, now: () => t });
    await hl.allMids();
    await hl.meta();
    t = 2999;
    await hl.allMids();
    expect(calls).toHaveLength(2);
    t = 3001;
    await hl.allMids();
    await hl.meta();
    expect(calls.map((c) => c.body.type)).toEqual(['allMids', 'meta', 'allMids']); // allMids again, meta still cached
    t = 301_000;
    await hl.meta();
    expect(calls).toHaveLength(4);
  });

  it('retries a 429 (nginx html) and then succeeds', async () => {
    const calls = fakeHl((_k, _b, n) => (n < 3 ? nginx429() : json(mids)));
    expect(await client(fresh()).allMids()).toEqual(mids);
    expect(calls).toHaveLength(3);
  });

  it('retries a 5xx, and gives up after the attempt limit with the original error', async () => {
    let calls = fakeHl((_k, _b, n) => (n === 1 ? new Response('bad gateway', { status: 502 }) : json(mids)));
    expect(await client(fresh()).allMids()).toEqual(mids);
    expect(calls).toHaveLength(2);
    calls = fakeHl(() => nginx429());
    await expect(client(fresh(), { ...FAST, attempts: 3 }).allMids()).rejects.toThrow(/429 Too Many Requests/);
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After, within the time budget', async () => {
    fakeHl((_k, _b, n) => (n === 1 ? new Response('slow', { status: 429, headers: { 'retry-after': '30' } }) : json(mids)));
    // 30 s is more than the 12 s budget: the 429 comes back at once instead of hanging the request
    await expect(client(fresh()).allMids()).rejects.toThrow(/429/);
    const calls = fakeHl((_k, _b, n) => (n === 1 ? new Response('slow', { status: 429, headers: { 'retry-after': '0.05' } }) : json(mids)));
    const t0 = Date.now();
    await client(fresh()).allMids();
    expect(calls).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it('does not cache a failure', async () => {
    const calls = fakeHl((_k, _b, n) => (n === 1 ? new Response('nope', { status: 400 }) : json(mids)));
    const hl = client(fresh());
    await expect(hl.allMids()).rejects.toThrow(/400/);
    expect(await hl.allMids()).toEqual(mids);
    expect(calls).toHaveLength(2); // a 400 is HL's answer, not retried
  });

  it('never has more than 4 /info requests in flight', async () => {
    let live = 0;
    let peak = 0;
    fakeHl(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return json({ role: 'user' });
    });
    const hl = client(fresh());
    await Promise.all(Array.from({ length: 12 }, (_, i) => hl.userRole({ user: `0x${String(i + 1).padStart(40, '0')}` })));
    expect(peak).toBe(4);
  });
});

describe('HL /exchange writes', () => {
  const ok = () => json({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } });

  it('is resent after a 429 with the very same signed request, and never cached', async () => {
    const calls = fakeHl((k, _b, n) => (k === 'exchange' ? (n === 1 ? nginx429() : ok()) : json(mids)));
    await cancel(client(fresh(), FAST, true));
    expect(calls.map((c) => c.kind)).toEqual(['exchange', 'exchange']);
    expect(calls[1]!.body).toEqual(calls[0]!.body); // same nonce and signature: HL can only see it once
  });

  it('is not resent after a 5xx, a timeout-like failure or HL rejecting it', async () => {
    let calls = fakeHl(() => new Response('oops', { status: 500 }));
    await expect(cancel(client(fresh(), FAST, true))).rejects.toThrow();
    expect(calls).toHaveLength(1);
    calls = fakeHl(() => json({ status: 'err', response: 'Order has invalid price.' }));
    await expect(cancel(client(fresh(), FAST, true))).rejects.toThrow();
    expect(calls).toHaveLength(1);
    calls = fakeHl(() => {
      throw new TypeError('fetch failed');
    });
    await expect(cancel(client(fresh(), FAST, true))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('drops every cached read before and after, and a read that raced it is not stored', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let state = 0;
    const calls = fakeHl(async (k, b) => {
      if (k === 'exchange') return ok();
      const mine = ++state;
      if (b.type === 'clearinghouseState' && mine === 3) await gate; // in flight while the write lands
      return json(b.type === 'clearinghouseState' ? { ...ch, time: mine } : { ...mids, n: String(mine) });
    });
    const hl = client(fresh(), FAST, true);
    expect(await hl.allMids()).toMatchObject({ n: '1' });
    expect(await hl.allMids()).toMatchObject({ n: '1' }); // cached
    await cancel(hl);
    expect(await hl.allMids()).toMatchObject({ n: '2' }); // not the pre-write 1
    const racing = hl.clearinghouseState({ user: '0x1111111111111111111111111111111111111111' });
    await cancel(hl);
    release();
    await racing;
    await hl.clearinghouseState({ user: '0x1111111111111111111111111111111111111111' });
    expect(calls.filter((c) => c.body.type === 'clearinghouseState')).toHaveLength(2); // the raced answer was not kept
  });
});

describe('hlExchangeFetch (the raw posts of the relayer and the sweep)', () => {
  const post = (f: typeof fetch, url: string) => f(`${url}/exchange`, { method: 'POST', body: JSON.stringify({ action: 1, nonce: 7 }) });

  it('resends after a 429 and returns HL answers untouched', async () => {
    const url = fresh();
    hlGate(url, FAST);
    let calls = fakeHl((_k, _b, n) => (n === 1 ? nginx429() : json({ status: 'ok' })));
    const r = await post(hlExchangeFetch(url), url);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(calls.map((c) => c.body)).toEqual([{ action: 1, nonce: 7 }, { action: 1, nonce: 7 }]);
    calls = fakeHl(() => json({ status: 'err', response: 'Insufficient margin' }));
    expect(await (await post(hlExchangeFetch(url), url)).json()).toEqual({ status: 'err', response: 'Insufficient margin' });
    expect(calls).toHaveLength(1);
    calls = fakeHl(() => new Response('boom', { status: 500 }));
    expect((await post(hlExchangeFetch(url), url)).status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it('hands the last 429 back to the caller when the tries run out', async () => {
    const url = fresh();
    hlGate(url, { ...FAST, attempts: 2 });
    const calls = fakeHl(() => nginx429());
    expect((await post(hlExchangeFetch(url), url)).status).toBe(429);
    expect(calls).toHaveLength(2);
  });
});

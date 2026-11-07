import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HyperNearClient, type NearBackend } from '@hypernear/client';
import { loadConfig } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { Hedger } from '../src/hedge.ts';
import { AgentKeyStore, Legs } from '../src/legs.ts';
import { HttpError, parseRelayBody, RateLimiter, Relayer } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';
import { ch, OWNER, snap } from './agent-helpers.ts';

const LEG0 = '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac';
const SIG = `0x${'ab'.repeat(65)}`;

describe('RateLimiter', () => {
  it('allows N per window per key, then resets', () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.allow('a'), r.allow('a'), r.allow('a'), r.allow('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(r.allow('a')).toBe(true);
  });
});

describe('parseRelayBody', () => {
  it.each([
    [{}, /owner/],
    [{ owner: OWNER.toUpperCase() }, /owner/],
    [{ owner: OWNER, intent: { type: 'nope' } }, /unknown intent/],
    [{ owner: OWNER, intent: { type: 'freeze', frozen: true }, nonce: -1, sig: SIG }, /nonce/],
    [{ owner: OWNER, intent: { type: 'freeze', frozen: true }, nonce: 0, sig: '0x12' }, /sig/],
    [{ owner: OWNER, intent: { type: 'registerLeg', leg: -1 } }, /leg/],
  ])('rejects %j', (b, re) => {
    expect(() => parseRelayBody(b)).toThrow(re);
  });
  it('registerLeg needs no nonce or signature', () => {
    expect(parseRelayBody({ owner: OWNER, intent: { type: 'registerLeg', leg: 1 } })).toEqual({ owner: OWNER, intent: { type: 'registerLeg', leg: 1 } });
  });
});

describe('AgentKeyStore', () => {
  it('creates the key once, file mode 0600, and never exposes the key through get()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypernear-'));
    const s = new AgentKeyStore(dir);
    const a = s.ensure(OWNER, 0);
    expect(s.ensure(OWNER, 0).address).toBe(a.address);
    expect(statSync(join(dir, 'agent-keys.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.get(OWNER, 0))).not.toMatch(/key/);
    expect(s.signer(OWNER, 0).address.toLowerCase()).toBe(a.address);
    expect(readFileSync(join(dir, 'agent-keys.json'), 'utf8')).toMatch(/"key": "0x[0-9a-f]{64}"/);
  });
});

// ---- HTTP API with a mocked contract and a fake leg snapshot

function deps(o: { owner?: Record<string, unknown> | null; legs?: Record<number, string | null>; fail?: string } = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const backend: NearBackend = {
    async view<T>(_c: string, method: string, args: Record<string, unknown>) {
      if (method === 'get_owner') return (o.owner === undefined ? { nonce: 3, agent: 'agent.testnet', frozen: false } : o.owner) as T;
      if (method === 'get_leg') return ((o.legs ?? { 0: LEG0 })[args.leg as number] ?? null) as T;
      if (method === 'get_config') return { chain_tag: 'near-testnet', hl_mainnet: false, mpc_contract: 'v1.signer-prod.testnet' } as T;
      throw new Error(`view ${method}`);
    },
    async call<T>(_c: string, method: string, args: Record<string, unknown>) {
      calls.push({ method, args });
      if (o.fail) throw new (await import('@hypernear/client')).HyperNearContractError(o.fail);
      return { txHash: 'tx1', value: (method === 'register_leg' ? LEG0 : null) as T };
    },
  };
  const client = new HyperNearClient({ contractId: 'leash.testnet', backend });
  const config = { ...loadConfig({}), nearAgent: { accountId: 'agent.testnet', secretKey: 'x' } };
  const legs = new Legs({ client, dataDir: mkdtempSync(join(tmpdir(), 'hypernear-')), network: 'testnet', coins: ['BTC'] });
  legs.snapshot = async () => snap(ch({ accountValue: 10, maint: 6, positions: [{ coin: 'BTC', szi: '0.0003', liq: '99000' }] }));
  const bus = new EventBus();
  const hedger = new Hedger(legs, config.policy, bus);
  const d: Deps = { config, client, legs, hedger, bus, relayer: new Relayer(client, new RateLimiter(2)) };
  return { d, calls };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(d: Deps) {
  server = createServer(handler(d));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('HTTP API', () => {
  it('GET /owner/:addr: legs, snapshot, policy, guard (and guard triggers go to /events)', async () => {
    const { d } = deps();
    const base = await serve(d);
    const r = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(r.legs.map((l: any) => l.leg)).toEqual([0, 1]);
    expect(r.policy.nonce).toBe(3);
    expect(r.snapshot.legs[0].clearinghouse.withdrawable).toBe('20');
    const g = r.guard.find((x: any) => x.id === 'leg0:BTC');
    expect(g.trigger).toBe(true); // 10 / 6 <= 2x maintenance
    expect(d.bus.since().some((e) => e.type === 'guard')).toBe(true);
  });

  it('POST /relay: owner_execute for a signed intent; registerLeg without a signature', async () => {
    const { d, calls } = deps();
    const base = await serve(d);
    const r1 = await post(`${base}/relay`, { owner: OWNER, nonce: 3, intent: { type: 'freeze', frozen: true }, sig: SIG });
    expect(r1.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'owner_execute', args: { owner: OWNER, nonce: 3, intent: { type: 'freeze', frozen: true }, signature: SIG } });
    const r2 = await (await post(`${base}/relay`, { owner: OWNER, intent: { type: 'registerLeg', leg: 0 } })).json();
    expect(r2).toMatchObject({ kind: 'registerLeg', address: LEG0 });
  });

  it('POST /relay refuses an owner with no registered leg (403), bad bodies (400), floods (429)', async () => {
    const { d, calls } = deps({ legs: {} });
    const base = await serve(d);
    expect((await post(`${base}/relay`, { owner: OWNER, nonce: 0, intent: { type: 'freeze', frozen: true }, sig: SIG })).status).toBe(403);
    expect((await post(`${base}/relay`, { owner: 'x' })).status).toBe(400);
    expect((await post(`${base}/relay`, { owner: OWNER })).status).toBe(429); // limiter: 2 per minute
    expect(calls).toHaveLength(0);
  });

  it('POST /relay maps a contract panic to 422', async () => {
    const { d } = deps({ fail: 'owner_execute failed: bad nonce' });
    const base = await serve(d);
    const r = await post(`${base}/relay`, { owner: OWNER, nonce: 1, intent: { type: 'freeze', frozen: true }, sig: SIG });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/bad nonce/);
  });

  it('POST /hedge/open needs the owner to have opted our agent in', async () => {
    for (const owner of [null, { nonce: 1, agent: 'someone-else.testnet', frozen: false }, { nonce: 1, agent: 'agent.testnet', frozen: true }]) {
      const { d } = deps({ owner });
      const base = await serve(d);
      expect((await post(`${base}/hedge/open`, { owner: OWNER, coin: 'BTC', ratio: 0.5 })).status).toBe(403);
      server!.close();
    }
  });

  it('POST /hedge/open refused by order policy -> 422 and a hedge event', async () => {
    const { d } = deps();
    const base = await serve(d);
    const r = await post(`${base}/hedge/open`, { owner: OWNER, coin: 'DOGE', ratio: 0.5 });
    expect(r.status).toBe(422);
    expect(d.bus.since().find((e) => e.type === 'hedge')?.data.refused).toMatch(/not allowed/);
  });

  it('GET /events streams past and new events as SSE', async () => {
    const { d } = deps();
    d.bus.emit('decision', { n: 1 });
    const base = await serve(d);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    d.bus.emit('decision', { n: 2 });
    let text = '';
    while (!text.includes('"n":2')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toMatch(/event: decision\ndata: .*"n":1/);
  });

  it('unknown route -> 404; HttpError carries its status', async () => {
    const { d } = deps();
    const base = await serve(d);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(new HttpError(418, 'x').status).toBe(418);
  });
});

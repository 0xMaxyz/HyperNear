import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { commandTypedData, HyperNearClient, newCommand, specHashOfJson, type Command, type NearBackend } from '@hypernear/client';
import { privateKeyToAccount } from 'viem/accounts';
import { ReplayCache, verifyCommand } from '../src/commands.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { loadConfig } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { Hedger } from '../src/hedge.ts';
import { AgentKeyStore, Legs } from '../src/legs.ts';
import { HttpError, parseRelayBody, RateLimiter, Relayer } from '../src/relayer.ts';
import { Decider, DecisionModes } from '../src/decisions.ts';
import { handler, type Deps } from '../src/server.ts';
import { ch, OWNER, snap } from './agent-helpers.ts';

const LEG0 = '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac';
// well-known PUBLIC web3 test key (its address is OWNER): never funded
const ownerKey = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const signed = async (command: Command, by = ownerKey) => ({ command, sig: await by.signTypedData(commandTypedData('near-testnet', 'leash.testnet', command) as never) });
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

function deps(o: { owner?: Record<string, unknown> | null; legs?: Record<number, string | null>; fail?: string; value?: unknown } = {}) {
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
      return { txHash: 'tx1', value: (method === 'register_leg' ? LEG0 : (o.value ?? null)) as T };
    },
  };
  const client = new HyperNearClient({ contractId: 'leash.testnet', backend });
  const config = { ...loadConfig({}), nearAgent: { accountId: 'agent.testnet', secretKey: 'x' } };
  const legs = new Legs({ client, dataDir: mkdtempSync(join(tmpdir(), 'hypernear-')), network: 'testnet', coins: ['BTC'] });
  legs.snapshot = async () => snap(ch({ accountValue: 10, maint: 6, positions: [{ coin: 'BTC', szi: '0.0003', liq: '99000' }] }));
  const bus = new EventBus();
  const hedger = new Hedger(legs, config.policy, bus);
  const d: Deps = { config, client, legs, hedger, bus, relayer: new Relayer(client, new RateLimiter(2)), replay: new ReplayCache(), guardConfig: DEFAULT_GUARD_CONFIG, legHistory: async () => [] };
  return { d, calls };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

async function serve(d: Deps) {
  server = createServer(handler(d));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('HTTP API', () => {
  it('GET /owner/:addr: legs, snapshot, policy, guard evaluation', async () => {
    const { d } = deps();
    const base = await serve(d);
    const r = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(r.legs.map((l: any) => l.leg)).toEqual([0, 1]);
    expect(r.policy.nonce).toBe(3);
    expect(r.snapshot.legs[0].clearinghouse.withdrawable).toBe('20');
    const g = r.guard.find((x: any) => x.id === 'leg0:BTC');
    expect(g.trigger).toBe(true); // 10 / 6 <= 2x maintenance
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

  it('POST /relay freeze: the sweep runs after the answer, reports orders.swept, and a slow or failing sweep never delays or fails the freeze', async () => {
    const { d } = deps({ value: [] }); // owner_execute returns the revoked agents: kind "freeze"
    let release!: () => void;
    d.sweeper = () => new Promise((r) => (release = () => r([{ leg: 0, address: LEG0, found: 1, skipped: 0, cancelled: 1, txHashes: ['t1'], hl: ['ok'] }] as never)));
    const base = await serve(d);
    const r = await post(`${base}/relay`, { owner: OWNER, nonce: 3, intent: { type: 'freeze', frozen: true }, sig: SIG });
    expect(r.status).toBe(200); // answered while the sweep is still pending
    expect((await r.json()).kind).toBe('freeze');
    expect(d.bus.since(0).some((e) => e.type === 'orders.swept')).toBe(false);
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(d.bus.since(0).find((e) => e.type === 'orders.swept')!.data).toMatchObject({ owner: OWNER, trigger: 'freeze', cancelled: 1, legs: [{ leg: 0, cancelled: 1 }] });

    d.sweeper = async () => {
      throw new Error('NEAR RPC down');
    };
    const r2 = await post(`${base}/relay`, { owner: OWNER, nonce: 4, intent: { type: 'freeze', frozen: true }, sig: SIG });
    expect(r2.status).toBe(200);
    await new Promise((res) => setTimeout(res, 20));
    expect(d.bus.since(0).filter((e) => e.type === 'orders.swept').at(-1)!.data).toMatchObject({ error: 'NEAR RPC down', legs: [], cancelled: 0 });
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
      expect((await post(`${base}/hedge/open`, await signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5')))).status).toBe(403);
      server!.close();
    }
  });

  it('POST /hedge/open refused by order policy -> 422 and a hedge event', async () => {
    const { d } = deps();
    const base = await serve(d);
    const r = await post(`${base}/hedge/open`, await signed(newCommand(OWNER, 'openHedge', 'DOGE', '0.5')));
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

describe('Command specHash', () => {
  const v = () => ({ chainTag: async () => 'near-testnet' as const, contractId: 'leash.testnet', cache: new ReplayCache() });
  it('zero for every action but startStrategy, which needs a spec hash; missing or malformed -> 400', async () => {
    const spec = `0x${'cd'.repeat(32)}` as const;
    await expect(verifyCommand(v(), await signed(newCommand(OWNER, 'closeHedge', 'BTC', '0', 30, Date.now(), spec)), 'closeHedge')).rejects.toThrow(/must be zero/);
    await expect(verifyCommand(v(), await signed(newCommand(OWNER, 'startStrategy', '')), 'startStrategy')).rejects.toThrow(/must be the spec hash/);
    const { specHash: _drop, ...noHash } = newCommand(OWNER, 'closeHedge', 'BTC');
    await expect(verifyCommand(v(), { command: noHash, sig: SIG }, 'closeHedge')).rejects.toThrow(/bytes32/);
    const ok = await verifyCommand(v(), await signed(newCommand(OWNER, 'startStrategy', '', '0', 30, Date.now(), spec)), 'startStrategy');
    expect(ok.specHash).toBe(spec);
  });

  it('placeOrder and cancelOrder bind a spec like startStrategy; openHedge accepts one only when the route allows it', async () => {
    const spec = `0x${'ab'.repeat(32)}` as const;
    for (const action of ['placeOrder', 'cancelOrder'] as const) {
      await expect(verifyCommand(v(), await signed(newCommand(OWNER, action, '')), action)).rejects.toThrow(/must be the spec hash/);
      expect((await verifyCommand(v(), await signed(newCommand(OWNER, action, '', '0', 30, Date.now(), spec)), action)).specHash).toBe(spec);
    }
    const hedge = await signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5', 30, Date.now(), spec));
    await expect(verifyCommand(v(), hedge, 'openHedge')).rejects.toThrow(/must be zero/);
    expect((await verifyCommand(v(), hedge, 'openHedge', true)).specHash).toBe(spec);
  });

  it('canonicalJson ignores key order, so the browser and the agent hash the same spec to the same value', () => {
    expect(specHashOfJson({ a: 1, b: { c: [1, { y: 2, x: 1 }], d: 'z' } })).toBe(specHashOfJson({ b: { d: 'z', c: [1, { x: 1, y: 2 }] }, a: 1 }));
    expect(specHashOfJson({ a: 1 })).not.toBe(specHashOfJson({ a: 2 }));
    expect(specHashOfJson({ a: 1 })).toBe('0x015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});

describe('signed commands on /hedge/*', () => {
  it.each([
    ['no command', async () => ({ owner: OWNER, coin: 'BTC', ratio: 0.5 }), 401, /signed command required/],
    ['wrong signer', async () => signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5'), privateKeyToAccount(`0x${'11'.repeat(32)}`)), 401, /does not match/],
    ['expired', async () => signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5', -5)), 401, /expired/],
    ['expiry > 60 s', async () => signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5', 120)), 401, /60 s/],
    ['action for the other route', async () => signed(newCommand(OWNER, 'closeHedge', 'BTC')), 400, /openHedge/],
    ['tampered after signing', async () => ({ ...(await signed(newCommand(OWNER, 'openHedge', 'BTC', '0.5'))), command: { ...newCommand(OWNER, 'openHedge', 'BTC', '1') } }), 401, /does not match/],
  ])('rejects %s', async (_n, body, status, re) => {
    const { d } = deps();
    const base = await serve(d);
    const r = await post(`${base}/hedge/open`, await body());
    expect(r.status).toBe(status);
    expect((await r.json()).error).toMatch(re);
    expect(d.bus.since().some((e) => e.type === 'hedge' || e.type === 'command')).toBe(false);
  });

  it('accepts a fresh command once, refuses its replay', async () => {
    const { d } = deps();
    d.hedger.closeHedge = (async () => ({ plan: { ok: true, orders: [] }, results: [] })) as never; // no HL here
    const base = await serve(d);
    const body = await signed(newCommand(OWNER, 'closeHedge', 'BTC'));
    const r1 = await post(`${base}/hedge/close`, body);
    expect(r1.status).toBe(200);
    expect(d.bus.since().find((e) => e.type === 'command')?.data).toMatchObject({ owner: OWNER, action: 'closeHedge' });
    const r2 = await post(`${base}/hedge/close`, body);
    expect(r2.status).toBe(401);
    expect((await r2.json()).error).toMatch(/replayed/);
  });
});

describe('approveAgent end to end', () => {
  const AGENT_NAME = 'leash-leg0';
  const signOut = (agent: string) => ({ payload: '00', big_r: `02${'aa'.repeat(32)}`, s: 'bb'.repeat(32), recovery_id: 0, action: { type: 'approveAgent', agentAddress: agent, agentName: AGENT_NAME, nonce: 123 } });

  async function setup(hlReply: unknown) {
    const keysDir = mkdtempSync(join(tmpdir(), 'hypernear-'));
    const store = new AgentKeyStore(keysDir); // as after the owner's prepareAgents
    const agent = store.ensure(OWNER, 0).address;
    store.ensure(OWNER, 1);
    const { d } = deps({ value: signOut(agent) });
    const legs = new Legs({ client: d.client, dataDir: keysDir, network: 'testnet', coins: ['BTC'] });
    // as Legs.snapshot: the stored key per leg (HL is not reachable here)
    legs.snapshot = async () => {
      const s = snap(ch(), ch());
      return { ...s, legs: s.legs.map((l) => ({ ...l, agent: legs.keys.get(OWNER, l.leg) ?? null })) };
    };
    const posted: any[] = [];
    const deps2: Deps = { ...d, legs, relayer: new Relayer(d.client, new RateLimiter(5), async (b) => (posted.push(b), hlReply), d.bus) };
    return { d: deps2, agent, posted, base: await serve(deps2) };
  }
  const intent = (agent: string) => ({ type: 'approveAgent', leg: 0, agent, agentName: AGENT_NAME, hlNonce: 123 });

  it('GET /owner creates no state; the signed prepareAgents creates the keys and enrols the owner', async () => {
    const { d } = deps();
    const legs = new Legs({ client: d.client, dataDir: mkdtempSync(join(tmpdir(), 'hypernear-')), network: 'testnet', coins: ['BTC'] });
    legs.snapshot = async () => {
      const s = snap(ch());
      return { ...s, legs: [{ ...s.legs[0]!, agent: legs.keys.get(OWNER, 0) ?? null }] };
    };
    const base = await serve({ ...d, legs });
    const before = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(before).toMatchObject({ needsPrepare: true, pendingApprovals: [] });
    expect(before.legs[0].agent).toBeNull();
    expect(legs.keys.owners()).toEqual([]);
    expect((await post(`${base}/agents/prepare`, { owner: OWNER })).status).toBe(401);
    const r = await (await post(`${base}/agents/prepare`, await signed(newCommand(OWNER, 'prepareAgents', '')))).json();
    expect(r.legs.map((l: any) => l.leg)).toEqual([0]); // the registered legs
    expect(r.pendingApprovals[0]).toMatchObject({ type: 'approveAgent', leg: 0, agent: legs.keys.get(OWNER, 0)!.address, agentName: 'leash-leg0' });
    expect(legs.keys.owners()).toEqual([OWNER]);
    expect((await (await fetch(`${base}/owner/${OWNER}`)).json()).needsPrepare).toBe(false);
  });

  it('/owner lists every leg key still to approve with the exact intent fields, plus config', async () => {
    const { base, agent } = await setup({ status: 'ok' });
    const r = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(r.config).toEqual({ contractId: 'leash.testnet', chainTag: 'near-testnet', agentAccount: 'agent.testnet', hlNetwork: 'testnet' });
    expect(r.legs[0].agent).toMatchObject({ address: agent, approvedAt: null });
    expect(r.pendingApprovals.map((p: any) => [p.type, p.leg, p.agentName])).toEqual([['approveAgent', 0, 'leash-leg0'], ['approveAgent', 1, 'leash-leg1']]);
    expect(r.pendingApprovals[0]).toMatchObject({ agent, hlNonce: expect.any(Number) });
  });

  it('/relay posts the contract-signed approval to HL, marks the key approved, emits agents.approved', async () => {
    const { d, base, agent, posted } = await setup({ status: 'ok', response: { type: 'default' } });
    const r = await (await post(`${base}/relay`, { owner: OWNER, nonce: 3, intent: intent(agent), sig: SIG })).json();
    expect(r).toMatchObject({ kind: 'approveAgent', owner: OWNER, leg: 0, agent, ok: true, txHash: 'tx1' });
    expect(posted[0]).toMatchObject({ action: { type: 'approveAgent', agentAddress: agent, hyperliquidChain: 'Testnet', signatureChainId: '0x66eee' }, nonce: 123 });
    expect(d.legs.keys.get(OWNER, 0)?.approvedAt).toEqual(expect.any(Number));
    expect(d.bus.since().find((e) => e.type === 'agents.approved')?.data).toMatchObject({ owner: OWNER, leg: 0, agent, ok: true });
    const o = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(o.pendingApprovals.map((p: any) => p.leg)).toEqual([1]);
  });

  it('/relay posts a contract-signed withdraw and class transfer to HL (the contract only signs); a refusal is ok: false', async () => {
    const out = (action: Record<string, unknown>) => ({ payload: '00', big_r: `02${'aa'.repeat(32)}`, s: 'bb'.repeat(32), recovery_id: 0, action });
    const run = async (value: ReturnType<typeof out>, intent: Record<string, unknown>, hl: unknown) => {
      const { d } = deps({ value });
      const posted: any[] = [];
      const d2: Deps = { ...d, relayer: new Relayer(d.client, new RateLimiter(5), async (b) => (posted.push(b), hl), d.bus) };
      const r = await (await post(`${await serve(d2)}/relay`, { owner: OWNER, nonce: 3, intent, sig: SIG })).json();
      return { r, posted, d: d2 };
    };
    const w = await run(out({ type: 'withdraw3', destination: OWNER, amount: '3.0', time: 456 }), { type: 'withdraw', leg: 0, amount: '3.0', hlTime: 456 }, { status: 'ok', response: { type: 'default' } });
    expect(w.r).toMatchObject({ kind: 'ownerExecute', leg: 0, action: 'withdraw', amount: '3.0', ok: true });
    expect(w.posted[0]).toMatchObject({ action: { type: 'withdraw3', destination: OWNER, hyperliquidChain: 'Testnet' }, nonce: 456 });
    expect(w.d.bus.since().find((e) => e.type === 'funds.moved')?.data).toMatchObject({ owner: OWNER, leg: 0, action: 'withdraw', ok: true });
    const m = await run(out({ type: 'usdClassTransfer', amount: '5.0', toPerp: true, nonce: 789 }), { type: 'usdClassTransfer', leg: 0, amount: '5.0', toPerp: true, hlNonce: 789 }, { status: 'err', response: 'Insufficient balance' });
    expect(m.r).toMatchObject({ kind: 'ownerExecute', action: 'usdClassTransfer', ok: false, hl: { response: 'Insufficient balance' } });
    expect(m.posted[0]).toMatchObject({ action: { type: 'usdClassTransfer', toPerp: true }, nonce: 789 });
  });

  it('an HL refusal comes back as ok: false with the HL text (200); the key stays unapproved', async () => {
    const { d, base, agent } = await setup({ status: 'err', response: 'Must deposit before performing actions.' });
    const r = await post(`${base}/relay`, { owner: OWNER, nonce: 3, intent: intent(agent), sig: SIG });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, hl: { response: expect.stringMatching(/Must deposit/) } });
    expect(d.legs.keys.get(OWNER, 0)?.approvedAt).toBeUndefined();
  });
});

describe('decision routes', () => {
  function withDecider() {
    const { d } = deps();
    d.legs.snapshot = async () =>
      snap(ch({ accountValue: 50, maint: 5, positions: [{ coin: 'BTC', szi: '0.0008' }] }), ch({ accountValue: 50, maint: 20, positions: [{ coin: 'BTC', szi: '-0.0006' }] }));
    const executed: unknown[] = [];
    d.config = { ...d.config, decide: { live: true, intervalSec: 300 } };
    d.decider = new Decider({
      legs: d.legs, bus: d.bus, policy: d.config.policy, annualVol: 0.6,
      modes: new DecisionModes(mkdtempSync(join(tmpdir(), 'hypernear-'))),
      propose: async () => ({ id: 'p-1', action: 'reduce_hedge', source: 'jev', factors: {} as never, rationale: 'r', latencyMs: 1, model: 'jev-1.14.0', flagged: false, trace: { jevMs: 1, calls: [], tableAction: null } }),
      execute: async (_o, _a, _c, orders) => (executed.push(orders), { ok: true }),
      checkOwner: async () => undefined,
      owners: () => [OWNER],
    });
    return { d, executed };
  }

  it('propose (202, result on /events), then accept with a matching signed command', async () => {
    const { d, executed } = withDecider();
    const base = await serve(d);
    const r = await post(`${base}/decision/propose`, { owner: OWNER });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ owner: OWNER, coin: 'BTC', queued: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(d.bus.since().find((e) => e.type === 'decision.proposed')?.data).toMatchObject({ id: 'p-1', action: 'reduce_hedge', coin: 'BTC' });
    const wrong = await post(`${base}/decision/p-1/accept`, await signed(newCommand(OWNER, 'close_both', 'BTC')));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/must be reduce_hedge/);
    const ok = await post(`${base}/decision/p-1/accept`, await signed(newCommand(OWNER, 'reduce_hedge', 'BTC')));
    expect(ok.status).toBe(200);
    expect(executed).toHaveLength(1);
    // a fresh nonce: the replay cache would answer 401 first
    expect((await post(`${base}/decision/p-1/accept`, await signed(newCommand(OWNER, 'reduce_hedge', 'BTC', '0', 30, Date.now() + 7)))).status).toBe(409);
    const rej = await post(`${base}/decision/p-1/reject`, await signed(newCommand(OWNER, 'reject', 'BTC', '0', 30, Date.now() + 9)));
    expect(rej.status).toBe(409); // already accepted; the route verified the signed reject first
    const o = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(o.decision).toMatchObject({ mode: 'propose', latest: { id: 'p-1', status: 'accepted' } });
  });

  it('forceAction is refused unless HYPERNEAR_TEST=1; then the forced action is proposed with the models\' action recorded', async () => {
    const { d } = withDecider();
    d.relayer = new Relayer(d.client, new RateLimiter(10)); // three proposes in one minute
    const base = await serve(d);
    expect((await post(`${base}/decision/propose`, { owner: OWNER, forceAction: 'close_both' })).status).toBe(400);
    process.env.HYPERNEAR_TEST = '1';
    try {
      expect((await post(`${base}/decision/propose`, { owner: OWNER, forceAction: 'yolo' })).status).toBe(400);
      expect((await post(`${base}/decision/propose`, { owner: OWNER, forceAction: 'close_both' })).status).toBe(202);
    } finally {
      delete process.env.HYPERNEAR_TEST;
    }
    await new Promise((ok) => setTimeout(ok, 20));
    expect(d.bus.since().find((e) => e.type === 'decision.proposed')?.data).toMatchObject({ action: 'close_both', forced: true, modelAction: 'reduce_hedge' });
  });

  it('mode: owner-signed setDecisionMode; unsigned or unknown mode refused; 503 without model keys', async () => {
    const { d } = withDecider();
    const base = await serve(d);
    const r = await post(`${base}/decision/mode`, await signed(newCommand(OWNER, 'setDecisionMode', 'auto')));
    expect(await r.json()).toMatchObject({ owner: OWNER, mode: 'auto' });
    expect(d.decider!.d.modes.get(OWNER)).toBe('auto');
    expect((await post(`${base}/decision/mode`, await signed(newCommand(OWNER, 'setDecisionMode', 'yolo', '0', 30, Date.now() + 7)))).status).toBe(400);
    expect((await post(`${base}/decision/mode`, { owner: OWNER, mode: 'auto' })).status).toBe(401);
    d.config = { ...d.config, decide: { live: false, intervalSec: 300 } };
    expect((await post(`${base}/decision/propose`, { owner: OWNER })).status).toBe(503);
  });
});

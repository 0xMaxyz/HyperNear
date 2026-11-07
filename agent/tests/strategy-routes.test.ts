import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, HyperNearClient, newCommand, type Command, type NearBackend } from '@hypernear/client';
import { ReplayCache } from '../src/commands.ts';
import { loadConfig } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { Hedger } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { RateLimiter, Relayer } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';
import { StrategyManager } from '../src/strategy/manager.ts';
import type { PlaceRequest, TradingPort } from '../src/strategy/port.ts';
import { specHash, validateSpec, type SpecContext } from '../src/strategy/spec.ts';
import { OWNER } from './agent-helpers.ts';
import fx from './fixtures/strategy-spec.json';

// well-known PUBLIC web3 test key (its address is OWNER): never funded
const ownerKey = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const signed = async (command: Command) => ({ command, sig: await ownerKey.signTypedData(commandTypedData('near-testnet', 'leash.testnet', command) as never) });
const ctx = fx.context as unknown as SpecContext;
const parsed = validateSpec(fx.twap, ctx);
if (!parsed.ok) throw new Error('fixture');
const spec = parsed.spec;

const port: TradingPort = {
  info: async () => ({ asset: 3, szDecimals: 5, mid: 74000 }),
  openOids: async () => new Set<string>(),
  filledOids: async () => new Set<string>(),
  position: async () => 0,
  equity: async () => 100,
  setLeverage: async () => {},
  place: async (o: PlaceRequest) => ({ oid: '1', fill: { sz: Number(o.sz), px: Number(o.px) } }),
  cancel: async () => {},
  flatten: async () => {},
  armDeadman: async () => {},
};

function setup(drafter?: Deps['drafter']) {
  const backend: NearBackend = {
    async view<T>(_c: string, method: string, args: Record<string, unknown>) {
      if (method === 'get_owner') return { ...fx.context.owner, agent: 'agent.testnet' } as T;
      if (method === 'get_leg') return ((args.leg === 3 ? '0x5cba8512a2933a08fc3d33874871fe430b6e3d91' : null) as T);
      if (method === 'get_config') return { chain_tag: 'near-testnet', hl_mainnet: false, mpc_contract: 'v1.signer-prod.testnet' } as T;
      throw new Error(`view ${method}`);
    },
    async call<T>() {
      return { txHash: 'tx', value: null as T };
    },
  };
  const client = new HyperNearClient({ contractId: 'leash.testnet', backend });
  const config = { ...loadConfig({}), nearAgent: { accountId: 'agent.testnet', secretKey: 'x' } };
  const legs = new Legs({ client, dataDir: mkdtempSync(join(tmpdir(), 'hypernear-')), network: 'testnet', coins: ['BTC'] });
  legs.keys.ensure(OWNER, 3);
  legs.keys.markApproved(OWNER, 3);
  const bus = new EventBus();
  const strategies = new StrategyManager({ legs, client, policy: config.policy, agentId: 'agent.testnet', emit: (t, d) => void bus.emit(t, d), intervalMs: 3_600_000, makePort: async () => port });
  const d: Deps = { config, client, legs, hedger: new Hedger(legs, config.policy, bus), bus, relayer: new Relayer(client, new RateLimiter(100)), replay: new ReplayCache(), guardConfig: DEFAULT_GUARD_CONFIG, strategies, drafter };
  return { d, strategies };
}

let server: Server | undefined;
let toStop: StrategyManager | undefined;
afterEach(() => {
  server?.close();
  toStop?.shutdown();
});
async function serve(d: Deps) {
  server = createServer(handler(d));
  toStop = d.strategies;
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const start = (hash: string, s: unknown = spec, nonceMs = Date.now()) => signed(newCommand(OWNER, 'startStrategy', '', '0', 30, nonceMs, hash as Hex)).then((b) => ({ ...b, spec: s }));

describe('strategy routes', () => {
  it('start needs the owner signature over the spec hash; then list, pause, stop with signed commands', async () => {
    const { d } = setup();
    const base = await serve(d);
    const ok = await post(`${base}/strategy/start`, await start(specHash(spec)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: spec.id, state: 'running' });
    expect((await (await fetch(`${base}/strategies/${OWNER}`)).json()).strategies).toMatchObject([{ id: spec.id, state: 'running' }]);
    const paused = await post(`${base}/strategy/pause`, await signed(newCommand(OWNER, 'pauseStrategy', spec.id, '0', 30, Date.now() + 1)));
    expect(await paused.json()).toMatchObject({ state: 'paused' });
    const stopped = await post(`${base}/strategy/stop`, await signed(newCommand(OWNER, 'stopStrategy', spec.id, '0', 30, Date.now() + 2)));
    expect(await stopped.json()).toMatchObject({ state: 'stopped' });
  });

  it('refuses a spec other than the one signed (401), a zero hash (400), an invalid spec (422), a replay (401)', async () => {
    const { d } = setup();
    const base = await serve(d);
    const other = { ...spec, params: { ...spec.params, slices: 2 } };
    expect((await post(`${base}/strategy/start`, await start(specHash(spec), other))).status).toBe(401);
    expect((await post(`${base}/strategy/start`, await start(`0x${'0'.repeat(64)}`, spec, Date.now() + 1))).status).toBe(400);
    const bad = { ...spec, limits: { ...spec.limits, maxLeverage: 10 } };
    const r = await post(`${base}/strategy/start`, await start(specHash(bad as never), bad, Date.now() + 2));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain('can only tighten the policy');
    const body = await start(specHash(spec), spec, Date.now() + 3);
    expect((await post(`${base}/strategy/start`, body)).status).toBe(200);
    expect((await post(`${base}/strategy/start`, body)).status).toBe(401);
  });

  it('a pause command cannot start a strategy and a start command cannot carry a zero hash for other actions', async () => {
    const { d } = setup();
    const base = await serve(d);
    const body = await signed(newCommand(OWNER, 'pauseStrategy', spec.id, '0', 30, Date.now(), specHash(spec) as Hex));
    expect((await post(`${base}/strategy/pause`, body)).status).toBe(400); // a nonzero specHash is only valid for startStrategy
    expect((await post(`${base}/strategy/pause`, await signed(newCommand(OWNER, 'pauseStrategy', 'nope', '0', 30, Date.now() + 1)))).status).toBe(404);
  });
});

describe('POST /strategy/draft', () => {
  it('returns the validated draft with its hash; rejected drafts are 422 and carry the reasons', async () => {
    const good = setup(async () => ({ ok: true, spec, specHash: specHash(spec), diff: { against: 'new', changes: [] }, warnings: [] }));
    const base = await serve(good.d);
    const r = await post(`${base}/strategy/draft`, { owner: OWNER, text: 'dca btc' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, specHash: specHash(spec) });
    server?.close();

    const bad = setup(async () => ({ ok: false, errors: ['coin must be one of BTC, ETH'], draft: { coin: 'DOGE' } }));
    const r2 = await post(`${await serve(bad.d)}/strategy/draft`, { owner: OWNER, text: 'dca doge' });
    expect(r2.status).toBe(422);
    expect(await r2.json()).toMatchObject({ ok: false, errors: ['coin must be one of BTC, ETH'] });
  });

  it('503 without a model, 400 for empty or overlong text, nothing started either way', async () => {
    const off = setup();
    expect((await post(`${await serve(off.d)}/strategy/draft`, { owner: OWNER, text: 'x' })).status).toBe(503);
    server?.close();
    const on = setup(async () => {
      throw new Error('must not be called');
    });
    const base = await serve(on.d);
    expect((await post(`${base}/strategy/draft`, { owner: OWNER, text: ' ' })).status).toBe(400);
    expect((await post(`${base}/strategy/draft`, { owner: OWNER, text: 'x'.repeat(601) })).status).toBe(400);
    expect(on.strategies.list(OWNER)).toEqual([]);
  });
});

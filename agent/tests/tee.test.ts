import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandTypedData, HyperNearClient, newCommand, type Command, type NearBackend, type SignOut } from '@hypernear/client';
import { privateKeyToAccount } from 'viem/accounts';

// every write the key store could make goes through these; the TEE store must never call them
const fsSpy = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>();
  const spy = (name: string) => (...a: unknown[]) => {
    fsSpy.writes.push(`${name} ${String(a[0])}`);
    return (m as any)[name](...a);
  };
  return { ...m, writeFileSync: spy('writeFileSync'), mkdirSync: spy('mkdirSync'), renameSync: spy('renameSync'), chmodSync: spy('chmodSync') };
});

import { ReplayCache } from '../src/commands.ts';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { EventBus } from '../src/events.ts';
import { Hedger } from '../src/hedge.ts';
import { AgentKeyStore, Legs } from '../src/legs.ts';
import { parseRelayBody, RateLimiter, Relayer } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';
import { accountFromSeed, pinAccount, teeAccount } from '../src/teeAccount.ts';
import { bootTee, enrollTeeOwner, hlLedgerPort, measurementsFrom, OwnerScope, shadeBackend, type TeeLedgerPort } from '../src/tee.ts';
import { ch, OWNER, snap } from './agent-helpers.ts';

const LEG0 = '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac';
const LEG1 = '0x8056c4fa3aad69cf04c2ade906c58489e76c9986';
const FEE = '0x1111111111111111111111111111111111111111';
const MEAS = 'ab'.repeat(32);
const ownerKey = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const signed = async (command: Command) => ({ command, sig: await ownerKey.signTypedData(commandTypedData('near-testnet', 'leash.testnet', command) as never) });
const ME = 'a'.repeat(64);
const TEE = (o: Partial<{ measurement_hash: string; agent_account: string | null; paid_until_ns: string; months_paid: number }> = {}) => ({ measurement_hash: MEAS, agent_account: ME, months_paid: 1, paid_until_ns: String((Date.now() + 86_400_000) * 1_000_000), keys: {}, ...o });
const SIGN_OUT = (agent: string): SignOut => ({ payload: 'ab', big_r: `02${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id: 0, action: { type: 'approveAgent', agentAddress: agent, agentName: 'leash-tee', nonce: 1 } });

/** Contract mock that logs every view/call/HL post in order. */
function world(o: { tee?: unknown; teeAgent?: unknown; fee?: string | null; ledger?: boolean; ownerExecute?: unknown } = {}) {
  const log: string[] = [];
  const calls: { method: string; args: any; opts?: any }[] = [];
  const backend: NearBackend = {
    async view<T>(_c: string, method: string, args: Record<string, unknown>) {
      log.push(`view:${method}`);
      if (method === 'get_tee') return (o.tee === undefined ? null : o.tee) as T;
      if (method === 'get_tee_agent') return (o.teeAgent === undefined ? { measurement_hash: MEAS, expires_ns: '1' } : o.teeAgent) as T;
      if (method === 'get_leg') return ({ 0: LEG0, 1: LEG1 }[args.leg as number] ?? null) as T;
      if (method === 'get_config') return { chain_tag: 'near-testnet', hl_mainnet: false, mpc_contract: 'x', tee_price_usd: '5', tee_fee_address: o.fee === undefined ? FEE : o.fee } as T;
      if (method === 'get_owner') return { nonce: 0, agent: null, frozen: false } as T;
      throw new Error(`view ${method}`);
    },
    async call<T>(_c: string, method: string, args: Record<string, unknown>, opts?: any) {
      log.push(`call:${method}`);
      calls.push({ method, args, opts });
      return { txHash: 'tx', value: (method === 'tee_approve_agent' ? SIGN_OUT(args.hl_address as string) : method === 'owner_execute' ? (o.ownerExecute ?? null) : null) as T };
    },
  };
  const client = new HyperNearClient({ contractId: 'leash.testnet', backend });
  const posts: any[] = [];
  const post = async (body: unknown) => {
    log.push('hl:post');
    posts.push(body);
    return { status: 'ok' };
  };
  const ledger: TeeLedgerPort = { feePaid: async () => o.ledger ?? true };
  return { client, log, calls, posts, post, ledger };
}

const scope = (w: ReturnType<typeof world>, mode: 'server' | 'tee', over: Partial<ConstructorParameters<typeof OwnerScope>[0]> = {}) =>
  new OwnerScope({ mode, client: w.client, legAddresses: async () => [LEG0], ledger: w.ledger, measurement: () => MEAS, account: () => ME, ...over });

describe('OwnerScope, server mode', () => {
  it('skips an owner whose get_tee is set and serves the others; the lookup is cached for 60 s', async () => {
    let t = 1_000_000;
    const w = world({ tee: TEE() });
    const s = scope(w, 'server', { now: () => t });
    expect(await s.serves(OWNER)).toBe(false);
    await s.serves(OWNER);
    expect(w.log.filter((l) => l === 'view:get_tee')).toHaveLength(1);
    t += 61_000;
    await s.serves(OWNER);
    expect(w.log.filter((l) => l === 'view:get_tee')).toHaveLength(2);
    expect(await scope(world(), 'server').serves(OWNER)).toBe(true);
  });

  it('filter() drops TEE owners and owners whose lookup fails (never cached), keeps the rest', async () => {
    const other = '0x0000000000000000000000000000000000000002';
    const w = world();
    let fail = true;
    const orig = w.client.getTee.bind(w.client);
    w.client.getTee = async (o: string) => (o === other && fail ? Promise.reject(new Error('rpc down')) : o === '0x0000000000000000000000000000000000000003' ? TEE() : orig(o));
    const s = scope(w, 'server');
    expect(await s.filter([OWNER, other, '0x0000000000000000000000000000000000000003'] as any)).toEqual([OWNER]);
    fail = false;
    expect(await s.filter([OWNER, other] as any)).toEqual([OWNER, other]);
  });

  it('an owner who left TEE mode (entry kept, measurement_hash null) is a server owner again, and not a TEE-mode one', async () => {
    const left = TEE({ measurement_hash: null as never });
    expect(await scope(world({ tee: left }), 'server').serves(OWNER)).toBe(true);
    expect(await scope(world({ tee: left }), 'tee').serves(OWNER)).toBe(false);
  });

  it('a contract without get_tee (older deployment) means nobody is in TEE mode', async () => {
    const w = world();
    const be = w.client.backend;
    const c = new HyperNearClient({ contractId: 'x', backend: { ...be, view: async (_c, m, a) => (m === 'get_tee' ? Promise.reject(new Error('MethodNotFound: get_tee')) : be.view(_c, m, a)) } as NearBackend });
    expect(await c.getTee(OWNER)).toBeNull();
  });

  it('running strategies stay on an unreadable contract and stop only on a definite "not served"', async () => {
    const w = world({ tee: TEE() });
    const s = scope(w, 'server');
    expect(await s.stillServes(OWNER)).toBe(false);
    w.client.getTee = async () => Promise.reject(new Error('rpc down'));
    expect(await scope(w, 'server').stillServes(OWNER)).toBe(true);
  });
});

describe('OwnerScope, tee mode', () => {
  const ok = (o: Parameters<typeof world>[0] = {}) => world({ tee: TEE(), ...o });
  it('serves an owner who chose this measurement, paid, and has the fee in the ledger', async () => {
    expect(await scope(ok(), 'tee').serves(OWNER)).toBe(true);
  });
  it.each([
    ['not in TEE mode', { tee: null }],
    ['another measurement', { tee: TEE({ measurement_hash: 'cd'.repeat(32) }) }],
    ['the owner named another instance of the same image (stranger)', { tee: TEE({ agent_account: 'b'.repeat(64) }) }],
    ['no agent account named', { tee: TEE({ agent_account: null }) }],
    ['paid_until in the past', { tee: TEE({ paid_until_ns: '1000' }) }],
    ['no fee address in the contract config', { fee: null }],
    ['fee not in the HL ledger', { ledger: false }],
  ])('refuses %s', async (_n, o) => {
    expect(await scope(ok(o as never), 'tee').serves(OWNER)).toBe(false);
  });
  it('serves nobody before it knows its own account', async () => {
    expect(await scope(ok(), 'tee', { account: () => undefined }).serves(OWNER)).toBe(false);
  });
  it('serves nobody before it knows its own measurement', async () => {
    expect(await scope(ok(), 'tee', { measurement: () => undefined }).serves(OWNER)).toBe(false);
  });
  it('the ledger check reads the owner legs, the price, and the fee address', async () => {
    const w = ok();
    const feePaid = vi.fn(async () => true);
    await scope(w, 'tee', { ledger: { feePaid } }).serves(OWNER);
    expect(feePaid).toHaveBeenCalledWith({ legAddresses: [LEG0], feeAddress: FEE, minUsd: 5 });
  });
  it('requires months_paid x price in the ledger: 2 months paid but one month landed is not served', async () => {
    const w = world({ tee: TEE({ months_paid: 2 }) });
    const rows = [{ time: 1, hash: '0x1', delta: { type: 'internalTransfer', user: LEG0, destination: FEE, usdc: '5' } }];
    const ledger = hlLedgerPort({ userNonFundingLedgerUpdates: async () => rows as never });
    expect(await scope(w, 'tee', { ledger }).serves(OWNER)).toBe(false);
    rows.push({ time: 2, hash: '0x2', delta: { type: 'internalTransfer', user: LEG0, destination: FEE, usdc: '5' } });
    expect(await scope(w, 'tee', { ledger }).serves(OWNER)).toBe(true);
  });
});

describe('hlLedgerPort', () => {
  const upd = (delta: Record<string, unknown>) => ({ time: 1, hash: '0x1', delta });
  const hl = (rows: unknown[]) => ({ userNonFundingLedgerUpdates: async () => rows as never });
  it('adds usdSends to the fee address (case-insensitive) and ignores other destinations and types', async () => {
    const port = hlLedgerPort(hl([
      upd({ type: 'internalTransfer', user: LEG0, destination: FEE.toUpperCase().replace('0X', '0x'), usdc: '3' }),
      upd({ type: 'internalTransfer', user: LEG0, destination: LEG1, usdc: '100' }),
      upd({ type: 'deposit', usdc: '100' }),
      upd({ type: 'send', user: LEG0, destination: FEE, usdcValue: '2' }),
    ]));
    expect(await port.feePaid({ legAddresses: [LEG0], feeAddress: FEE, minUsd: 5 })).toBe(true);
    expect(await port.feePaid({ legAddresses: [LEG0], feeAddress: FEE, minUsd: 5.01 })).toBe(false);
  });
});

describe('TEE boot', () => {
  const shade = (log: string[]) => ({
    accountId: () => 'a'.repeat(64),
    balance: async () => (log.push('shade:balance'), 0),
    fund: async () => void log.push('shade:fund'),
    getAttestation: async () => (log.push('shade:attest'), {
      quote: [1, 2, 3],
      collateral: {},
      tcb_info: { mrtd: 'm', rtmr0: 'r0', rtmr1: 'r1', rtmr2: 'r2', rtmr3: 'r3', event_log: [{ event: 'key-provider', digest: 'kp', event_payload: '' }, { event: 'compose-hash', digest: '', event_payload: 'cp' }] },
    }),
  });

  it('calls in order: fund, attestation, register_tee_agent, get_tee_agent, then per leg get_leg, tee_approve_agent, HL post', async () => {
    const w = world();
    const legs = new Legs({ client: w.client, dataDir: null, network: 'testnet', coins: ['BTC'] });
    const boot = await bootTee({ shade: shade(w.log), client: w.client, dev: false, expected: MEAS });
    expect(boot).toEqual({ account: 'a'.repeat(64), measurementHash: MEAS });
    const res = await enrollTeeOwner({ legs, client: w.client, post: w.post, owner: OWNER, now: () => 777 });
    expect(res.map((r) => [r.leg, r.ok])).toEqual([[0, true], [1, true]]);
    const first = (l: string) => w.log.indexOf(l);
    expect(w.log.slice(0, 6)).toEqual(['shade:balance', 'shade:fund', 'shade:attest', 'call:register_tee_agent', 'view:get_tee_agent', 'view:get_leg']);
    expect(first('call:register_tee_agent')).toBeLessThan(first('call:tee_approve_agent'));
    // per leg: the contract signs, then HL is told
    expect(w.log.filter((l) => l === 'call:tee_approve_agent' || l === 'hl:post')).toEqual(['call:tee_approve_agent', 'hl:post', 'call:tee_approve_agent', 'hl:post']);
    const reg = w.calls[0]!;
    expect(reg.args.attestation.quote).toEqual([1, 2, 3]);
    expect(reg.args.measurements).toEqual({ rtmrs: { mrtd: 'm', rtmr0: 'r0', rtmr1: 'r1', rtmr2: 'r2' }, key_provider_event_digest: 'kp', app_compose_hash_payload: 'cp' });
    expect(w.calls[1]).toMatchObject({ method: 'tee_approve_agent', args: { owner: OWNER, leg: 0, hl_address: res[0]!.agent, hl_nonce: 777 } });
    expect(w.posts[0].action).toMatchObject({ type: 'approveAgent', agentAddress: res[0]!.agent, agentName: 'leash-tee', hyperliquidChain: 'Testnet' });
    expect(legs.keys.get(OWNER, 0)).toMatchObject({ address: res[0]!.agent, approvedAt: expect.any(Number) });
  });

  it('dev boot registers without a quote', async () => {
    const w = world();
    await bootTee({ shade: shade(w.log), client: w.client, dev: true });
    expect(w.calls.map((c) => c.method)).toEqual(['register_tee_agent_dev']);
    expect(w.calls[0]!.args).not.toHaveProperty('attestation');
  });

  it('tops the agent account up only below 0.35 NEAR (a 300 TGas call reserves 0.3)', async () => {
    const rich = world();
    await bootTee({ shade: { ...shade(rich.log), balance: async () => 0.4 }, client: rich.client, dev: true, fundNear: 0.15 });
    expect(rich.log).not.toContain('shade:fund');
    const poor = world();
    await bootTee({ shade: { ...shade(poor.log), balance: async () => 0.25 }, client: poor.client, dev: true, fundNear: 0.15 });
    expect(poor.log).toContain('shade:fund');
  });

  it('refuses to serve when the registered measurement is not the published one, or registration left no record', async () => {
    await expect(bootTee({ shade: shade([]), client: world().client, dev: false, expected: 'cd'.repeat(32) })).rejects.toThrow(/refusing to serve/);
    await expect(bootTee({ shade: shade([]), client: world({ teeAgent: null }).client, dev: false })).rejects.toThrow(/empty/);
  });

  it('every boot gets fresh keys; a failed HL post leaves the key unapproved', async () => {
    const w = world();
    const legs = new Legs({ client: w.client, dataDir: null, network: 'testnet', coins: ['BTC'] });
    const a = await enrollTeeOwner({ legs, client: w.client, post: w.post, owner: OWNER });
    const b = await enrollTeeOwner({ legs, client: w.client, post: async () => ({ status: 'err', response: 'Must deposit' }), owner: OWNER });
    expect(b[0]!.agent).not.toBe(a[0]!.agent);
    expect(b.map((r) => r.ok)).toEqual([false, false]);
    expect(legs.keys.get(OWNER, 0)!.approvedAt).toBeUndefined();
  });

  it('the shade backend signs calls with the TEE account (gas in TGas) and refuses other contracts', async () => {
    const shadeCall = vi.fn(async () => 'v');
    const be = shadeBackend({ call: shadeCall as never }, 'leash.testnet', 'http://127.0.0.1:1');
    expect(await be.call('leash.testnet', 'rebalance', { a: 1 }, { gasTgas: 300 })).toEqual({ txHash: '', value: 'v' });
    expect(shadeCall).toHaveBeenCalledWith(expect.objectContaining({ methodName: 'rebalance', gas: 300n * 10n ** 12n }));
    await expect(be.call('other.testnet', 'x', {})).rejects.toThrow(/only calls/);
  });

  it('measurementsFrom zero-fills what a fake attestation lacks', () => {
    const m = measurementsFrom({ mrtd: 'a', rtmr0: 'b', rtmr1: 'c', rtmr2: 'd' });
    expect(m.key_provider_event_digest).toMatch(/^0{96}$/);
    expect(m.app_compose_hash_payload).toMatch(/^0{64}$/);
  });
});

describe('no key reaches disk in TEE mode', () => {
  it('a memory key store and a full enrolment make no fs write; the server store does', async () => {
    fsSpy.writes.length = 0;
    const w = world();
    const legs = new Legs({ client: w.client, dataDir: null, network: 'testnet', coins: ['BTC'] });
    await enrollTeeOwner({ legs, client: w.client, post: w.post, owner: OWNER });
    expect(legs.keys.owners()).toEqual([OWNER]);
    expect(legs.keys.signer(OWNER, 0).address).toBeTruthy(); // usable as a signer, from memory
    expect(fsSpy.writes).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'leash-tee-'));
    new AgentKeyStore(dir).ensure(OWNER, 0); // control: the spy does see a disk store
    expect(fsSpy.writes.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- HTTP: /agents/prepare in both modes

let server: Server | undefined;
afterEach(() => void server?.close());
async function serve(d: Deps) {
  server?.close();
  server = createServer(handler(d));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function deps(w: ReturnType<typeof world>, mode: 'server' | 'tee') {
  const config = { ...loadConfig({}), nearAgent: { accountId: 'agent.testnet', secretKey: 'x' } };
  const legs = new Legs({ client: w.client, dataDir: mode === 'tee' ? null : mkdtempSync(join(tmpdir(), 'leash-tee-')), network: 'testnet', coins: ['BTC'] });
  legs.snapshot = async () => snap(ch());
  const bus = new EventBus();
  const d: Deps = {
    config, client: w.client, legs, hedger: new Hedger(legs, config.policy, bus), bus, replay: new ReplayCache(), guardConfig: DEFAULT_GUARD_CONFIG,
    relayer: new Relayer(w.client, new RateLimiter(5), w.post, bus),
    scope: scope(w, mode),
    tee: mode === 'tee' ? { client: w.client, account: 'a'.repeat(64), measurementHash: MEAS } : undefined,
  };
  return d;
}

describe('POST /agents/prepare by run mode', () => {
  it('server mode refuses an owner who chose TEE (403) and prepares one who did not', async () => {
    const base = await serve(deps(world({ tee: TEE() }), 'server'));
    const r = await post(`${base}/agents/prepare`, await signed(newCommand(OWNER, 'prepareAgents', '')));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/TEE agent/);
    const ok = await post(`${await serve(deps(world(), 'server'))}/agents/prepare`, await signed(newCommand(OWNER, 'prepareAgents', '')));
    expect(ok.status).toBe(200);
  });

  it('tee mode refuses an owner who is not a paid TEE owner of this image', async () => {
    for (const w of [world(), world({ tee: TEE(), ledger: false }), world({ tee: TEE({ measurement_hash: 'cd'.repeat(32) }) })]) {
      const r = await post(`${await serve(deps(w, 'tee'))}/agents/prepare`, await signed(newCommand(OWNER, 'prepareAgents', '')));
      expect(r.status).toBe(403);
      expect(w.calls.filter((c) => c.method === 'tee_approve_agent')).toEqual([]);
      server?.close();
    }
  });

  it('tee mode enrols a paid TEE owner: contract-signed approveAgent per leg, posted to HL, keys only in memory', async () => {
    fsSpy.writes.length = 0;
    const w = world({ tee: TEE() });
    const d = deps(w, 'tee');
    const r = await (await post(`${await serve(d)}/agents/prepare`, await signed(newCommand(OWNER, 'prepareAgents', '')))).json();
    expect(r).toMatchObject({ owner: OWNER, tee: true, pendingApprovals: [] });
    expect(r.legs.map((l: any) => [l.leg, l.ok])).toEqual([[0, true], [1, true]]);
    expect(w.posts).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-f]{64}\b/); // no private key in the answer
    expect(fsSpy.writes).toEqual([]);
  });
});

describe('setTee / payTee intents through the relayer', () => {
  const sig = `0x${'ab'.repeat(65)}`;
  it('parseRelayBody accepts setTee and payTee', () => {
    expect(parseRelayBody({ owner: OWNER, nonce: 1, sig, intent: { type: 'setTee', measurementHash: `0x${'00'.repeat(32)}`, agentAccount: '' } }).intent.type).toBe('setTee');
    expect(parseRelayBody({ owner: OWNER, nonce: 2, sig, intent: { type: 'payTee', leg: 0, months: 1 } }).intent.type).toBe('payTee');
  });

  it('payTee: the contract-signed usdSend goes to HL and the answer says whether it landed', async () => {
    const usdSend = { payload: 'ab', big_r: `02${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id: 1, action: { type: 'usdSend', destination: FEE, amount: '1', time: 5 } };
    const w = world({ ownerExecute: usdSend });
    const out = await new Relayer(w.client, new RateLimiter(5), w.post).relay('ip', { owner: OWNER, nonce: 2, sig, intent: { type: 'payTee', leg: 0, months: 1 } });
    expect(out).toMatchObject({ kind: 'payTee', leg: 0, months: 1, ok: true });
    expect(w.posts[0].action).toMatchObject({ type: 'usdSend', destination: FEE, amount: '1', hyperliquidChain: 'Testnet' });
    expect(w.log.indexOf('call:owner_execute')).toBeLessThan(w.log.indexOf('hl:post'));
  });

  it('setTee that burns the old leash-tee keys is a teeSwitch (not a freeze): posted to HL and sent over SSE', async () => {
    const burn = [{ leg: 0, name: 'leash-tee', burn_address: '0x000000000000000000000000000000000000dEaD', signature: SIGN_OUT('0x000000000000000000000000000000000000dead') }];
    const w = world({ ownerExecute: burn });
    const bus = new EventBus();
    const out = await new Relayer(w.client, new RateLimiter(5), w.post, bus).relay('ip', { owner: OWNER, nonce: 3, sig, intent: { type: 'setTee', measurementHash: `0x${'00'.repeat(32)}`, agentAccount: '' } });
    expect(out).toMatchObject({ kind: 'teeSwitch', owner: OWNER, revoked: [{ leg: 0, name: 'leash-tee', ok: true }] });
    expect(w.posts).toHaveLength(1);
    expect(bus.since(0).map((e) => e.type)).toEqual(expect.arrayContaining(['agents.revoked', 'tee.switched']));
    // a freeze with the same answer shape stays a freeze
    const f = await new Relayer(world({ ownerExecute: burn }).client, new RateLimiter(5), w.post).relay('ip', { owner: OWNER, nonce: 4, sig, intent: { type: 'freeze', frozen: true } });
    expect(f.kind).toBe('freeze');
  });

  it('payTeeIntent reads the price and fee address from get_config (micro-USD)', async () => {
    expect(await world().client.payTeeIntent(0, 2)).toEqual({ type: 'payTee', leg: 0, months: 2, priceMicro: 5_000_000, feeAddress: FEE });
    await expect(world({ fee: null }).client.payTeeIntent(0, 1)).rejects.toThrow(/not offered/);
  });
});

describe('stable TEE account', () => {
  it('the same seed gives the same implicit account and key; another seed another one', () => {
    const a = accountFromSeed('seed-1');
    expect(accountFromSeed('seed-1')).toEqual(a);
    expect(accountFromSeed('seed-2').accountId).not.toBe(a.accountId);
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/); // a NEAR implicit account: the hex ed25519 public key
    expect(a.secretKey).toMatch(/^ed25519:/);
  });

  it('dstack: the key from getKey at the fixed path decides the account (same app key, same account across boots)', async () => {
    const paths: string[] = [];
    const dstack = (k: number) => ({ getKey: async (p: string) => (paths.push(p), { key: new Uint8Array(32).fill(k) }) });
    const a = await teeAccount({ dev: false, dstack: dstack(7) });
    expect(await teeAccount({ dev: false, dstack: dstack(7) })).toEqual(a);
    expect((await teeAccount({ dev: false, dstack: dstack(8) })).accountId).not.toBe(a.accountId);
    expect(new Set(paths)).toEqual(new Set(['hypernear/near-account/v1']));
  });

  it('dev derives from HYPERNEAR_TEE_DEV_SEED, never from a dstack key, and refuses to run without a seed', async () => {
    const dev = await teeAccount({ dev: true, devSeed: 'lab' });
    expect(dev).toEqual(await teeAccount({ dev: true, devSeed: 'lab' }));
    expect(dev.accountId).not.toBe((await teeAccount({ dev: false, dstack: { getKey: async () => ({ key: Buffer.from('lab') }) } })).accountId);
    await expect(teeAccount({ dev: true })).rejects.toThrow(/HYPERNEAR_TEE_DEV_SEED/);
  });

  it('pinAccount swaps the account shade-agent-js would sign and attest with, and fails loudly if the layout changes', () => {
    const a = accountFromSeed('seed-1');
    const shade = { agentAccountId: 'random', agentPrivateKeys: ['ed25519:x'], accountId() { return this.agentAccountId; } };
    pinAccount(shade, a);
    expect(shade.accountId()).toBe(a.accountId);
    expect(shade.agentPrivateKeys).toEqual([a.secretKey]);
    expect(() => pinAccount({ accountId: () => 'renamed' }, a)).toThrow(/layout changed/);
  });
});

describe('TEE dev mode guard', () => {
  it('refuses HYPERNEAR_TEE_DEV=1 on mainnet and allows it on testnet', async () => {
    const { loadConfig } = await import('../src/config.ts');
    expect(() => loadConfig({ HYPERNEAR_TEE_DEV: '1', NEAR_NETWORK: 'mainnet' })).toThrow(/testnet-only/);
    expect(loadConfig({ HYPERNEAR_TEE_DEV: '1' }).tee.dev).toBe(true);
  });
});

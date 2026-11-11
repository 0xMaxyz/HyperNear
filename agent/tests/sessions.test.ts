import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { commandTypedData, newCommand, newSessionSpec, specHashOfJson, type CommandAction } from '@hypernear/client';
import { buildDryRunDeps, DRY_CONTRACT_ID } from '../src/dryrun.ts';
import { handler } from '../src/server.ts';
import { ReplayCache, verifyCommand, verifySessionCommand } from '../src/commands.ts';
import { parseSessionSpec, sessionPolicy, SessionStore } from '../src/sessions.ts';
import type { OrderPolicy } from '../src/config.ts';

// the fixtures' owner is the well-known PUBLIC web3 test key (never funded)
const owner = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const OWNER = owner.address.toLowerCase() as `0x${string}`;
const POLICY: OrderPolicy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.01 };
const nowSec = () => Math.floor(Date.now() / 1000);

let n = 0;
const sign = async (by: PrivateKeyAccount, action: CommandAction, spec?: unknown, coin = '') => {
  const command = newCommand(OWNER, action, coin, '0', 30, Date.now() + ++n, spec === undefined ? undefined : specHashOfJson(spec));
  return { command, sig: await by.signTypedData(commandTypedData('near-testnet', DRY_CONTRACT_ID, command) as never), ...(spec !== undefined && { spec }) };
};
const keyOf = (a: PrivateKeyAccount) => a.address.toLowerCase() as `0x${string}`;

describe('session spec and store', () => {
  it('parses a good spec and refuses bad lifetimes, unknown actions, extra fields, the owner as key and coins off-policy', () => {
    const k = keyOf(privateKeyToAccount(generatePrivateKey()));
    expect(parseSessionSpec(newSessionSpec(k, 3600), OWNER, POLICY, nowSec()).ok).toBe(true);
    const bad = (spec: unknown, re: RegExp) => {
      const r = parseSessionSpec(spec, OWNER, POLICY, nowSec());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(re);
    };
    bad(newSessionSpec(k, 10), /must last/);
    bad(newSessionSpec(k, 25 * 3600), /must last/);
    bad({ ...newSessionSpec(k), actions: ['placeOrder', 'startStrategy'] }, /subset/);
    bad({ ...newSessionSpec(k), actions: [] }, /subset/);
    bad({ ...newSessionSpec(k), extra: 1 }, /unknown spec fields/);
    bad(newSessionSpec(OWNER), /must not be the owner/);
    bad(newSessionSpec(k, 3600, Date.now(), { coins: ['DOGE'] }), /outside the order policy/);
    bad(newSessionSpec(k, 3600, Date.now(), { maxLeverage: 1.5 }), /whole number/);
  });

  it('narrows the policy, never widens it', () => {
    const k = keyOf(privateKeyToAccount(generatePrivateKey()));
    expect(sessionPolicy(POLICY, newSessionSpec(k, 3600, Date.now(), { maxNotionalUsd: 50, maxLeverage: 10, coins: ['BTC'] }))).toEqual({ ...POLICY, maxNotionalUsd: 50, maxLeverage: 5, allowedCoins: ['BTC'] });
    expect(sessionPolicy(POLICY, newSessionSpec(k, 3600, Date.now(), { maxNotionalUsd: 500 })).maxNotionalUsd).toBe(100);
    expect(sessionPolicy(POLICY)).toBe(POLICY);
  });

  it('expires sessions, caps them per owner (oldest ends first) and revokes all at once', () => {
    let t = 1_000_000_000_000;
    const store = new SessionStore(2, () => t);
    const ks = [0, 1, 2].map(() => keyOf(privateKeyToAccount(generatePrivateKey())));
    store.start(OWNER, newSessionSpec(ks[0]!, 60, t));
    t += 1000;
    store.start(OWNER, newSessionSpec(ks[1]!, 3600, t));
    t += 1000;
    store.start(OWNER, newSessionSpec(ks[2]!, 3600, t));
    expect(store.list(OWNER).map((s) => s.key)).toEqual([ks[1], ks[2]]);
    t += 3600 * 1000;
    expect(store.get(OWNER, ks[1]!)).toBeUndefined();
    store.start(OWNER, newSessionSpec(ks[0]!, 3600, t));
    expect(store.revokeAll(OWNER)).toBe(1);
    expect(store.list(OWNER)).toEqual([]);
  });
});

describe('verifySessionCommand', () => {
  const v = () => ({ chainTag: async () => 'near-testnet' as const, contractId: DRY_CONTRACT_ID, cache: new ReplayCache() });
  it('accepts the owner or a live session key for its actions only; verifyCommand never accepts a session key', async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const store = new SessionStore();
    const spec = { leg: 2, coin: 'BTC' };
    // before the session exists the key is just a wrong signer
    await expect(verifySessionCommand(v(), await sign(key, 'placeOrder', spec), 'placeOrder', store)).rejects.toThrow(/does not match/);
    store.start(OWNER, newSessionSpec(keyOf(key), 3600, Date.now(), {}, ['placeOrder']));
    const ok = await verifySessionCommand(v(), await sign(key, 'placeOrder', spec), 'placeOrder', store);
    expect(ok.session?.key).toBe(keyOf(key));
    expect((await verifySessionCommand(v(), await sign(owner, 'placeOrder', spec), 'placeOrder', store)).session).toBeUndefined();
    // not in this session's actions
    await expect(verifySessionCommand(v(), await sign(key, 'cancelOrder', spec), 'cancelOrder', store)).rejects.toThrow(/may not sign cancelOrder/);
    // owner-only routes: a session key can never start another session or do anything else
    await expect(verifyCommand(v(), await sign(key, 'startSession', newSessionSpec(keyOf(key))), 'startSession')).rejects.toThrow(/does not match/);
    await expect(verifyCommand(v(), await sign(key, 'closeHedge', undefined, 'BTC'), 'closeHedge')).rejects.toThrow(/does not match/);
    // endSession: only of its own key
    await expect(verifySessionCommand(v(), await sign(key, 'endSession', undefined, OWNER), 'endSession', store)).rejects.toThrow(/may not sign endSession/);
    expect((await verifySessionCommand(v(), await sign(key, 'endSession', undefined, keyOf(key)), 'endSession', store)).session).toBeDefined();
  });
});

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});
async function serve() {
  server = createServer(handler(buildDryRunDeps('hedged', { replayStartMs: 0, replaySpeed: 1000 })));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('--dry-run --serve: 1-click sessions', () => {
  it('owner starts a session; the key places and cancels within its caps; it cannot start another; endSession ends it', async () => {
    const base = await serve();
    const key = privateKeyToAccount(generatePrivateKey());
    const spec = newSessionSpec(keyOf(key), 3600, Date.now(), { maxNotionalUsd: 30 });
    // the key cannot start its own session
    expect((await post(`${base}/session/start`, await sign(key, 'startSession', spec))).status).toBe(401);
    const started = await post(`${base}/session/start`, await sign(owner, 'startSession', spec));
    expect(started.status).toBe(200);
    expect((await started.json()).policy.maxNotionalUsd).toBe(30);
    expect((await (await fetch(`${base}/owner/${OWNER}`)).json()).sessions).toEqual([expect.objectContaining({ key: keyOf(key), maxNotionalUsd: 30 })]);

    const small = { leg: 2, coin: 'BTC', side: 'buy', type: 'market', size: '0.0002', leverage: 4 };
    expect((await post(`${base}/order/place`, await sign(key, 'placeOrder', small))).status).toBe(200);
    // over the session's own cap, though inside the agent's policy for the owner
    const big = { ...small, size: '0.0006' };
    const refused = await post(`${base}/order/place`, await sign(key, 'placeOrder', big));
    expect(refused.status).toBe(422);
    expect((await post(`${base}/order/cancel`, await sign(key, 'cancelOrder', { leg: 2, coin: 'BTC', all: true }))).status).toBe(200);

    const ended = await (await post(`${base}/session/end`, await sign(key, 'endSession', undefined, keyOf(key)))).json();
    expect(ended.ended).toBe(true);
    expect((await post(`${base}/order/place`, await sign(key, 'placeOrder', small))).status).toBe(401);
    expect((await (await fetch(`${base}/sessions/${OWNER}`)).json()).sessions).toEqual([]);
  });

  it('a relayed freeze ends every session of the owner', async () => {
    const base = await serve();
    const key = privateKeyToAccount(generatePrivateKey());
    expect((await post(`${base}/session/start`, await sign(owner, 'startSession', newSessionSpec(keyOf(key))))).status).toBe(200);
    await post(`${base}/relay`, { owner: OWNER, nonce: 0, intent: { type: 'freeze' }, sig: `0x${'11'.repeat(65)}` });
    expect((await (await fetch(`${base}/sessions/${OWNER}`)).json()).sessions).toEqual([]);
  });
});

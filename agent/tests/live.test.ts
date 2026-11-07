// LIVE=1 only (ci32, testnet): the D3 agent flow end to end with the test owner, and fixture recording.
//   register legs 0/1 -> fund from lab wallet #2 -> approve one HL agent per leg (owner-mode NearMasterSigner)
//   -> leg0 long BTC ~$30 at 3x -> openHedge(BTC, 0.5) on leg1 -> closeHedge -> both flat.
//   Then leg2 near liquidation (max leverage, initial margin ~= a ~$3 account) for the third fixture, closed again.
// Needs: ~/.near-credentials/testnet/<contract>.json (relayer), LAB_WALLETS_PATH (index 2), and HYPERNEAR_TEST_OWNER_KEY
// or NEAR_NETWORK=testnet (public test key). Writes agent/fixtures/*.json and agent/results/D3-live.json.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount, nearApiBackend, type NearBackend } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { fillOf, Hedger } from '../src/hedge.ts';
import { Legs, type OwnerSnapshot } from '../src/legs.ts';
import { agentKeySigner, floorSize, hlClient, position, roundPx } from '../src/market.ts';
import { POLICY } from './agent-helpers.ts';

const LIVE = process.env.LIVE === '1' && Boolean(process.env.LAB_WALLETS_PATH);
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const RPC = 'https://test.rpc.fastnear.com';
const FIXTURES = new URL('../fixtures/', import.meta.url);
const RESULTS = new URL('../results/', import.meta.url);

function ownerKey(): Hex {
  if (process.env.HYPERNEAR_TEST_OWNER_KEY) return process.env.HYPERNEAR_TEST_OWNER_KEY as Hex;
  if (process.env.NEAR_NETWORK === 'testnet') return PUBLIC_TEST_OWNER_KEY;
  throw new Error('set HYPERNEAR_TEST_OWNER_KEY, or NEAR_NETWORK=testnet to use the public test key');
}

/** Lab wallet #2's key; read here, used as a signer, never printed. */
function labWallet2(): Hex {
  const rows = JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH!, 'utf8')) as Array<{ index: number; privateKey: string }>;
  const row = rows.find((r) => r.index === 2);
  if (!row) throw new Error('lab wallet 2 not found');
  return row.privateKey as Hex;
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const szi = (s: OwnerSnapshot, leg: number, coin = 'BTC') => Number(position(s.legs.find((l) => l.leg === leg)!.clearinghouse, coin)?.szi ?? 0);
const total = (s: OwnerSnapshot, leg: number) => {
  const l = s.legs.find((x) => x.leg === leg)!;
  return Number(l.clearinghouse.marginSummary.accountValue) + l.spotUsdc;
};

function saveFixture(name: string, description: string, snapshot: OwnerSnapshot) {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(new URL(`${name}.json`, FIXTURES), JSON.stringify({ name, description, recordedAt: new Date().toISOString(), snapshot }, null, 2) + '\n');
}

describe.skipIf(!LIVE)('live D3: legs, agents, hedge open/close on HL testnet', () => {
  it('runs the flow, both legs end flat, fixtures recorded', async () => {
    const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
    const cred = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8'));
    const nearTxs: { method: string; txHash: string }[] = [];
    const inner = nearApiBackend({ rpcUrl: RPC, sender: nearAccount(contractId, cred.private_key, RPC) });
    const backend: NearBackend = {
      view: inner.view,
      async call(c, method, args, o) {
        const r = await inner.call<any>(c, method, args, o);
        nearTxs.push({ method, txHash: r.txHash });
        return r;
      },
    };
    const client = new HyperNearClient({ contractId, backend });
    const owner = privateKeyToAccount(ownerKey());
    const o = owner.address.toLowerCase() as Hex;
    const signOwnerIntent = (td: any) => owner.signTypedData(td);
    const dataDir = process.env.HYPERNEAR_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'hypernear-agent-'));
    const bus = new EventBus();
    const legs = new Legs({ client, dataDir, network: 'testnet', coins: ['BTC'] });
    const hedger = new Hedger(legs, POLICY, bus);
    const results: Record<string, unknown> = { owner: o, contractId, nearTxs, orders: {} };
    const orders = results.orders as Record<string, unknown>;

    // 1. legs + funding from lab wallet #2
    const addr = [await client.registerLeg(o, 0), await client.registerLeg(o, 1)];
    const funder = hlClient('testnet', { master: agentKeySigner(labWallet2()) });
    let s = await legs.snapshot(o);
    for (const [leg, want] of [[0, 14], [1, 9]] as const) {
      if (total(s, leg) < want) {
        orders[`fund-leg${leg}`] = await funder.usdSend({ destination: addr[leg]!, amount: String(Math.ceil(want - total(s, leg)) + 1) });
      }
    }
    s = await until(() => legs.snapshot(o), (x) => total(x, 0) >= 14 && total(x, 1) >= 9, 'leg funding');

    // 2. one HL agent per leg, approved through the contract
    results.agents = await legs.approveAgents(o, [0, 1], signOwnerIntent);
    if (szi(s, 0) === 0 && szi(s, 1) === 0) saveFixture('flat', 'two funded legs, no position', s);

    // 3. leg0 base position: long BTC ~$30 at 3x (the position the hedge mirrors)
    const btc = s.market.assets.find((a) => a.name === 'BTC')!;
    const mid = Number(s.market.mids.BTC);
    const leg0 = legs.tradingClient(o, 0);
    if (szi(s, 0) === 0) {
      await leg0.updateLeverage({ asset: btc.asset, isCross: true, leverage: 3 });
      const size = (Math.ceil((30 / mid) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
      const r = await leg0.limitOrderOpen({ asset: btc.asset, isBuy: true, price: roundPx(mid * 1.03, btc.szDecimals), size, tif: 'Ioc' });
      orders.leg0Open = fillOf(r);
      s = await until(() => legs.snapshot(o), (x) => szi(x, 0) > 0, 'leg0 position');
    }

    // 4. the hedge: leg1 short 0.5 x leg0 at the same leverage
    const t0 = performance.now();
    const opened = await hedger.openHedge(o, 'BTC', 0.5);
    orders.hedgeOpen = { plan: opened.plan, fill: opened.fill, ms: Math.round(performance.now() - t0) };
    s = await until(() => legs.snapshot(o), (x) => szi(x, 1) < 0, 'leg1 hedge');
    expect(szi(s, 1)).toBeCloseTo(-Number(floorSize(szi(s, 0) * 0.5, btc.szDecimals)), 8);
    saveFixture('hedged', 'leg0 long BTC at 3x, leg1 short 0.5x of it at 3x (after openHedge)', s);

    // 5. close both legs
    const closed = await hedger.closeHedge(o, 'BTC');
    orders.hedgeClose = closed.results.map((r) => ({ leg: r.order.leg, fill: r.fill }));
    s = await until(() => legs.snapshot(o), (x) => szi(x, 0) === 0 && szi(x, 1) === 0, 'both legs flat');
    results.finalSzi = { leg0: szi(s, 0), leg1: szi(s, 1) };

    // 6. third fixture: leg2 (~$3) at max leverage with initial margin ~= account value, i.e. ~2x maintenance, then closed
    const addr2 = await client.registerLeg(o, 2);
    s = await legs.snapshot(o);
    if (total(s, 2) < 2.9) {
      // +1 USDC activation fee on a never-funded address
      orders['fund-leg2'] = await funder.usdSend({ destination: addr2, amount: String(Math.ceil(3 - total(s, 2)) + (total(s, 2) > 0 ? 0 : 1)) });
      s = await until(() => legs.snapshot(o), (x) => total(x, 2) >= 2.9, 'leg2 funding');
    }
    await legs.approveAgents(o, [2], signOwnerIntent);
    const leg2 = legs.tradingClient(o, 2);
    const av = Number(s.legs.find((l) => l.leg === 2)!.clearinghouse.marginSummary.accountValue);
    await leg2.updateLeverage({ asset: btc.asset, isCross: true, leverage: btc.maxLeverage });
    let opened2: unknown;
    const attempts: unknown[] = [];
    orders.leg2Attempts = attempts;
    const mid2 = Number(s.market.mids.BTC);
    const step = 10 ** -btc.szDecimals;
    const maxSize = Number(floorSize((av * btc.maxLeverage) / mid2, btc.szDecimals));
    for (let k = 0; k < 4; k++) {
      // largest size whose initial margin fits, then one size step down at a time
      const size = (maxSize - k * step).toFixed(btc.szDecimals);
      const f = (Number(size) * mid2) / (av * btc.maxLeverage);
      try {
        opened2 = fillOf(await leg2.limitOrderOpen({ asset: btc.asset, isBuy: true, price: roundPx(mid2 * 1.01, btc.szDecimals), size, tif: 'Ioc' }));
        orders.leg2Open = { fraction: f, size, fill: opened2 };
        break;
      } catch (e) {
        attempts.push({ fraction: f, error: (e as Error).message });
      }
    }
    if (opened2) {
      s = await until(() => legs.snapshot(o), (x) => szi(x, 2) > 0, 'leg2 position');
      saveFixture('near-liquidation', `leg2: ~$${av.toFixed(2)} account long BTC at ${btc.maxLeverage}x cross (initial margin ~= account value)`, s);
      const p = szi(s, 2);
      orders.leg2Close = fillOf(await leg2.limitOrderOpen({ asset: btc.asset, isBuy: false, price: roundPx(mid2 * 0.97, btc.szDecimals), size: p.toFixed(btc.szDecimals), tif: 'Ioc', reduceOnly: true }));
      s = await until(() => legs.snapshot(o), (x) => szi(x, 2) === 0, 'leg2 flat');
    }
    results.finalSzi = { ...(results.finalSzi as object), leg2: szi(s, 2) };
    results.events = bus.since().map((e) => ({ type: e.type, data: e.data }));

    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(new URL('D3-live.json', RESULTS), JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
    console.log(JSON.stringify({ nearTxs, orders, finalSzi: results.finalSzi }, null, 1));
    expect(results.finalSzi).toEqual({ leg0: 0, leg1: 0, leg2: 0 });
  }, 900_000);
});

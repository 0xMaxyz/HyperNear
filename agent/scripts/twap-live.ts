// Phase 2 live run (testnet): a DCA/TWAP on strategy leg 3, with a service restart in the middle.
//   NEAR_NETWORK=testnet node agent/scripts/twap-live.ts
// Needs leg 3 registered, funded and approved (run agent/scripts/grid-live.ts once first). Steps: validate + start a 4-slice BTC buy
// (one IOC slice per 15 s, never above limitPx) -> after 2 slices pause and stop the service -> leave a resting order on the leg
// (what a crashed process would leave) -> a new manager restores the saved strategy PAUSED, cancels the orphan -> the identical
// spec resumes it -> the remaining slices run -> stop with onStop flatten. Keys (never printed): ~/.near-credentials/testnet/<contract>.json,
// HYPERNEAR_DATA_DIR/agent-keys.json. Owner = HYPERNEAR_TEST_OWNER_KEY or the public test key (testnet only).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { Legs } from '../src/legs.ts';
import { position, roundPx } from '../src/market.ts';
import { StrategyManager } from '../src/strategy/manager.ts';
import { hlPort } from '../src/strategy/port.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const LEG = 3;
const TICK_MS = 5000;
const SLICES = 4;
const INTERVAL_SEC = 15;

const keyOf = (id: string) => JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${id}.json`, 'utf8')).private_key as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
const nearAgentId = process.env.HYPERNEAR_AGENT_ACCOUNT_ID ?? `fcagent.${contractId}`;
const ownerKey = (process.env.HYPERNEAR_TEST_OWNER_KEY ?? PUBLIC_TEST_OWNER_KEY) as Hex;
if (!process.env.HYPERNEAR_TEST_OWNER_KEY && process.env.NEAR_NETWORK !== 'testnet') throw new Error('set NEAR_NETWORK=testnet to use the public test key');
const ow = privateKeyToAccount(ownerKey).address.toLowerCase() as Hex;

const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, keyOf(contractId), RPC) });
const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
const policy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
const legAddr = await client.getLeg(ow, LEG);
if (!legAddr || !legs.keys.get(ow, LEG)?.approvedAt) throw new Error(`leg ${LEG} is not registered/approved: run agent/scripts/grid-live.ts first`);
const szi = async () => Number(position(await legs.hl.clearinghouseState({ user: legAddr }), 'BTC')?.szi ?? 0);
const equity = async () => Number((await legs.hl.clearinghouseState({ user: legAddr })).marginSummary.accountValue);
const equityBefore = await equity();
if (equityBefore < 15) throw new Error(`leg ${LEG} holds $${equityBefore.toFixed(2)}: fund it first`);
await (await hlPort(legs, ow, LEG)).flatten('BTC');

const universe = (await legs.hl.meta()).universe;
const btc = universe.findIndex((u) => u.name === 'BTC');
const szDecimals = universe[btc]!.szDecimals;
const mid = Number((await legs.hl.allMids()).BTC);
const spec = {
  id: 'dca-live-1', type: 'twap', leg: LEG, coin: 'BTC',
  params: { side: 'buy', sizePerSlice: (Math.ceil((10.6 / mid) * 10 ** szDecimals) / 10 ** szDecimals).toFixed(szDecimals), slices: SLICES, intervalSec: INTERVAL_SEC, limitPx: Math.round(mid * 1.02) },
  limits: { maxNotional: 100, maxLeverage: 3, maxDailyLoss: 5, topUpCapPerDay: 20 },
  onStop: 'flatten',
};

const dataDir = mkdtempSync(join(tmpdir(), 'hypernear-twap-'));
const bus = new EventBus();
const events: { t: number; type: string; data: unknown }[] = [];
const t0 = Date.now();
bus.subscribe((e) => {
  if (!e.type.startsWith('strategy.')) return;
  events.push({ t: e.at - t0, type: e.type, data: e.data });
  console.log(`  +${((e.at - t0) / 1000).toFixed(1)}s ${e.type} ${JSON.stringify(e.data).slice(0, 200)}`);
});
const mk = () => new StrategyManager({ legs, client, policy, emit: (t, d) => void bus.emit(t, d), agentId: nearAgentId, intervalMs: TICK_MS, dataDir });
const count = (type: string) => events.filter((e) => e.type === type).length;

let ok = false;
let restored: unknown;
let resumedState: unknown;
let posBeforeFlatten = NaN;
let m1 = mk();
let m2: StrategyManager | undefined;
try {
  const v = await m1.validate(ow, spec);
  if (!v.ok) throw new Error(`spec refused: ${v.errors.join('; ')}`);
  await m1.start(ow, v.spec);
  await until(async () => count('strategy.slice'), (n) => n >= 2, 'two slices');

  // the service "dies": pause, stop the timers, leave an order resting on the leg like a crashed process would
  await m1.pause(ow, spec.id, 'service restart (live run)');
  m1.shutdown();
  const port = await hlPort(legs, ow, LEG);
  const px = roundPx(mid * 0.97, szDecimals);
  const orphan = await port.place({ asset: btc, isBuy: true, px, sz: spec.params.sizePerSlice, reduceOnly: false, tif: 'Alo' });
  console.log(`orphan resting order: ${JSON.stringify(orphan)}`);

  m2 = mk();
  restored = await m2.restore();
  console.log(`restored: ${JSON.stringify(restored)}; state ${JSON.stringify(m2.list(ow))}`);
  resumedState = m2.list(ow)[0];
  const orphansLeft = (await legs.hl.openOrders({ user: legAddr })).length;
  if (orphansLeft) throw new Error(`${orphansLeft} orders still resting after restore`);

  const again = await m2.validate(ow, spec); // identical spec: resumes the paused strategy
  if (!again.ok) throw new Error(`resume refused: ${again.errors.join('; ')}`);
  await m2.start(ow, again.spec);
  await until(async () => m2!.list(ow)[0]?.state, (s) => s === 'done', 'all slices', 180_000);
  posBeforeFlatten = await szi();
  ok = true;
} finally {
  for (const m of [m1, m2]) {
    if (!m) continue;
    await m.stop(ow, spec.id, 'end of run').catch(() => {});
    m.shutdown();
  }
  const posAfter = await until(szi, (n) => n === 0, 'flat after stop', 30_000).catch((e) => `not flat: ${(e as Error).message}`);
  const slices = events.filter((e) => e.type === 'strategy.slice').map((e) => e.data);
  const result = {
    at: new Date(t0).toISOString(), owner: ow, leg: LEG, legAddress: legAddr, ok, spec,
    restart: { restoredAs: resumedState, restoreResult: restored, note: 'saved strategy came back paused, the resting order left on the leg was cancelled, the identical spec resumed it with its slice count intact' },
    slices, positionBeforeFlatten: posBeforeFlatten, positionAfterStop: posAfter,
    equityUsd: { before: equityBefore, after: await equity() },
    events,
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/twap-live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`ok=${ok}; ${slices.length} slices; position before flatten ${posBeforeFlatten}, after ${posAfter}; equity $${equityBefore.toFixed(2)} -> $${result.equityUsd.after.toFixed(2)}`);
}
process.exit(ok ? 0 : 1);

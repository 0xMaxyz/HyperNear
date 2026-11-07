// Phase 2 live run (testnet): one grid on a fresh strategy leg (leg 3) through the real validation, runner and kill switch.
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json NEAR_NETWORK=testnet node agent/scripts/grid-live.ts [--check]
// Steps: register leg 3 -> fund it from lab wallet #3 (usdSend) -> owner approves its HL API wallet -> validate + start the
// grid just inside the BTC spread (so a post-only buy rests as best bid) -> if the market has not filled it, lab wallet #3
// acts as the counterparty: it sells into the buy, the runner answers with a reduce-only sell one level up, the counterparty
// buys it back -> kill switch (pause cancels everything), then stop with onStop flatten.
// The counterparty step is ASSISTED: a 1 USD step grid on a quiet testnet book would otherwise wait for the market. The
// result file says which fills were assisted. Keys (never printed): ~/.near-credentials/testnet/<contract>.json,
// HYPERNEAR_DATA_DIR/agent-keys.json, the lab wallet file (index 3 only). Owner = HYPERNEAR_TEST_OWNER_KEY or the public test key.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, NearMasterSigner, nearAccount, ownerIntentTypedData, type OwnerIntent } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { Legs } from '../src/legs.ts';
import { agentKeySigner, hlClient, position, roundPx } from '../src/market.ts';
import { StrategyManager } from '../src/strategy/manager.ts';
import { hlPort } from '../src/strategy/port.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const LEG = 3;
const LAB_INDEX = 3; // lab wallets 1-10 only; the rest belong to the load tests
const FUND_USD = 26; // 25 to trade with + the 1 USDC HL activation fee
const TICK_MS = 5000;

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

function labKey(): Hex {
  const row = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).find((r) => r.index === LAB_INDEX);
  if (!row) throw new Error(`lab wallet ${LAB_INDEX} not in LAB_WALLETS_PATH`);
  return row.privateKey as Hex;
}

const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
const nearAgentId = process.env.HYPERNEAR_AGENT_ACCOUNT_ID ?? `fcagent.${contractId}`;
const ownerKey = (process.env.HYPERNEAR_TEST_OWNER_KEY ?? PUBLIC_TEST_OWNER_KEY) as Hex;
if (!process.env.HYPERNEAR_TEST_OWNER_KEY && process.env.NEAR_NETWORK !== 'testnet') throw new Error('set NEAR_NETWORK=testnet to use the public test key');

const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, keyOf(contractId), RPC) });
const owner = privateKeyToAccount(ownerKey);
const ow = owner.address.toLowerCase() as Hex;
const signOwnerIntent = (td: unknown) => owner.signTypedData(td as never);
const bus = new EventBus();
const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
const policy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
const lab = hlClient('testnet', { master: agentKeySigner(labKey()), agent: agentKeySigner(labKey()) });
const labAddr = privateKeyToAccount(labKey()).address.toLowerCase() as Hex;
const total = async (addr: Hex) => {
  const [c, s] = await Promise.all([legs.hl.clearinghouseState({ user: addr }), legs.hl.spotClearinghouseState({ user: addr })]);
  return { perp: Number(c.marginSummary.accountValue), spot: Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0), withdrawable: Number(c.withdrawable) };
};

const labBefore = await total(labAddr);
console.log(`lab wallet #${LAB_INDEX} ${labAddr}: perp $${labBefore.perp.toFixed(2)}, spot $${labBefore.spot.toFixed(2)}`);
if (process.argv.includes('--check')) process.exit(0);

const cfg = await client.getConfig();
const ownerIntent = async (intent: OwnerIntent) => {
  const nonce = await client.getOwnerNonce(ow);
  const signature = await signOwnerIntent(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: ow, nonce, intent }));
  return client.relaySubmit({ owner: ow, nonce, intent }, signature as Hex);
};

// ---- leg 3: register, fund, move to perp, agent key
const legAddr = await client.registerLeg(ow, LEG);
console.log(`owner ${ow}; strategy leg ${LEG} ${legAddr}`);
const before = await total(legAddr);
if (before.perp + before.spot < 20) {
  if (labBefore.perp + labBefore.spot < FUND_USD + 8) throw new Error(`lab wallet #${LAB_INDEX} holds $${(labBefore.perp + labBefore.spot).toFixed(2)}: not enough to fund leg ${LEG} and trade`);
  const r = await lab.usdSend({ destination: legAddr, amount: String(FUND_USD) });
  console.log(`usdSend $${FUND_USD} lab #${LAB_INDEX} -> leg ${LEG}: ${JSON.stringify(r)}`);
}
let funded = await until(() => total(legAddr), (b) => b.perp + b.spot >= 20, 'leg 3 funding');
if (funded.spot >= 1) {
  const master = await NearMasterSigner.create({ client, owner: ow, leg: LEG, mode: 'owner', signOwnerIntent: signOwnerIntent as never, legAddress: legAddr });
  await hlClient('testnet', { master }).usdClassTransfer({ amount: (Math.floor(funded.spot * 100) / 100).toFixed(2), toPerp: true });
  funded = await until(() => total(legAddr), (b) => b.perp >= 20, 'leg 3 spot -> perp');
}
console.log(`leg ${LEG}: perp $${funded.perp.toFixed(2)}`);
await legs.approveAgents(ow, [LEG], signOwnerIntent as never);

// ---- owner policy: our NEAR agent, $50/day (set once by guard-demo; set here only if missing). Never unfreezes.
const pol = await client.getOwner(ow);
if (pol?.frozen) throw new Error('owner is frozen: unfreeze it first (this script does not)');
if (pol?.agent !== nearAgentId) await ownerIntent({ type: 'setPolicy', agent: nearAgentId, dailyCap: '50', cooldownSec: 30 });

// leftover inventory from an earlier run would confuse the ladder's bookkeeping
await (await hlPort(legs, ow, LEG)).flatten('BTC');

// ---- the grid, just inside the spread: buy at bestBid+1, sell at bestBid+2 (1 USD tick; needs a spread of at least 3)
const book = await legs.hl.l2Book({ coin: 'BTC' });
if (!book) throw new Error('no BTC book');
const bid = Number(book.levels[0]![0]!.px);
const ask = Number(book.levels[1]![0]!.px);
console.log(`BTC book: bid ${bid} ask ${ask}`);
if (ask - bid < 3) throw new Error(`spread ${ask - bid} too tight for the 1-step demo grid; rerun later`);
const universe = (await legs.hl.meta()).universe;
const btc = universe.findIndex((u) => u.name === 'BTC');
const szDecimals = universe[btc]!.szDecimals;
const lower = bid + 1;
const sizePerLevel = (Math.ceil((10.5 / lower) * 10 ** szDecimals) / 10 ** szDecimals).toFixed(szDecimals);
const spec = {
  id: 'grid-live-1', type: 'grid', leg: LEG, coin: 'BTC',
  params: { lower, upper: lower + 4, levels: 5, sizePerLevel },
  limits: { maxNotional: 100, maxLeverage: 3, maxDailyLoss: 5, topUpCapPerDay: 20 },
  onStop: 'flatten',
};

const events: { t: number; type: string; data: unknown }[] = [];
const t0 = Date.now();
bus.subscribe((e) => {
  if (e.type.startsWith('strategy.')) {
    events.push({ t: e.at - t0, type: e.type, data: e.data });
    console.log(`  +${((e.at - t0) / 1000).toFixed(1)}s ${e.type} ${JSON.stringify(e.data).slice(0, 200)}`);
  }
});
const manager = new StrategyManager({ legs, client, policy, emit: (t, d) => void bus.emit(t, d), agentId: nearAgentId, intervalMs: TICK_MS });
const v = await manager.validate(ow, spec);
if (!v.ok) throw new Error(`spec refused: ${v.errors.join('; ')}`);
// the refusals the contract and order policy must give for this leg (shown in the result)
const refusals = {
  reservedLeg: await manager.validate(ow, { ...spec, leg: 1 }),
  overPolicyLeverage: await manager.validate(ow, { ...spec, limits: { ...spec.limits, maxLeverage: 10 } }),
};
await manager.start(ow, v.spec);

const state = () => manager.list(ow).find((s) => s.id === spec.id)!;
const ev = (type: string) => events.filter((e) => e.type === type);
const lastPx = (side: string) => (ev('strategy.order').filter((e) => (e.data as { side: string }).side === side).at(-1)?.data as { px: number } | undefined)?.px;
const assisted: Record<string, unknown> = {};
const ioc = (isBuy: boolean, price: number) => lab.limitOrderOpen({ asset: btc, isBuy, price: roundPx(price, szDecimals), size: sizePerLevel, tif: 'Ioc' });
/** The counterparty trades against our resting order, only if it still rests at that price (the book moves). */
async function assist(key: string, ourSide: 'B' | 'A', price: number) {
  const rests = (await legs.hl.openOrders({ user: legAddr })).some((o) => o.side === ourSide && Number(o.limitPx) === price);
  if (!rests) return void (assisted[key] = 'skipped: our order no longer rests at that price (filled or moved by the market)');
  try {
    assisted[key] = JSON.stringify((await ioc(ourSide === 'A', price)).response.data.statuses[0]);
  } catch (e) {
    assisted[key] = `failed: ${(e as Error).message.slice(0, 140)}`;
  }
}
let ok = false;
try {
  // 1. a buy rests; the counterparty sells into it unless the market already did
  await until(async () => ev('strategy.order').length, (n) => n >= 1, 'first resting buy');
  await assist('counterpartySell', 'B', lastPx('buy')!);
  await until(async () => ev('strategy.fill').length, (n) => n >= 1, 'buy fill seen by the runner', 180_000);
  // 2. the runner places a reduce-only sell one level up; the counterparty buys it unless the market already did
  await until(async () => lastPx('sell'), (p) => p !== undefined, 'reduce-only sell placed');
  await assist('counterpartyBuy', 'A', lastPx('sell')!);
  await until(async () => ev('strategy.fill').length, (n) => n >= 2, 'sell fill seen by the runner', 180_000);
  ok = true;
} finally {
  // 3. kill switch: pause cancels every resting order and the runner places nothing more; stop (onStop flatten) closes the position
  const paused = await manager.pause(ow, spec.id, 'kill switch (live run)');
  const open = await legs.hl.openOrders({ user: legAddr });
  await sleep(2 * TICK_MS);
  const stillOpen = (await legs.hl.openOrders({ user: legAddr })).length;
  const placedAfterPause = ev('strategy.order').filter((e) => e.t > ev('strategy.paused')[0]!.t).length;
  const szi = async (addr: Hex) => Number(position(await legs.hl.clearinghouseState({ user: addr }), 'BTC')?.szi ?? 0);
  const posBeforeStop = await szi(legAddr);
  await manager.stop(ow, spec.id, 'end of run');
  const posAfterStop = await until(() => szi(legAddr), (n) => n === 0, 'leg flat after stop', 30_000).catch((e) => `not flat: ${(e as Error).message}`);
  // the counterparty must end flat too
  const labPos = await szi(labAddr);
  if (labPos !== 0) {
    const mid = Number((await legs.hl.allMids()).BTC);
    await lab.limitOrderOpen({ asset: btc, isBuy: labPos < 0, price: roundPx(mid * (labPos < 0 ? 1.03 : 0.97), szDecimals), size: Math.abs(labPos).toFixed(szDecimals), tif: 'Ioc', reduceOnly: true });
  }
  manager.shutdown();
  const after = await total(legAddr);
  const labAfter = await total(labAddr);
  const result = {
    at: new Date(t0).toISOString(), owner: ow, leg: LEG, legAddress: legAddr, ok,
    spec: v.spec, validatedBy: 'StrategyManager.validate (contract policy, order policy, reserved legs, approved agent key)', refusals,
    assisted: { note: 'a 1 USD step grid inside the spread would otherwise wait for the market; lab wallet #3 may trade against the grid', ...assisted },
    kill: { stateAfterPause: paused.state, openOrdersAfterPause: open.length, openOrdersTwoTicksLater: stillOpen, ordersPlacedAfterPause: placedAfterPause, positionBeforeStop: posBeforeStop, positionAfterStop: posAfterStop, counterpartyPositionClosed: labPos },
    deadman: state().deadman,
    equityUsd: { legBefore: funded.perp, legAfter: after.perp, labBefore: labBefore.perp + labBefore.spot, labAfter: labAfter.perp + labAfter.spot },
    events,
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/grid-live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`ok=${ok}; kill switch left ${open.length} open orders (${stillOpen} two ticks later); dead-man ${result.deadman}; leg equity $${funded.perp.toFixed(2)} -> $${after.perp.toFixed(2)}`);
}
process.exit(ok ? 0 : 1);

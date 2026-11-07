// Demo 2 (testnet): one account per bot, with capped top-ups.
//   set -a; . ~/secrets/api.env; set +a; LAB_WALLETS_PATH=~/secrets/lab-wallets.json NEAR_NETWORK=testnet node agent/scripts/demo2-live.ts
// A TWAP buys BTC on strategy leg 3 at 20x (the operator allows 20x for this bot). The owner then moves the leg's spare margin
// to spot (stress), so the leg's equity falls to a few multiples of its maintenance margin. The margin guard tops it up FROM
// THE RESERVE LEG 2 through the contract's rebalance (NEAR agent key), limited by the strategy's topUpCapPerDay ($5). A second
// stress is then refused by the guard (budget used), and a direct rebalance above the contract's daily cap is refused by the
// contract. Leg 3 only ever receives money from leg 2, never from a lab wallet (a lab wallet funds the legs once, before).
// Demo thresholds: the guard floor is 10x maintenance (not the default 2x) and the top-up target is 15x, because a 20x leg cannot
// get near 2x without 40x; this is said in the result file. Keys (never printed): ~/.near-credentials/testnet/*.json,
// HYPERNEAR_DATA_DIR/agent-keys.json, lab wallet file (index 3 only), TYPESAFE_API_KEY / ANTHROPIC_API_KEY for the decision proposal.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, NearMasterSigner, nearAccount } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { GuardLoop } from '../src/guardLoop.ts';
import { Legs } from '../src/legs.ts';
import { agentKeySigner, hlClient, position } from '../src/market.ts';
import { proposeStrategyAction } from '../src/strategy/decide.ts';
import { claudeStrategyEscalator, jevAskStrategy } from '../src/strategy/decideClients.ts';
import { StrategyManager } from '../src/strategy/manager.ts';
import { hlPort } from '../src/strategy/port.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const LEG = 3;
const RESERVE = 2;
const LAB_INDEX = 3; // lab wallets 1-10 only
const TICK_MS = 5000;
const SLICES = 9;
const TOP_UP_CAP = 5; // the strategy's topUpCapPerDay (USD)
const FLOOR = 10;
const TARGET = 15;

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
const labKey = () => {
  const row = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).find((r) => r.index === LAB_INDEX);
  if (!row) throw new Error(`lab wallet ${LAB_INDEX} not in LAB_WALLETS_PATH`);
  return row.privateKey as Hex;
};

const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
const nearAgentId = process.env.HYPERNEAR_AGENT_ACCOUNT_ID ?? `fcagent.${contractId}`;
if (process.env.NEAR_NETWORK !== 'testnet') throw new Error('set NEAR_NETWORK=testnet');
const owner = privateKeyToAccount(PUBLIC_TEST_OWNER_KEY as Hex);
const ow = owner.address.toLowerCase() as Hex;
const signOwnerIntent = (td: unknown) => owner.signTypedData(td as never);
const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, keyOf(contractId), RPC) });
const agentClient = new HyperNearClient({ contractId, sender: nearAccount(nearAgentId, keyOf(nearAgentId), RPC) });
const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
const policy = { maxLeverage: 20, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
const lab = hlClient('testnet', { master: agentKeySigner(labKey()) });

const addr = async (leg: number) => (await client.getLeg(ow, leg))!;
const [leg3, leg2] = [await addr(LEG), await addr(RESERVE)];
const ch = (a: Hex) => legs.hl.clearinghouseState({ user: a });
const withdrawable = async (a: Hex) => Number((await ch(a)).withdrawable);
const equity = async (a: Hex) => Number((await ch(a)).marginSummary.accountValue);
const ratio = async (a: Hex) => {
  const c = await ch(a);
  const m = Number(c.crossMaintenanceMarginUsed);
  return m > 0 ? Number(c.marginSummary.accountValue) / m : Infinity;
};
const szi = async (a: Hex) => Number(position(await ch(a), 'BTC')?.szi ?? 0);
const classTransfer = async (leg: number, a: Hex, amount: string, toPerp: boolean) => {
  const master = await NearMasterSigner.create({ client, owner: ow, leg, mode: 'owner', signOwnerIntent: signOwnerIntent as never, legAddress: a });
  return hlClient('testnet', { master }).usdClassTransfer({ amount, toPerp });
};
/** The owner moves a leg's whole withdrawable perp margin to spot: the stress. */
async function stress(label: string) {
  const w = Math.floor((await withdrawable(leg3)) * 100) / 100 - 0.01;
  if (w < 1) throw new Error(`nothing to move out of leg ${LEG} (withdrawable ${w})`);
  await classTransfer(LEG, leg3, w.toFixed(2), false);
  await until(() => ratio(leg3), (r) => r < FLOOR, 'leg 3 ratio below the floor', 30_000);
  const r = { movedToSpot: w.toFixed(2), equity: await equity(leg3), marginRatio: await ratio(leg3) };
  console.log(`${label}: moved $${r.movedToSpot} to spot; equity $${r.equity.toFixed(2)}, margin ratio ${r.marginRatio.toFixed(2)}x (guard floor ${FLOOR}x)`);
  timeline.push({ t: Date.now() - t0, type: `stress.${label}`, data: r });
  return r;
}

const timeline: { t: number; type: string; data: unknown }[] = [];
const t0 = Date.now();
const bus = new EventBus();
bus.subscribe((e) => {
  if (!/^(guard|strategy|decision)\./.test(e.type)) return;
  timeline.push({ t: e.at - t0, type: e.type, data: e.data });
  console.log(`  +${((e.at - t0) / 1000).toFixed(1)}s ${e.type} ${JSON.stringify(e.data).slice(0, 190)}`);
});

// ---- preflight: the reserve leg and the strategy leg hold money; owner policy names our agent
const funding: Record<string, unknown> = {};
const labTotal = async () => {
  const [c, s] = await Promise.all([legs.hl.clearinghouseState({ user: privateKeyToAccount(labKey()).address.toLowerCase() as Hex }), legs.hl.spotClearinghouseState({ user: privateKeyToAccount(labKey()).address.toLowerCase() as Hex })]);
  return Number(c.marginSummary.accountValue) + Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
};
for (const [leg, a, need, give] of [[RESERVE, leg2, 15, 30], [LEG, leg3, 20, 26]] as const) {
  const have = await equity(a);
  if (have < need) {
    if ((await labTotal()) < give + 5) throw new Error(`lab wallet ${LAB_INDEX} cannot fund leg ${leg}`);
    funding[`leg${leg}`] = { had: have, sentFromLab3: give, response: await lab.usdSend({ destination: a, amount: String(give) }) };
    await until(() => equity(a), (v) => v >= need, `leg ${leg} funding`);
  }
}
const pol = await client.getOwner(ow);
if (pol?.frozen || pol?.agent !== nearAgentId || pol.daily_cap < 50e6) throw new Error(`owner policy not ready: ${JSON.stringify(pol)} (run agent/scripts/grid-live.ts or guard-demo first)`);
await (await hlPort(legs, ow, LEG)).flatten('BTC');
const before = { leg2: await equity(leg2), leg3: await equity(leg3), ownerPolicy: pol };
console.log(`leg ${RESERVE} (reserve) $${before.leg2.toFixed(2)}, leg ${LEG} (bot) $${before.leg3.toFixed(2)}; contract cap $${pol.daily_cap / 1e6}/day, spent today $${pol.spent_today / 1e6}`);

// ---- the bot: a TWAP at 20x, topUpCapPerDay $5
const manager = new StrategyManager({ legs, client, policy, emit: (t, d) => void bus.emit(t, d), agentId: nearAgentId, intervalMs: TICK_MS });
const mid = Number((await legs.hl.allMids()).BTC);
const universe = (await legs.hl.meta()).universe;
const btc = universe.findIndex((u) => u.name === 'BTC');
const szDecimals = universe[btc]!.szDecimals;
const spec = {
  id: 'bot-demo2', type: 'twap', leg: LEG, coin: 'BTC',
  params: { side: 'buy', sizePerSlice: (Math.ceil((10.5 / mid) * 10 ** szDecimals) / 10 ** szDecimals).toFixed(szDecimals), slices: SLICES, intervalSec: 10, limitPx: Math.round(mid * 1.02) },
  limits: { maxNotional: 100, maxLeverage: 20, maxDailyLoss: 15, topUpCapPerDay: TOP_UP_CAP },
  onStop: 'flatten',
};
const v = await manager.validate(ow, spec);
if (!v.ok) throw new Error(`spec refused: ${v.errors.join('; ')}`);
await manager.start(ow, v.spec);
await until(async () => manager.list(ow)[0]?.state, (s) => s === 'done', 'all slices', 180_000);
const position0 = { btc: await szi(leg3), notionalUsd: Math.abs(await szi(leg3)) * mid, equity: await equity(leg3), marginRatio: await ratio(leg3) };
console.log(`bot holds ${position0.btc} BTC (~$${position0.notionalUsd.toFixed(0)}) at 20x; equity $${position0.equity.toFixed(2)}, margin ratio ${position0.marginRatio.toFixed(1)}x`);

let guard: GuardLoop | undefined;
let decision: unknown;
let contractRefusal: unknown;
let ok = false;
let stress1: unknown;
let stress2: unknown;
const sawEvent = (type: string, pred: (d: any) => boolean = () => true) => timeline.some((e) => e.type === type && pred(e.data));
try {
  // ---- stress 1, then the guard (reserve leg only, within the strategy budget)
  stress1 = await stress('1');
  const snap = await legs.snapshot(ow);
  const input = (await manager.inputs(ow, snap, 0.6))[0];
  const decisionP =
    input && process.env.TYPESAFE_API_KEY && process.env.ANTHROPIC_API_KEY
      ? proposeStrategyAction(input, { ask: jevAskStrategy(), escalate: claudeStrategyEscalator() }).then((p) => ({ facts: input.facts, ...p }), (e) => ({ error: String(e) }))
      : Promise.resolve({ skipped: 'TYPESAFE_API_KEY / ANTHROPIC_API_KEY not set' });
  guard = new GuardLoop({
    legs, bus, agentId: nearAgentId, agentClient, owners: () => [ow],
    budgetLeftUsd: (o, leg) => manager.topUpLeft(o, leg),
    onTopUp: (o, leg, usd) => manager.recordTopUp(o, leg, usd),
    cfg: { intervalMs: 2000, guard: { ...DEFAULT_GUARD_CONFIG, marginFloorMultiple: FLOOR }, targetMultiple: TARGET, reserveLeg: RESERVE },
  });
  guard.start();
  await until(async () => sawEvent('guard.rebalance.posted'), Boolean, 'first top-up posted', 120_000);
  const afterTopUp = await until(() => ratio(leg3), (r) => r >= FLOOR, 'leg 3 recovered', 60_000);
  const topUp = timeline.find((e) => e.type === 'guard.rebalance.start')!.data as { from: { leg: number }; to: { leg: number }; amount: string };
  console.log(`top-up: $${topUp.amount} from leg ${topUp.from.leg} to leg ${topUp.to.leg}; margin ratio now ${afterTopUp.toFixed(1)}x; budget left $${manager.topUpLeft(ow, LEG)}`);
  decision = await decisionP;

  // ---- stress 2: the budget is used, the guard must refuse
  stress2 = await stress('2');
  await until(async () => sawEvent('guard.trigger', (d) => d.plan?.kind === 'blocked' && /budget used/.test(d.plan.reason)), Boolean, 'the budget refusal', 150_000);
  console.log(`second top-up refused: ${(timeline.filter((e) => e.type === 'guard.trigger').at(-1)!.data as any).plan.reason}`);
  guard.stop();

  // ---- the contract's own cap, straight at the contract (cooldown is over by now)
  const st = await client.getOwner(ow);
  const capLeft = Math.max(0, st!.daily_cap - (st!.day === Math.floor(Date.now() / 86_400_000) ? st!.spent_today : 0)) / 1e6;
  const amount = String(Math.floor(capLeft) + 1);
  try {
    // the contract call itself (no HL post): the contract, not the guard, must say no
    await agentClient.rebalance({ owner: ow, fromLeg: RESERVE, toAddress: leg3.toLowerCase() as Hex, amount, hlTime: Date.now() });
    contractRefusal = { amount, capLeftUsd: capLeft, refused: false };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    contractRefusal = { amount, capLeftUsd: capLeft, refused: true, error: (cause ?? (e as Error).message).slice(0, 400) };
  }
  console.log(`direct rebalance of $${amount} (cap left $${capLeft}): ${JSON.stringify(contractRefusal)}`);
  ok = Boolean(sawEvent('guard.rebalance.posted')) && (contractRefusal as { refused: boolean }).refused;
} finally {
  guard?.stop();
  await manager.stop(ow, spec.id, 'end of demo').catch(() => {});
  manager.shutdown();
  await until(() => szi(leg3), (n) => n === 0, 'leg 3 flat', 30_000).catch(() => {});
  const spot = Number((await legs.hl.spotClearinghouseState({ user: leg3 })).balances.find((b) => b.coin === 'USDC')?.total ?? 0);
  if (spot >= 0.01) await classTransfer(LEG, leg3, (Math.floor(spot * 100) / 100).toFixed(2), true).catch(() => {});
  const txs = timeline.filter((e) => e.type === 'guard.rebalance.signed').map((e) => (e.data as { txHash?: string }).txHash);
  const result = {
    at: new Date(t0).toISOString(), ok, owner: ow, strategy: spec, reserveLeg: RESERVE, botLeg: LEG,
    thresholds: { guardFloorMultiple: FLOOR, topUpTargetMultiple: TARGET, why: 'HL keeps about 10% of the notional as non-withdrawable margin, so a 20x leg whose spare margin is withdrawn sits near 8x maintenance, never near the default 2x; the demo raises the floor so that state counts as stressed', operatorMaxLeverage: policy.maxLeverage },
    funding, before, position: position0, stress1, stress2, topUpTxs: txs,
    strategyBudget: { topUpCapPerDayUsd: TOP_UP_CAP, leftAfterUsd: manager.topUpLeft(ow, LEG) },
    contractCapRefusal: contractRefusal,
    decisionProposal: decision,
    after: { leg2: await equity(leg2), leg3: await equity(leg3), ownerPolicy: await client.getOwner(ow) },
    timeline,
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/demo2-live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`ok=${ok}; top-up txs ${JSON.stringify(txs)}; reserve $${before.leg2.toFixed(2)} -> $${result.after.leg2.toFixed(2)}`);
}
process.exit(ok ? 0 : 1);

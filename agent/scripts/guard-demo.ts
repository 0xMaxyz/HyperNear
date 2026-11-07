// Guard demo (testnet, repeatable): hedged pair at 3x -> leg1 is stressed until it nears liquidation -> the guard loop
// detects it and rebalances from leg0 through the contract (NEAR agent function-call key) -> leg1 recovers.
// Prints and saves the timeline (agent/results/guard-demo.json), then puts both legs back to where they started.
//
//   NEAR_NETWORK=testnet node agent/scripts/guard-demo.ts      (core + @hypernear/client built; ci32)
//
// Stress = (1) leg1 leverage 3x -> 40x (agent L1 action), (2) owner-mode usdClassTransfer of all of leg1's withdrawable
// perp USDC to its spot balance. HL refuses to move margin below the initial margin, so only a high leverage gets a leg
// near liquidation; at 40x the initial margin is ~2x maintenance. The owner has no usdSend intent (by design), so the
// margin leaves through usdClassTransfer and stays on leg1's spot side; the cleanup moves it back.
// Keys (never printed): ~/.near-credentials/testnet/<contract>.json (relayer), ~/.near-credentials/testnet/<agent>.json
// (function-call key), HYPERNEAR_DATA_DIR/agent-keys.json (HL API wallets), owner = HYPERNEAR_TEST_OWNER_KEY or the public test key.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, NearMasterSigner, nearAccount, ownerIntentTypedData, type OwnerIntent } from '@hypernear/client';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { GuardLoop } from '../src/guardLoop.ts';
import { Hedger } from '../src/hedge.ts';
import { Legs, type OwnerSnapshot } from '../src/legs.ts';
import { hlClient, position, roundPx } from '../src/market.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

export interface GuardDemoOptions {
  contractId?: string;
  nearAgentId?: string;
  dataDir?: string;
  /** guard trigger: accountValue / maintenance <= this. 40x leaves ~2.0, so the demo uses 2.5 (plan allows "earlier"). */
  marginFloor?: number;
  log?: (s: string) => void;
}

function ownerKey(): Hex {
  if (process.env.HYPERNEAR_TEST_OWNER_KEY) return process.env.HYPERNEAR_TEST_OWNER_KEY as Hex;
  if (process.env.NEAR_NETWORK === 'testnet') return PUBLIC_TEST_OWNER_KEY;
  throw new Error('set HYPERNEAR_TEST_OWNER_KEY, or NEAR_NETWORK=testnet to use the public test key');
}

const keyOf = (id: string) => JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${id}.json`, 'utf8')).private_key as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const szi = (s: OwnerSnapshot, leg: number) => Number(position(s.legs.find((l) => l.leg === leg)!.clearinghouse, 'BTC')?.szi ?? 0);
const leg = (s: OwnerSnapshot, i: number) => s.legs.find((l) => l.leg === i)!;
const ratio = (s: OwnerSnapshot, i: number) => {
  const c = leg(s, i).clearinghouse;
  const m = Number(c.crossMaintenanceMarginUsed);
  return m > 0 ? Number(c.marginSummary.accountValue) / m : Infinity;
};

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 90_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

export async function runGuardDemo(o: GuardDemoOptions = {}) {
  const log = o.log ?? console.log;
  const contractId = o.contractId ?? process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
  const nearAgentId = o.nearAgentId ?? process.env.HYPERNEAR_AGENT_ACCOUNT_ID ?? `fcagent.${contractId}`;
  const floor = o.marginFloor ?? Number(process.env.HYPERNEAR_GUARD_MARGIN_FLOOR ?? 2.5);
  const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, keyOf(contractId), RPC) });
  const agentClient = new HyperNearClient({ contractId, sender: nearAccount(nearAgentId, keyOf(nearAgentId), RPC) });
  const owner = privateKeyToAccount(ownerKey());
  const ow = owner.address.toLowerCase() as Hex;
  const signOwnerIntent = (td: unknown) => owner.signTypedData(td as never);
  const bus = new EventBus();
  const legs = new Legs({ client, dataDir: o.dataDir ?? process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
  const hedger = new Hedger(legs, { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC'], slippage: 0.03 }, bus);
  const cfg = await client.getConfig();

  const ownerIntent = async (intent: OwnerIntent) => {
    const nonce = await client.getOwnerNonce(ow);
    const signature = await signOwnerIntent(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: ow, nonce, intent }));
    return client.relaySubmit({ owner: ow, nonce, intent }, signature as Hex);
  };
  /** owner-mode usdClassTransfer on a leg, through the contract, posted to HL */
  const classTransfer = async (legIdx: number, amount: string, toPerp: boolean) => {
    const master = await NearMasterSigner.create({ client, owner: ow, leg: legIdx, mode: 'owner', signOwnerIntent: signOwnerIntent as never });
    return hlClient('testnet', { master }).usdClassTransfer({ amount, toPerp });
  };

  // ---- setup: legs, agents, policy (agent = our NEAR agent, cap $50/day, 30 s cooldown)
  const addr = [await client.registerLeg(ow, 0), await client.registerLeg(ow, 1)];
  await legs.approveAgents(ow, [0, 1], signOwnerIntent as never);
  const pol = await client.getOwner(ow);
  if (pol?.agent !== nearAgentId || pol.daily_cap !== 50e6 || pol.cooldown_sec !== 30 || pol.frozen) {
    if (pol?.frozen) await ownerIntent({ type: 'freeze', frozen: false });
    await ownerIntent({ type: 'setPolicy', agent: nearAgentId, dailyCap: '50', cooldownSec: 30 });
  }
  log(`owner ${ow}; leg0 ${addr[0]}, leg1 ${addr[1]}; agent ${nearAgentId}; guard floor ${floor}x maintenance`);

  // ---- reset: flat legs, leg1 margin back in perp
  let s = await legs.snapshot(ow);
  if (szi(s, 0) !== 0 || szi(s, 1) !== 0) await hedger.closeHedge(ow, 'BTC');
  const parked = Math.floor(leg(s, 1).spotUsdc * 100) / 100;
  if (parked >= 0.01) await classTransfer(1, parked.toFixed(2), true);
  s = await until(() => legs.snapshot(ow), (x) => szi(x, 0) === 0 && szi(x, 1) === 0 && leg(x, 1).spotUsdc < 0.01, 'reset');
  const fund = (i: number) => Number(leg(s, i).clearinghouse.marginSummary.accountValue);
  if (fund(0) < 12 || fund(1) < 6) throw new Error(`fund the legs first: leg0 $${fund(0)} (need 12), leg1 $${fund(1)} (need 6)`);

  // ---- hedged pair at 3x: leg0 long ~$30, leg1 short 0.5x
  const btc = s.market.assets.find((a) => a.name === 'BTC')!;
  let mid = Number(s.market.mids.BTC);
  const leg0 = legs.tradingClient(ow, 0);
  await leg0.updateLeverage({ asset: btc.asset, isCross: true, leverage: 3 });
  const size0 = (Math.ceil((30 / mid) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
  await leg0.limitOrderOpen({ asset: btc.asset, isBuy: true, price: roundPx(mid * 1.03, btc.szDecimals), size: size0, tif: 'Ioc' });
  await until(() => legs.snapshot(ow), (x) => szi(x, 0) > 0, 'leg0 position');
  const hedge = await hedger.openHedge(ow, 'BTC', 0.5);
  s = await until(() => legs.snapshot(ow), (x) => szi(x, 1) < 0, 'leg1 hedge');
  log(`hedged: leg0 ${szi(s, 0)} BTC, leg1 ${szi(s, 1)} BTC at 3x (hedge oid ${hedge.fill.oid}); leg1 margin ratio ${ratio(s, 1).toFixed(1)}x`);

  // ---- guard loop (2 s ticks for the demo), timeline from the event bus
  const timeline: { t: number; event: string; detail?: Record<string, unknown> }[] = [];
  bus.subscribe((e: AgentEvent) => {
    if (!e.type.startsWith('guard.')) return;
    timeline.push({ t: e.at, event: e.type, detail: e.data });
    const d = e.data as Record<string, any>;
    const brief =
      e.type === 'guard.trigger'
        ? `${(d.triggered ?? []).map((x: any) => `${x.id} ${x.reasons.join('+')}`).join(', ')} -> ${d.plan?.kind}${d.plan?.reason ? ` (${d.plan.reason})` : ''}`
        : e.type === 'guard.rebalance.start'
          ? `leg${d.from?.leg} -> leg${d.to?.leg} $${d.amount}`
          : e.type === 'guard.rebalance.signed'
            ? `${d.method} tx ${d.txHash}`
            : e.type === 'guard.error'
              ? String(d.error)
              : '';
    log(`  [${new Date(e.at).toISOString().slice(11, 23)}] ${e.type} ${brief}`);
  });
  const loop = new GuardLoop({
    legs,
    bus,
    agentId: nearAgentId,
    agentClient,
    owners: () => [ow],
    cfg: { intervalMs: 2000, guard: { ...DEFAULT_GUARD_CONFIG, marginFloorMultiple: floor } },
  });
  loop.start();

  // ---- stress leg1: leverage up to 40x, then move all its withdrawable perp USDC to spot
  const leg1 = legs.tradingClient(ow, 1);
  await leg1.updateLeverage({ asset: btc.asset, isCross: true, leverage: btc.maxLeverage });
  s = await until(() => legs.snapshot(ow), (x) => position(leg(x, 1).clearinghouse, 'BTC')?.leverage.value === btc.maxLeverage, 'leg1 leverage');
  const out = Math.floor(Number(leg(s, 1).clearinghouse.withdrawable) * 100) / 100 - 0.01;
  const tStress0 = Date.now();
  await classTransfer(1, out.toFixed(2), false);
  const tStress = Date.now();
  timeline.push({ t: tStress, event: 'stress.posted', detail: { leverage: btc.maxLeverage, movedToSpot: out.toFixed(2), signAndPostMs: tStress - tStress0 } });
  log(`stress: leg1 at ${btc.maxLeverage}x, $${out.toFixed(2)} moved perp -> spot (owner intent, ${tStress - tStress0} ms)`);

  // ---- wait for detect -> rebalance -> recovery
  const seen = (type: string) => timeline.find((x) => x.event === type && x.t >= tStress);
  const watch = setInterval(() => {
    legs.snapshot(ow).then(
      (x) => log(`  leg1 margin ratio ${ratio(x, 1).toFixed(2)}x (account $${Number(leg(x, 1).clearinghouse.marginSummary.accountValue).toFixed(3)}, ` +
        `maintenance $${Number(leg(x, 1).clearinghouse.crossMaintenanceMarginUsed).toFixed(3)})`),
      () => {}
    );
  }, 10_000);
  try {
    await until(async () => seen('guard.rebalance.posted') && timeline.some((x) => x.event === 'guard.ok' && x.t > seen('guard.rebalance.posted')!.t), (v) => Boolean(v), 'guard rebalance + recovery', 120_000);
  } finally {
    clearInterval(watch);
    loop.stop();
  }
  s = await legs.snapshot(ow);
  const rel = (x?: { t: number }) => (x ? x.t - tStress : null);
  const signed = seen('guard.rebalance.signed');
  const posted = seen('guard.rebalance.posted');
  const summary = {
    detectMs: rel(seen('guard.trigger')),
    rebalanceStartMs: rel(seen('guard.rebalance.start')),
    nearSignedMs: rel(signed),
    hlPostedMs: rel(posted),
    recoveredMs: rel(timeline.find((x) => x.event === 'guard.ok' && x.t > posted!.t)),
    nearTx: signed?.detail?.txHash,
    amount: (seen('guard.rebalance.start')?.detail as { amount?: string } | undefined)?.amount,
    leg1RatioAfter: ratio(s, 1),
  };
  log(`timeline (ms after stress): detected +${summary.detectMs}, rebalance start +${summary.rebalanceStartMs}, ` +
    `NEAR signed +${summary.nearSignedMs} (tx ${summary.nearTx}), HL accepted +${summary.hlPostedMs}, recovered +${summary.recoveredMs}; ` +
    `moved $${summary.amount}; leg1 margin ratio now ${summary.leg1RatioAfter.toFixed(1)}x`);

  // ---- cleanup: close both legs, bring leg1's parked margin back to perp
  await hedger.closeHedge(ow, 'BTC');
  s = await until(() => legs.snapshot(ow), (x) => szi(x, 0) === 0 && szi(x, 1) === 0, 'flat after demo');
  const back = Math.floor(leg(s, 1).spotUsdc * 100) / 100;
  if (back >= 0.01) await classTransfer(1, back.toFixed(2), true);
  mid = Number(s.market.mids.BTC);

  const result = { at: new Date(tStress).toISOString(), owner: ow, contractId, nearAgentId, floor, mid, summary, timeline: timeline.map((x) => ({ ...x, t: x.t - tStress })) };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/guard-demo.json', import.meta.url), JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardDemo().then(
    () => process.exit(0),
    (e) => {
      console.error('guard demo failed:', (e as Error).message);
      process.exit(1);
    }
  );
}

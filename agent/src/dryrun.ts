// --dry-run for judges: no keys, no network. Replays recorded testnet snapshots (agent/fixtures/*.json) and
// prints what openHedge(BTC, 0.5), closeHedge(BTC) and the margin guard would do.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { HyperNearClient, type NearBackend } from '@hypernear/client';
import { ReplayCache } from './commands.ts';
import { loadConfig, type OrderPolicy } from './config.ts';
import { EventBus } from './events.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard } from './guard.ts';
import { HedgeRefused, Hedger, planCloseHedge, planOpenHedge, type ClosePlan, type OpenPlan } from './hedge.ts';
import { guardInputs, Legs, type OwnerSnapshot } from './legs.ts';
import { parseRelayBody, RateLimiter, Relayer } from './relayer.ts';
import type { Deps } from './server.ts';
import { position } from './market.ts';

export interface Fixture {
  name: string;
  description: string;
  recordedAt: string;
  snapshot: OwnerSnapshot;
}

export const FIXTURE_DIR = new URL('../fixtures/', import.meta.url);

export function loadFixtures(dir: URL = FIXTURE_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Fixture);
}

export interface DryRunResult {
  fixture: string;
  open: OpenPlan;
  close: ClosePlan;
  guard: ReturnType<typeof evaluateGuard>;
}

export function dryRun(f: Fixture, policy: OrderPolicy, coin = 'BTC', ratio = 0.5, annualVol = 0.6): DryRunResult {
  return {
    fixture: f.name,
    open: planOpenHedge(f.snapshot, coin, ratio, policy),
    close: planCloseHedge(f.snapshot, coin, policy),
    guard: evaluateGuard(guardInputs(f.snapshot, annualVol)),
  };
}

const fmtOrder = (o: { leg: number; isBuy: boolean; size: string; coin: string; price: string; reduceOnly: boolean; notionalUsd: number }) =>
  `leg${o.leg} ${o.isBuy ? 'BUY' : 'SELL'} ${o.size} ${o.coin} IOC @ ${o.price}${o.reduceOnly ? ' reduce-only' : ''} (~$${o.notionalUsd.toFixed(2)})`;

export function runDryRun(log: (s: string) => void = console.log) {
  const policy = loadConfig({}).policy; // defaults only: the dry run reads no env, no keys
  log(`hypernear agent --dry-run: order policy max ${policy.maxLeverage}x, max $${policy.maxNotionalUsd}, coins ${policy.allowedCoins.join(',')}`);
  for (const f of loadFixtures()) {
    const r = dryRun(f, policy);
    log(`\n== ${f.name} (recorded ${f.recordedAt} on HL testnet): ${f.description}`);
    for (const l of f.snapshot.legs) {
      const p = position(l.clearinghouse, 'BTC');
      log(`  leg${l.leg} ${l.address}: account $${Number(l.clearinghouse.marginSummary.accountValue).toFixed(2)}, ` +
        `withdrawable $${Number(l.clearinghouse.withdrawable).toFixed(2)}, BTC ${p ? `${p.szi} @ ${p.leverage.value}x ${p.leverage.type}, liq ${p.liquidationPx ?? '-'}` : 'flat'}`);
    }
    log(`  openHedge(BTC, 0.5): ${r.open.ok ? `set leg1 leverage ${r.open.leverage.value}x ${r.open.leverage.isCross ? 'cross' : 'isolated'}, then ${fmtOrder(r.open.order)}` : `refused: ${r.open.reason}`}`);
    log(`  closeHedge(BTC):     ${r.close.ok ? r.close.orders.map(fmtOrder).join('; ') : `nothing to do: ${r.close.reason}`}`);
    if (r.guard.length === 0) log('  guard: no open positions');
    for (const g of r.guard) {
      log(`  guard ${g.id}: ${g.trigger ? `TRIGGER (${g.reasons.join(', ')}) -> rebalance from the other leg` : 'ok'}; ` +
        `liq distance ${g.distance === null ? '-' : `${(g.distance * 100).toFixed(2)}%`}, plausible move ${(g.plausibleMove * 100).toFixed(3)}%`);
    }
  }
}

// ---- --dry-run --serve: the HTTP API on top of the fixtures (the judges' path to the UI)

/** The recorded guard demo (agent/results/guard-demo.json): timeline offsets in ms relative to the stress. */
export const GUARD_DEMO = new URL('../results/guard-demo.json', import.meta.url);
/** The contract the fixtures came from; commands are verified against its domain, as on testnet. */
export const DRY_CONTRACT_ID = 'leash-spike-1107.testnet';
const DRY_AGENT = 'agent.dry-run';

export function buildDryRunDeps(fixtureName = 'hedged', opts: { replayStartMs?: number; replaySpeed?: number } = {}): Deps {
  const fixtures = loadFixtures();
  const fx = fixtures.find((f) => f.name === fixtureName) ?? fixtures[0]!;
  const snap = fx.snapshot;
  const config = loadConfig({}); // defaults only: no env, no keys
  const policyOf = (owner: string) =>
    owner === snap.owner
      ? { nonce: 0, frozen: false, agent: DRY_AGENT, daily_cap: 50e6, cooldown_sec: 30, day: 0, spent_today: 0, last_rebalance_ns: 0 }
      : null;
  // a NEAR backend answering the contract views from the fixture; any transaction is refused
  const backend: NearBackend = {
    async view<T>(_c: string, method: string, args: Record<string, unknown>) {
      if (method === 'get_config') return { admin: DRY_CONTRACT_ID, mpc_contract: 'v1.signer-prod.testnet', hl_mainnet: false, chain_tag: 'near-testnet' } as T;
      if (method === 'get_owner') return policyOf(String(args.owner)) as T;
      if (method === 'get_leg') return ((args.owner === snap.owner && snap.legs.find((l) => l.leg === args.leg)?.address) || null) as T;
      throw new Error(`dry run: view ${method} not available`);
    },
    async call() {
      throw new Error('dry run: no transactions');
    },
  };
  const client = new HyperNearClient({ contractId: DRY_CONTRACT_ID, backend });
  const legs = new Legs({ client, dataDir: mkdtempSync(join(tmpdir(), 'hypernear-dry-')), network: 'testnet', coins: config.policy.allowedCoins });
  legs.snapshot = async (owner) => ({ ...snap, owner: owner.toLowerCase() as Hex, at: Date.now(), legs: owner.toLowerCase() === snap.owner ? snap.legs : [] });
  const bus = new EventBus();
  const recorded = JSON.parse(readFileSync(GUARD_DEMO, 'utf8')) as { timeline: { t: number; event: string; detail?: Record<string, unknown> }[] };

  return {
    config: { ...config, contractId: DRY_CONTRACT_ID },
    client,
    legs,
    bus,
    replay: new ReplayCache(),
    guardConfig: DEFAULT_GUARD_CONFIG,
    hedger: new Hedger(legs, config.policy, bus),
    relayer: new Relayer(client, new RateLimiter(config.relayPerMinute)),
    pnlData: async () => [], // fixtures carry no fills/funding: fees 0, funding 0, base taker rate
    dryRun: {
      async hedge(action, owner, coin, ratio) {
        const s = await legs.snapshot(owner);
        const plan = action === 'openHedge' ? planOpenHedge(s, coin, ratio, config.policy) : planCloseHedge(s, coin, config.policy);
        if (!plan.ok) throw new HedgeRefused(plan.reason);
        const orders = 'order' in plan ? [plan.order] : plan.orders;
        const mid = Number(s.market.mids[coin]);
        bus.emit('hedge', { owner, op: action, coin, simulated: true, orders });
        return { plan, simulatedFills: orders.map((o) => ({ leg: o.leg, oid: 0, totalSz: o.size, avgPx: String(mid) })) };
      },
      async relay(body) {
        const b = parseRelayBody(body); // same validation as the live relayer
        return { kind: b.intent.type === 'registerLeg' ? 'registerLeg' : 'ownerExecute', simulated: true, owner: b.owner, intent: b.intent, txHash: null };
      },
      replayEvents(write) {
        const speed = opts.replaySpeed ?? 1;
        const start = opts.replayStartMs ?? 2000;
        const t0 = recorded.timeline[0]?.t ?? 0;
        let id = 1_000_000;
        const timers = recorded.timeline.map((x) =>
          setTimeout(() => write({ id: id++, type: x.event, at: Date.now(), data: { ...x.detail, owner: snap.owner, recordedOffsetMs: x.t, dryRun: true } }), start + (x.t - t0) / speed)
        );
        return () => timers.forEach(clearTimeout);
      },
    },
  };
}

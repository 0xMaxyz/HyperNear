// --dry-run for judges: no keys, no network. Replays recorded testnet snapshots (agent/fixtures/*.json) and
// prints what openHedge(BTC, 0.5), closeHedge(BTC) and the margin guard would do.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { HyperNearClient, type NearBackend } from '@hypernear/client';
import { ReplayCache } from './commands.ts';
import { loadConfig, type OrderPolicy } from './config.ts';
import { EventBus } from './events.ts';
import { DECISION_EVENTS, type Proposal } from './decide.ts';
import { Decider, DecisionModes, proposalEvent } from './decisions.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard } from './guard.ts';
import { HedgeRefused, Hedger, planCloseHedge, planOpenHedge, type ClosePlan, type OpenPlan } from './hedge.ts';
import { guardInputs, Legs, type OwnerSnapshot } from './legs.ts';
import { HttpError, parseRelayBody, RateLimiter, Relayer } from './relayer.ts';
import type { Deps } from './server.ts';
import { position } from './market.ts';
import type { Draft } from './strategy/builder.ts';
import type { StrategyManager } from './strategy/manager.ts';
import { specHash, validateSpec, type SpecContext, type StrategySpec } from './strategy/spec.ts';

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
/** The recorded freeze (agents.revoked) and the recorded live proposals (C18b: Jev factors -> Claude). */
export const FREEZE_LIVE = new URL('../results/freeze-live.json', import.meta.url);
export const C18B = new URL('../../validation/results/C18b.json', import.meta.url);
/** Recorded Phase 2 runs: the grid and the TWAP on leg 3, and the strategy builder's drafts (live Claude). */
export const GRID_LIVE = new URL('../results/grid-live.json', import.meta.url);
export const TWAP_LIVE = new URL('../results/twap-live.json', import.meta.url);
export const DRAFT_LIVE = new URL('../results/draft-live.json', import.meta.url);

type RecordedEvent = { t: number; type: string; data: Record<string, unknown> };
const readJson = <T>(u: URL) => JSON.parse(readFileSync(u, 'utf8')) as T;

/**
 * Strategies without a network: /strategies/:owner starts with the recorded grid, /strategy/start|pause|stop|resume change
 * a simulated list (nothing trades), and validation is the real validateSpec against the fixture's policy.
 */
export function dryStrategies(owner: Hex, bus: EventBus, ctx: () => SpecContext) {
  const grid = readJson<{ spec: StrategySpec; events: RecordedEvent[] }>(GRID_LIVE);
  const specs = new Map<string, StrategySpec>([[grid.spec.id, grid.spec]]);
  const states = new Map<string, string>([[grid.spec.id, 'running']]);
  const status = (id: string) => {
    const spec = specs.get(id)!;
    return { id, type: spec.type, leg: spec.leg, coin: spec.coin, state: states.get(id)!, deadman: 'unavailable', held: [], resting: states.get(id) === 'running' ? 3 : 0, spec, simulated: true };
  };
  const emit = (type: string, id: string, extra: Record<string, unknown> = {}) => bus.emit(`strategy.${type}`, { owner, id, leg: specs.get(id)?.leg, simulated: true, ...extra });
  const live = (id: string) => specs.has(id) && states.get(id) !== 'stopped';
  return {
    list: (o: Hex) => (o === owner ? [...specs.keys()].map(status) : []),
    get: (o: Hex, id: string) => (o === owner && live(id) ? specs.get(id) : undefined),
    specs: (o: Hex) => (o === owner ? [...specs.keys()].filter(live).map((id) => specs.get(id)!) : []),
    context: async () => ctx(),
    async validate(_o: Hex, input: unknown) {
      const id = (input as { id?: string } | null)?.id;
      const c = ctx();
      const r = validateSpec(input, { ...c, busyLegs: [] }); // simulated: a start on a used leg replaces that strategy
      if (r.ok && id && live(id) && !(states.get(id) === 'paused' && specHash(specs.get(id)!) === specHash(r.spec))) {
        return { ok: false as const, errors: [`strategy ${id} already exists (${states.get(id)}); stop it first, or send the identical spec to resume a paused one`] };
      }
      return r;
    },
    async start(_o: Hex, spec: StrategySpec) {
      for (const [id, other] of specs) if (id !== spec.id && other.leg === spec.leg && live(id)) (states.set(id, 'stopped'), emit('stopped', id, { reason: `replaced by ${spec.id}`, cancelled: 0, flattened: false }));
      if (!specs.has(spec.id)) emit('started', spec.id, { type: spec.type, coin: spec.coin });
      else emit('resumed', spec.id);
      specs.set(spec.id, spec);
      states.set(spec.id, 'running');
      return status(spec.id);
    },
    async pause(_o: Hex, id: string) {
      if (!live(id)) throw new Error(`no strategy ${id}`);
      states.set(id, 'paused');
      emit('paused', id, { reason: 'owner', cancelled: 0 });
      return status(id);
    },
    async stop(_o: Hex, id: string) {
      if (!specs.has(id)) throw new Error(`no strategy ${id}`);
      states.set(id, 'stopped');
      emit('stopped', id, { reason: 'owner', cancelled: 0, flattened: false });
      return status(id);
    },
    cancelAll: async () => {},
    shutdown: () => {},
  } as unknown as StrategyManager;
}

/** The recorded strategy events (grid run, then TWAP run with its restart), compressed 4x, for the /events replay. */
export function recordedStrategyEvents(owner: Hex, gapMs = 3000): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  let base = 0;
  for (const f of [GRID_LIVE, TWAP_LIVE]) {
    const evs = readJson<{ events: RecordedEvent[] }>(f).events.filter((e) => e.type.startsWith('strategy.'));
    for (const e of evs) out.push({ t: base + e.t / 4, type: e.type, data: { ...e.data, owner, recorded: true } });
    base += (evs.at(-1)?.t ?? 0) / 4 + gapMs;
  }
  return out;
}

/** C18b's recorded proposals as proposeAction output (ids dry-s01..). */
export function recordedProposals(): Proposal[] {
  const rows = (JSON.parse(readFileSync(C18B, 'utf8')) as { refs: { rows: Record<string, any>[] } }).refs.rows;
  return rows.map((r) => ({
    id: `dry-${r.id}`,
    action: r.action,
    source: r.source,
    factors: r.factors,
    rationale: r.rationale,
    latencyMs: r.latencyMs,
    model: r.model,
    flagged: r.flagged,
    ...(r.error ? { error: r.error } : {}),
    trace: { jevMs: r.jevMs, calls: r.calls, tableAction: r.tableAction },
  }));
}

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
  const dataDir = mkdtempSync(join(tmpdir(), 'hypernear-dry-'));
  const legs = new Legs({ client, dataDir, network: 'testnet', coins: config.policy.allowedCoins });
  legs.snapshot = async (owner) => ({ ...snap, owner: owner.toLowerCase() as Hex, at: Date.now(), legs: owner.toLowerCase() === snap.owner ? snap.legs : [] });
  const bus = new EventBus();
  const recorded = JSON.parse(readFileSync(GUARD_DEMO, 'utf8')) as { timeline: { t: number; event: string; detail?: Record<string, unknown> }[] };
  const revoked = (JSON.parse(readFileSync(FREEZE_LIVE, 'utf8')) as { events: { type: string; data: Record<string, unknown> }[] }).events;
  const proposals = recordedProposals();
  // the agent account the fixture policy names, so /owner's config.agentAccount passes the opt-in check (no key: nothing signs here)
  const dryConfig = { ...config, contractId: DRY_CONTRACT_ID, nearAgent: { accountId: DRY_AGENT, secretKey: '' } };
  const decider = new Decider({
    legs,
    bus,
    policy: config.policy,
    annualVol: config.guard.annualVol,
    modes: new DecisionModes(dataDir),
    // POST /decision/propose cycles through the recorded proposals (no model calls in the dry run)
    propose: async () => ({ ...proposals[nextProposal++ % proposals.length]!, id: `dry-${randomUUID()}` }),
    async execute(owner, action, coin, orders) {
      bus.emit('hedge', { owner, op: action, coin, simulated: true, orders });
      return { simulatedFills: orders.map((o) => ({ leg: o.leg, oid: 0, totalSz: o.size, avgPx: String(snap.market.mids[coin]) })) };
    },
    checkOwner: async (owner) => {
      const st = policyOf(owner);
      if (st?.agent !== DRY_AGENT) throw new HttpError(403, 'owner has not opted this agent in (setPolicy)');
    },
    owners: () => [snap.owner],
    ttlMs: Number.POSITIVE_INFINITY,
  });
  let nextProposal = 0;
  const replayedProposals = proposals.map((proposal) => ({ proposal, owner: snap.owner, coin: 'BTC', at: Date.now(), status: 'open' as const, recorded: true }));
  for (const r of replayedProposals) decider.remember(r, true);

  const recordedDrafts = readJson<{ results: Record<string, unknown>[] }>(DRAFT_LIVE).results;
  let nextDraft = 0;
  // POST /strategy/draft answers with the recorded live drafts (same text first, else in turn); no model call
  const drafter = async (_owner: Hex, text: string): Promise<Draft> => {
    const row = recordedDrafts.find((r) => r.text === text) ?? recordedDrafts[nextDraft++ % recordedDrafts.length]!;
    const { text: _t, ms: _ms, ...draft } = row;
    return draft as unknown as Draft;
  };
  const strategies = dryStrategies(snap.owner, bus, () => ({
    orderPolicy: config.policy,
    registeredLegs: [0, 1, 2, 3],
    reservedLegs: [0, 1, 2],
    busyLegs: [],
    owner: policyOf(snap.owner),
    agentId: DRY_AGENT,
    otherTopUpBudget: 0,
  }));

  return {
    config: dryConfig,
    client,
    legs,
    bus,
    decider,
    strategies,
    drafter,
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
        const tEnd = recorded.timeline.at(-1)?.t ?? t0;
        // guard demo, then the recorded decision proposals (C18b), then the recorded freeze revocation, 2 s apart
        const strategyStart = tEnd + 2000 * (replayedProposals.length + revoked.length + 2);
        const script = [
          ...recordedStrategyEvents(snap.owner).map((e) => ({ t: strategyStart + e.t, type: e.type, data: e.data })),
          ...recorded.timeline.map((x) => ({ t: x.t, type: x.event, data: { ...x.detail, owner: snap.owner, recordedOffsetMs: x.t } })),
          ...replayedProposals.map((r, i) => ({ t: tEnd + 2000 * (i + 1), type: DECISION_EVENTS.proposed, data: proposalEvent(r) })),
          ...revoked.map((e, i) => ({ t: tEnd + 2000 * (replayedProposals.length + i + 1), type: e.type, data: { ...e.data, recorded: true } })),
        ];
        const timers = script.map((x) =>
          setTimeout(() => write({ id: id++, type: x.type, at: Date.now(), data: { ...x.data, dryRun: true } }), start + (x.t - t0) / speed)
        );
        return () => timers.forEach(clearTimeout);
      },
    },
  };
}

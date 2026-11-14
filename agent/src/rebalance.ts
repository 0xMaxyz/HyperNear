// Owner-signed leg rebalance: the owner picks legs and percentages, the pool of those legs' own USDC is redistributed to them.
// The owner signs the TARGETS (spec hash, owner key only, never a session key). The moves are computed here from live balances and
// carried out one by one with the contract's agent methods, so the contract's own rules stay in force: a destination must be one of
// the owner's registered legs, and every move counts against the daily cap and the cooldown. Moves are not atomic; the planner is
// idempotent, so a run that stopped half way is finished by running it again.
import type { Hex } from 'viem';
import type { OwnerState } from '@hypernear/client';
import type { EventBus } from './events.ts';
import { isUnified } from './funds.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard, type GuardConfig } from './guard.ts';
import { guardInputs, MAX_LEGS, type Legs, type OwnerSnapshot } from './legs.ts';
import { HttpError } from './relayer.ts';
import type { Transfer } from './transfer.ts';

export interface RebalanceSpec {
  legs: { leg: number; pct: number }[];
}

export interface RebalanceMove {
  from: { leg: number; address: Hex };
  to: { leg: number; address: Hex };
  /** USDC sent, with HL's 1 USDC new-account fee on top when the destination was never credited (the leg receives `receives`) */
  amount: string;
  receives: string;
  feeUsd: 0 | 1;
  /** extra USDC the source leg pays for its first transfer out (not part of `amount`) */
  sourceFeeUsd: 0 | 1;
  transfer: Transfer;
}

export interface RebalanceRow {
  leg: number;
  pct: number;
  before: number;
  target: number;
  after: number;
  /** what the leg can give now (free balance, with a margin of safety) */
  movable: number;
}

export interface RebalancePlan {
  rows: RebalanceRow[];
  moves: RebalanceMove[];
  /** USDC leaving legs, fees on top included */
  sentUsd: number;
  /** seconds the moves take, cooldown included */
  waitSec: number;
  notes: string[];
}

export type RebalanceCheck = { ok: true; spec: RebalanceSpec; plan: RebalancePlan } | { ok: false; errors: string[] };

export interface RebalanceCtx {
  snapshot: OwnerSnapshot;
  policy: OwnerState | null;
  /** the NEAR account the contract lets move money for this owner (absent in TEE mode, where the contract decides) */
  agentId?: string;
  busyLegs: number[];
  nowMs: number;
  annualVol: number;
  guard?: GuardConfig;
  cfg?: Partial<typeof DEFAULTS>;
}

const DEFAULTS = {
  /** smallest move worth a transaction (USD) */
  minUsd: 1,
  /** share of a leg's free balance it may give */
  freeShare: 0.9,
  /** longest a run may take, cooldown between moves included */
  maxWaitSec: 600,
};
const DAY_MS = 86_400_000;
const cents = (usd: number) => Math.round(usd * 100);
const usd = (c: number) => c / 100;
const fixed = (c: number) => (c / 100).toFixed(2);

/** Accepts the spec exactly as sent and plans the moves from the current balances, or lists every reason it cannot run. Pure. */
export function validateRebalanceSpec(input: unknown, ctx: RebalanceCtx): RebalanceCheck {
  const cfg = { ...DEFAULTS, ...ctx.cfg };
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['rebalance spec must be a JSON object'] };
  for (const k of Object.keys(input)) if (k !== 'legs') errors.push(`${k} is not a field of a rebalance spec`);
  const raw = (input as { legs?: unknown }).legs;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_LEGS) return { ok: false, errors: [...errors, `legs must list from 2 to ${MAX_LEGS} legs`] };
  const picked: { leg: number; pct: number }[] = [];
  for (const r of raw) {
    const o = r as { leg?: unknown; pct?: unknown };
    if (typeof r !== 'object' || r === null || Object.keys(r).some((k) => k !== 'leg' && k !== 'pct')) errors.push('each entry is {leg, pct}');
    else if (!Number.isInteger(o.leg) || (o.leg as number) < 0 || (o.leg as number) >= MAX_LEGS) errors.push(`leg must be a whole number from 0 to ${MAX_LEGS - 1}`);
    else if (!Number.isInteger(o.pct) || (o.pct as number) < 1 || (o.pct as number) > 99) errors.push(`leg ${String(o.leg)}: pct must be a whole number from 1 to 99`);
    else picked.push({ leg: o.leg as number, pct: o.pct as number });
  }
  if (errors.length) return { ok: false, errors };
  if (new Set(picked.map((p) => p.leg)).size !== picked.length) errors.push('a leg can be listed only once');
  if (picked.reduce((s, p) => s + p.pct, 0) !== 100) errors.push('the percentages must add up to 100');
  const states = picked.map((p) => ({ ...p, st: ctx.snapshot.legs.find((l) => l.leg === p.leg) }));
  for (const s of states) if (!s.st) errors.push(`leg ${s.leg} is not registered`);
  for (const s of states) if (ctx.busyLegs.includes(s.leg)) errors.push(`leg ${s.leg} is running a strategy: stop it before moving its money`);
  if (errors.length) return { ok: false, errors };
  const legs = states.map((s) => ({ ...s, st: s.st! }));
  const unified = isUnified(legs[0]!.st.abstraction);
  if (legs.some((l) => isUnified(l.st.abstraction) !== unified)) return { ok: false, errors: ['the legs are in different account modes (unified and default): money moves between legs of one mode only, convert the others first'] };
  const transfer: Transfer = unified ? 'sendAsset' : 'usdSend';

  // balances in whole cents: the targets add up to the pool exactly, the remainder goes to the largest share
  const before = legs.map((l) => cents(Number(l.st.clearinghouse.marginSummary.accountValue)));
  const pool = before.reduce((a, b) => a + b, 0);
  const target = legs.map((l) => Math.floor((pool * l.pct) / 100));
  const biggest = legs.reduce((bi, l, i) => (l.pct > legs[bi]!.pct ? i : bi), 0);
  target[biggest]! += pool - target.reduce((a, b) => a + b, 0);

  const sourceFee = legs.map((l) => (l.st.activation === 'owed-on-first-send' ? 100 : 0));
  const movable = legs.map((l, i) => Math.max(0, Math.floor(cents(Number(l.st.clearinghouse.withdrawable)) * cfg.freeShare) - sourceFee[i]!));
  const give = legs.map((_, i) => Math.min(Math.max(0, before[i]! - target[i]!), movable[i]!));
  const want = legs.map((_, i) => Math.max(0, target[i]! - before[i]!));

  const givers = legs.map((_, i) => i).filter((i) => give[i]! > 0).sort((a, b) => give[b]! - give[a]!);
  const takers = legs.map((_, i) => i).filter((i) => want[i]! > 0).sort((a, b) => want[b]! - want[a]!);
  const moves: RebalanceMove[] = [];
  const out = legs.map(() => 0); // cents leaving each leg
  const inn = legs.map(() => 0); // cents arriving
  const feePaid = new Set<number>();
  const sourcePaid = new Set<number>();
  const notes: string[] = [];
  const left = give.slice();
  const need = want.slice();
  for (const t of takers) {
    for (const g of givers) {
      const amt = Math.min(left[g]!, need[t]!);
      if (amt <= 0) continue;
      if (amt < cents(cfg.minUsd)) continue; // dust: not worth a transaction
      const fee = legs[t]!.st.activation === 'owed-on-credit' && !feePaid.has(t) ? 100 : 0;
      const sFee = sourceFee[g]! && !sourcePaid.has(g) ? 100 : 0;
      if (fee) feePaid.add(t);
      if (sFee) sourcePaid.add(g);
      left[g]! -= amt;
      need[t]! -= amt;
      out[g]! += amt + fee + sFee;
      inn[t]! += amt;
      moves.push({
        from: { leg: legs[g]!.leg, address: legs[g]!.st.address },
        to: { leg: legs[t]!.leg, address: legs[t]!.st.address },
        amount: fixed(amt + fee),
        receives: fixed(amt),
        feeUsd: fee ? 1 : 0,
        sourceFeeUsd: sFee ? 1 : 0,
        transfer,
      });
    }
  }
  const rows: RebalanceRow[] = legs.map((l, i) => ({
    leg: l.leg,
    pct: l.pct,
    before: usd(before[i]!),
    target: usd(target[i]!),
    after: usd(before[i]! - out[i]! + inn[i]!),
    movable: usd(movable[i]!),
  }));
  for (let i = 0; i < legs.length; i++) {
    const short = want[i]! - inn[i]!;
    if (short >= cents(cfg.minUsd) && moves.length > 0) notes.push(`leg ${legs[i]!.leg} ends $${fixed(short)} short of its share: the legs that hold more can only give what is free now (the rest is margin for open positions)`);
  }
  if (!moves.length) {
    notes.push(want.some((w) => w >= cents(cfg.minUsd)) ? 'nothing can move now: the legs that hold more have no free balance' : 'the legs are already at these shares (within $1)');
    return { ok: true, spec: { legs: picked }, plan: { rows, moves, sentUsd: 0, waitSec: 0, notes } };
  }

  // the contract's own rules, checked here so the owner hears about them before signing
  const sentUsd = usd(out.reduce((a, b) => a + b, 0));
  const p = ctx.policy;
  if (!p || !p.agent) errors.push('owner has not opted an agent in (setPolicy)');
  else {
    if (ctx.agentId && p.agent !== ctx.agentId) errors.push(`policy agent is ${p.agent}, not this service (${ctx.agentId})`);
    if (p.frozen) errors.push('owner is frozen');
  }
  let waitSec = 0;
  if (p) {
    const spent = p.day === Math.floor(ctx.nowMs / DAY_MS) ? p.spent_today : 0;
    const capLeft = Math.max(0, p.daily_cap - spent) / 1e6;
    if (sentUsd > capLeft + 1e-9) errors.push(`the moves need $${sentUsd.toFixed(2)} (fees included) but the daily cap has $${capLeft.toFixed(2)} left`);
    const cooldownEnds = p.last_rebalance_ns > 0 ? p.last_rebalance_ns / 1e6 + p.cooldown_sec * 1000 : 0;
    waitSec = Math.max(0, Math.ceil((cooldownEnds - ctx.nowMs) / 1000)) + (moves.length - 1) * p.cooldown_sec;
    if (waitSec > cfg.maxWaitSec) errors.push(`${moves.length} moves with a ${p.cooldown_sec} s cooldown take about ${Math.ceil(waitSec / 60)} minutes: lower the cooldown in your policy, or choose fewer legs`);
  }

  // a leg that gives money must stay clear of the margin guard, or the guard would pull the money straight back
  const projected: OwnerSnapshot = {
    ...ctx.snapshot,
    legs: ctx.snapshot.legs.map((l) => {
      const i = legs.findIndex((x) => x.leg === l.leg);
      if (i < 0 || out[i] === 0) return l;
      const gone = usd(out[i]!);
      const ms = l.clearinghouse.marginSummary;
      return { ...l, clearinghouse: { ...l.clearinghouse, marginSummary: { ...ms, accountValue: String(Number(ms.accountValue) - gone) }, withdrawable: String(Number(l.clearinghouse.withdrawable) - gone) } };
    }),
  };
  const gave = new Set(legs.filter((_, i) => out[i]! > 0).map((l) => l.leg));
  for (const r of evaluateGuard(guardInputs(projected, ctx.annualVol), ctx.guard ?? DEFAULT_GUARD_CONFIG)) {
    const m = /^leg(\d+):/.exec(r.id);
    if (r.trigger && m && gave.has(Number(m[1]))) errors.push(`moving money out of leg ${m[1]} would put its ${r.id.split(':')[1]} position under the margin guard's floor`);
  }
  if (errors.length) return { ok: false, errors };
  if (moves.length > 1) notes.push(`${moves.length} moves run one after another; the contract's cooldown spaces them`);
  return { ok: true, spec: { legs: picked }, plan: { rows, moves, sentUsd, waitSec, notes } };
}

export interface RebalanceStep {
  from: number;
  to: number;
  amount: string;
  status: 'sent' | 'failed';
  at: number;
  error?: string;
}

export interface RebalanceJob {
  id: string;
  owner: Hex;
  spec: RebalanceSpec;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  /** what the first plan promised */
  planned: number;
  steps: RebalanceStep[];
  error?: string;
}

export interface RebalancerDeps {
  legs: Legs;
  bus: EventBus;
  annualVol: number;
  guard?: GuardConfig;
  /** the NEAR account that may move this owner's money; absent in TEE mode */
  agentId?: string;
  /** legs with a running strategy */
  busyLegs: (owner: Hex) => number[];
  /** the owner's contract policy (cap, cooldown, nonce) */
  policy: (owner: Hex) => Promise<OwnerState | null>;
  /** carries out one planned move; throws when the contract or Hyperliquid refuses */
  send: (owner: Hex, move: RebalanceMove) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Plans and runs rebalances, one job per owner at a time. */
export class Rebalancer {
  readonly #d: RebalancerDeps;
  readonly #jobs = new Map<string, RebalanceJob>();
  #seq = 0;

  constructor(d: RebalancerDeps) {
    this.#d = d;
  }

  job(owner: Hex): RebalanceJob | undefined {
    return this.#jobs.get(owner);
  }

  async #check(owner: Hex, spec: unknown): Promise<RebalanceCheck> {
    const now = this.#d.now ?? Date.now;
    return validateRebalanceSpec(spec, {
      snapshot: await this.#d.legs.snapshot(owner),
      policy: await this.#d.policy(owner),
      agentId: this.#d.agentId,
      busyLegs: this.#d.busyLegs(owner),
      nowMs: now(),
      annualVol: this.#d.annualVol,
      guard: this.#d.guard,
    });
  }

  /** Read-only: what the spec would do right now. */
  preview(owner: Hex, spec: unknown): Promise<RebalanceCheck> {
    return this.#check(owner, spec);
  }

  /** Validates, then runs the moves in the background. Throws 422 with every reason, or 409 while this owner's last run is going. */
  async start(owner: Hex, spec: unknown): Promise<{ job: RebalanceJob; plan: RebalancePlan }> {
    if (this.#jobs.get(owner)?.state === 'running') throw new HttpError(409, 'a rebalance for this owner is still running');
    const check = await this.#check(owner, spec);
    if (!check.ok) throw new HttpError(422, check.errors.join('; '));
    const job: RebalanceJob = { id: `rb-${++this.#seq}`, owner, spec: check.spec, state: 'running', startedAt: (this.#d.now ?? Date.now)(), planned: check.plan.moves.length, steps: [] };
    this.#jobs.set(owner, job);
    this.#d.bus.emit('rebalance.start', { owner, id: job.id, spec: job.spec, moves: check.plan.moves });
    void this.#run(job);
    return { job, plan: check.plan };
  }

  /** Re-plans before every move (balances and the cooldown move on), sends the first move of the fresh plan, and repeats until the legs are at their shares. */
  async #run(job: RebalanceJob) {
    const { owner } = job;
    const now = this.#d.now ?? Date.now;
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const finish = (state: 'done' | 'failed', error?: string) => {
      job.state = state;
      job.endedAt = now();
      if (error) job.error = error;
      this.#d.bus.emit(state === 'done' ? 'rebalance.done' : 'rebalance.failed', { owner, id: job.id, steps: job.steps, ...(error && { error }) });
    };
    try {
      for (let i = 0; i <= MAX_LEGS; i++) {
        const policy = await this.#d.policy(owner);
        if (policy && policy.last_rebalance_ns > 0) {
          const wait = policy.last_rebalance_ns / 1e6 + policy.cooldown_sec * 1000 - now();
          if (wait > 0) await sleep(wait + 500);
        }
        const check = await this.#check(owner, job.spec);
        if (!check.ok) return finish('failed', check.errors.join('; '));
        const move = check.plan.moves[0];
        if (!move) return finish('done');
        const step: RebalanceStep = { from: move.from.leg, to: move.to.leg, amount: move.amount, status: 'sent', at: now() };
        job.steps.push(step);
        try {
          await this.#d.send(owner, move);
          this.#d.bus.emit('rebalance.move', { owner, id: job.id, ...step });
          await sleep(3000); // let Hyperliquid book the transfer before the next plan reads the balances
        } catch (e) {
          step.status = 'failed';
          step.error = (e as Error).message.slice(0, 300);
          return finish('failed', step.error);
        }
      }
      finish('failed', 'stopped after the most moves a rebalance of these legs can need');
    } catch (e) {
      finish('failed', (e as Error).message.slice(0, 300));
    }
  }
}

// The live margin guard: every interval, per watched owner, snapshot the legs, run guard.ts, and on a trigger move
// USDC from the healthiest leg to the stressed one with the contract's `rebalance` (agent function-call key).
// Deterministic: no model in the loop. Every step goes to the event bus (/events).
import type { Hex } from 'viem';
import { HyperNearClient, NearMasterSigner, type OwnerState } from '@hypernear/client';
import type { EventBus } from './events.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard, type GuardConfig, type GuardLegResult } from './guard.ts';
import { guardInputs, type Legs, type OwnerSnapshot } from './legs.ts';
import { hlClient } from './market.ts';

export interface GuardLoopConfig {
  intervalMs: number;
  guard: GuardConfig;
  annualVol: number;
  /** Top the stressed leg up to this multiple of its maintenance margin. */
  targetMultiple: number;
  /** Smallest rebalance worth a transaction (USD). */
  minUsd: number;
  /** Share of the source leg's withdrawable the guard may take. */
  withdrawableShare: number;
  /** A leg with a strategy budget (see planRebalance) is only ever topped up from this leg. */
  reserveLeg: number;
}

export const DEFAULT_LOOP_CONFIG: GuardLoopConfig = {
  intervalMs: 10_000,
  guard: DEFAULT_GUARD_CONFIG,
  annualVol: 0.6,
  targetMultiple: 5,
  minUsd: 1,
  withdrawableShare: 0.9,
  reserveLeg: 2,
};

export type RebalancePlan =
  | { kind: 'none' }
  | { kind: 'blocked'; stressedLeg: number; reason: string }
  | { kind: 'rebalance'; from: { leg: number; address: Hex }; to: { leg: number; address: Hex }; amount: string; reasons: string[]; /** USDC of `amount` that HL keeps as the new leg's activation fee (0 or 1); the leg receives amount - activationFeeUsd */ activationFeeUsd: 0 | 1; /** extra USDC the source leg pays for its first transfer out (not part of `amount`) */ sourceFeeUsd: 0 | 1 };

const DAY_MS = 86_400_000;

function legRatio(s: OwnerSnapshot, leg: number) {
  const ch = s.legs.find((l) => l.leg === leg)!.clearinghouse;
  const maint = Number(ch.crossMaintenanceMarginUsed);
  return { accountValue: Number(ch.marginSummary.accountValue), maint, ratio: maint > 0 ? Number(ch.marginSummary.accountValue) / maint : Infinity, withdrawable: Number(ch.withdrawable) };
}

/** Pure decision: which leg tops up which, and how much, within withdrawable, the contract cap and the cooldown. */
export function planRebalance(
  s: OwnerSnapshot,
  results: GuardLegResult[],
  policy: OwnerState | null,
  agentId: string | undefined,
  nowMs: number,
  cfg: GuardLoopConfig = DEFAULT_LOOP_CONFIG,
  /** USD a strategy leg may still be topped up today (the strategy's topUpCapPerDay); undefined: the leg has no strategy budget */
  budgetLeftUsd?: (leg: number) => number | undefined
): RebalancePlan {
  const triggered = results.filter((r) => r.trigger);
  if (!triggered.length) return { kind: 'none' };
  const stressedLegs = [...new Set(triggered.map((r) => Number(/^leg(\d+):/.exec(r.id)![1])))];
  const stressed = stressedLegs.sort((a, b) => legRatio(s, a).ratio - legRatio(s, b).ratio)[0]!;
  const blocked = (reason: string): RebalancePlan => ({ kind: 'blocked', stressedLeg: stressed, reason });
  if (!policy || !policy.agent) return blocked('owner has not opted an agent in (setPolicy)');
  if (agentId && policy.agent !== agentId) return blocked(`policy agent is ${policy.agent}, not this service (${agentId})`);
  if (policy.frozen) return blocked('owner is frozen');
  const cooldownEndsMs = policy.last_rebalance_ns / 1e6 + policy.cooldown_sec * 1000;
  if (policy.last_rebalance_ns > 0 && nowMs < cooldownEndsMs) return blocked(`cooldown for ${Math.ceil((cooldownEndsMs - nowMs) / 1000)} s`);
  const spent = policy.day === Math.floor(nowMs / DAY_MS) ? policy.spent_today : 0;
  const capLeftUsd = Math.max(0, policy.daily_cap - spent) / 1e6;
  const budget = budgetLeftUsd?.(stressed);
  const sources = s.legs
    .filter((l) => !stressedLegs.includes(l.leg))
    .filter((l) => budget === undefined || l.leg === cfg.reserveLeg)
    // a leg with any strategy budget (a running strategy) is never drained to top up another leg
    .filter((l) => budgetLeftUsd?.(l.leg) === undefined)
    .map((l) => ({ leg: l.leg, address: l.address, ...legRatio(s, l.leg) }))
    .filter((l) => l.withdrawable > 0)
    .sort((a, b) => b.ratio - a.ratio || b.withdrawable - a.withdrawable);
  const src = sources[0];
  if (!src) return blocked(budget === undefined ? 'no other leg without a strategy has withdrawable USDC' : `reserve leg ${cfg.reserveLeg} has no withdrawable USDC`);
  const to = s.legs.find((l) => l.leg === stressed)!;
  const fee = to.activation === 'owed-on-credit' ? 1 : 0; // HL keeps 1 USDC of the first credit to a never-seen account (sent on top, so the leg receives what the guard computed); a source leg that has never sent pays 1 more
  if (budget !== undefined && budget < cfg.minUsd + fee) return blocked(`strategy top-up budget used (leg ${stressed}: $${budget.toFixed(2)} left today${fee ? ', 1 USDC of it is the leg HL activation fee' : ''})`);
  const st = legRatio(s, stressed);
  const needed = Math.max(cfg.targetMultiple * st.maint - st.accountValue, cfg.minUsd);
  const sourceFee = s.legs.find((l) => l.leg === src.leg)!.activation === 'owed-on-first-send' ? 1 : 0;
  const amount = Math.floor(Math.min(needed, src.withdrawable * cfg.withdrawableShare - fee - sourceFee, capLeftUsd, (budget ?? Number.POSITIVE_INFINITY) - fee) * 100) / 100;
  if (amount < cfg.minUsd) return blocked(`only $${amount.toFixed(2)} available (withdrawable / daily cap)`);
  if (amount + fee > capLeftUsd) return blocked(`$${amount.toFixed(2)} + 1 USDC HL activation fee for leg ${stressed} exceeds the daily cap left ($${capLeftUsd.toFixed(2)})`);
  return {
    kind: 'rebalance',
    from: { leg: src.leg, address: src.address },
    to: { leg: stressed, address: to.address },
    amount: (amount + fee).toFixed(2),
    activationFeeUsd: fee,
    sourceFeeUsd: sourceFee,
    reasons: triggered.filter((r) => r.id.startsWith(`leg${stressed}:`)).flatMap((r) => r.reasons),
  };
}

export interface GuardLoopDeps {
  legs: Legs;
  /** Sends `rebalance` with the NEAR agent account (function-call key); absent = detect and report only. */
  agentClient?: HyperNearClient;
  agentId?: string;
  bus: EventBus;
  owners: () => Hex[] | Promise<Hex[]>;
  /** per-strategy daily top-up budget left on a leg (manager.topUpLeft); undefined = no strategy there */
  budgetLeftUsd?: (owner: Hex, leg: number) => number | undefined;
  /** called after a top-up was posted to HL (manager.recordTopUp); usd is what was sent, activationFeeUsd the part HL kept */
  onTopUp?: (owner: Hex, leg: number, usd: number, activationFeeUsd: number) => void;
  cfg?: Partial<GuardLoopConfig>;
  now?: () => number;
}

export class GuardLoop {
  readonly d: GuardLoopDeps;
  readonly cfg: GuardLoopConfig;
  readonly #busy = new Set<string>();
  readonly #last = new Map<string, string>();
  #timer?: ReturnType<typeof setInterval>;

  constructor(d: GuardLoopDeps) {
    this.d = d;
    this.cfg = { ...DEFAULT_LOOP_CONFIG, ...d.cfg };
  }

  start() {
    this.#timer ??= setInterval(() => {
      void Promise.resolve(this.d.owners()).then(
        (owners) => owners.forEach((o) => void this.tick(o).catch((e) => this.d.bus.emit('guard.error', { owner: o, error: (e as Error).message }))),
        (e) => this.d.bus.emit('guard.error', { owner: '', error: (e as Error).message }),
      );
    }, this.cfg.intervalMs);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Emits only on state changes, so a steady trigger or block does not flood /events. */
  #emitChange(owner: string, key: string, type: string, data: Record<string, unknown>) {
    if (this.#last.get(owner) === key) return;
    this.#last.set(owner, key);
    this.d.bus.emit(type, { owner, ...data });
  }

  async tick(owner: Hex): Promise<RebalancePlan | undefined> {
    if (this.#busy.has(owner)) return undefined;
    this.#busy.add(owner);
    try {
      const now = this.d.now ?? Date.now;
      const snap = await this.d.legs.snapshot(owner);
      const results = evaluateGuard(guardInputs(snap, this.cfg.annualVol), this.cfg.guard);
      const plan = planRebalance(snap, results, await this.d.legs.client.getOwner(owner), this.d.agentId, now(), this.cfg, (leg) => this.d.budgetLeftUsd?.(owner, leg));
      const triggered = results.filter((r) => r.trigger);
      if (plan.kind === 'none') {
        this.#emitChange(owner, 'ok', 'guard.ok', { legs: results.map((r) => r.id) });
        return plan;
      }
      this.#emitChange(owner, `trigger:${triggered.map((r) => r.id).join(',')}:${plan.kind === 'blocked' ? plan.reason.replace(/\d+ s$/, '') : ''}`, 'guard.trigger', {
        detectedAt: now(),
        triggered,
        plan,
      });
      if (plan.kind === 'blocked' || !this.d.agentClient) return plan;
      const t0 = now();
      this.d.bus.emit('guard.rebalance.start', { owner, ...plan });
      const signer = await NearMasterSigner.create({
        client: this.d.agentClient,
        owner,
        leg: plan.from.leg,
        mode: 'agent',
        legAddress: plan.from.address,
        onNearTx: (tx) => this.d.bus.emit('guard.rebalance.signed', { owner, ...tx, ms: now() - t0 }),
      });
      const res = await hlClient(this.d.legs.network, { master: signer }).usdSend({ destination: plan.to.address, amount: plan.amount });
      this.d.bus.emit('guard.rebalance.posted', { owner, hl: res, ms: now() - t0 });
      this.d.onTopUp?.(owner, plan.to.leg, Number(plan.amount), plan.activationFeeUsd);
      this.#last.delete(owner); // the next tick reports the new state (ok, or still stressed)
      return plan;
    } finally {
      this.#busy.delete(owner);
    }
  }
}

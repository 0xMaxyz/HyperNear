// Decision wiring (propose mode / auto mode) around ts-dev's pure proposeAction (decide.ts).
// The guard loop is separate and never waits on this: proposals take 6-9 s (Jev, then Claude), so they run
// on their own 5-minute timer and off the request path.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Command } from '@hypernear/client';
import type { OrderPolicy } from './config.ts';
import { DECISION_EVENTS, type Action, type Proposal } from './decide.ts';
import type { EventBus } from './events.ts';
import { decisionInput, type DecisionInput } from './facts.ts';
import { HedgeRefused, planDecision, type PlannedOrder } from './hedge.ts';
import type { Legs, OwnerSnapshot } from './legs.ts';
import { HttpError } from './relayer.ts';

export const DECISION_MODES = ['off', 'propose', 'auto'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];
export const PROPOSE_INTERVAL_MS = 5 * 60_000;
const KEEP = 200;

/** Per-owner mode in `<dataDir>/decision-modes.json`. Default propose: proposing executes nothing. */
export class DecisionModes {
  readonly #file: string;
  constructor(dataDir: string) {
    this.#file = join(dataDir, 'decision-modes.json');
  }
  #read(): Record<string, DecisionMode> {
    return existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, 'utf8')) : {};
  }
  get(owner: string): DecisionMode {
    return this.#read()[owner.toLowerCase()] ?? 'propose';
  }
  set(owner: string, mode: DecisionMode) {
    writeFileSync(this.#file, JSON.stringify({ ...this.#read(), [owner.toLowerCase()]: mode }, null, 2));
  }
}

export interface ProposalRecord {
  proposal: Proposal;
  owner: Hex;
  coin: string;
  at: number;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  recorded?: boolean;
  /** HYPERNEAR_TEST=1 only: the action was forced; modelAction is what the models proposed */
  forced?: { modelAction: string };
}

/** The decision.proposed payload (flat; agreed with web-dev). */
export const proposalEvent = (r: ProposalRecord) => ({
  id: r.proposal.id,
  owner: r.owner,
  coin: r.coin,
  action: r.proposal.action,
  source: r.proposal.source,
  flagged: r.proposal.flagged,
  factors: r.proposal.factors,
  rationale: r.proposal.rationale,
  latencyMs: r.proposal.latencyMs,
  model: r.proposal.model,
  ...(r.proposal.error ? { error: r.proposal.error } : {}),
  ...(r.recorded ? { recorded: true } : {}),
  ...(r.forced ? { forced: true, modelAction: r.forced.modelAction } : {}),
});

export interface DeciderDeps {
  legs: Legs;
  bus: EventBus;
  policy: OrderPolicy;
  modes: DecisionModes;
  /** live: proposeAction with the Jev and Claude clients; dry run: recorded proposals */
  propose: (input: DecisionInput) => Promise<Proposal>;
  /** live: Hedger.runOrders; dry run: simulated */
  execute: (owner: Hex, action: string, coin: string, orders: PlannedOrder[]) => Promise<unknown>;
  /** throws HttpError(403) unless the owner opted this agent in and is not frozen */
  checkOwner: (owner: Hex) => Promise<void>;
  owners: () => Hex[];
  annualVol: number;
  /** when the hedge leg's position opened (ms), for the hedgeAge fact */
  openedAt?: (s: OwnerSnapshot, coin: string) => Promise<number>;
  intervalMs?: number;
  /** an open proposal can be accepted for this long (default: one interval) */
  ttlMs?: number;
  now?: () => number;
}

export class Decider {
  readonly d: DeciderDeps;
  readonly proposals = new Map<string, ProposalRecord>();
  readonly #busy = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;

  constructor(d: DeciderDeps) {
    this.d = d;
  }

  #now() {
    return (this.d.now ?? Date.now)();
  }

  start() {
    this.#timer ??= setInterval(() => {
      for (const o of this.d.owners()) {
        void this.prepare(o)
          .then((p) => ('input' in p ? this.run(p.input) : undefined))
          .catch((e) => console.error(`decision for ${o} failed:`, (e as Error).message));
      }
    }, this.d.intervalMs ?? PROPOSE_INTERVAL_MS);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  latest(owner: string): ProposalRecord | undefined {
    return [...this.proposals.values()].reverse().find((r) => r.owner === owner.toLowerCase());
  }

  /** Stores a proposal; older open ones of the same owner expire unless `keepOthers`. */
  remember(r: ProposalRecord, keepOthers = false) {
    if (!keepOthers) for (const x of this.proposals.values()) if (x.owner === r.owner && x.status === 'open') x.status = 'expired';
    this.proposals.set(r.proposal.id, r);
    while (this.proposals.size > KEEP) this.proposals.delete(this.proposals.keys().next().value!);
  }

  /** The fast checks (mode, opt-in, open hedge): the facts to propose on, or why not. */
  async prepare(owner: Hex): Promise<{ input: DecisionInput } | { skipped: string }> {
    if (this.d.modes.get(owner) === 'off') return { skipped: 'decision mode is off' };
    if (this.#busy.has(owner)) return { skipped: 'a proposal is already running' };
    try {
      await this.d.checkOwner(owner);
    } catch (e) {
      return { skipped: (e as Error).message };
    }
    const s = await this.d.legs.snapshot(owner);
    const input = decisionInput(s, this.d.policy.allowedCoins, { annualVol: this.d.annualVol, now: this.#now() });
    if (!input) return { skipped: 'no open hedge (leg0 long, leg1 short)' };
    const openedAt = this.d.openedAt ? await this.d.openedAt(s, input.coin).catch(() => 0) : 0;
    return { input: openedAt ? decisionInput(s, this.d.policy.allowedCoins, { annualVol: this.d.annualVol, openedAt, now: this.#now() })! : input };
  }

  /** The slow part: proposeAction, decision.proposed, and in auto mode the execution. */
  /** forceAction: test only (the server accepts it only with HYPERNEAR_TEST=1); the models still run and are recorded. */
  async run(input: DecisionInput, forceAction?: Action): Promise<ProposalRecord | undefined> {
    if (this.#busy.has(input.owner)) return undefined;
    this.#busy.add(input.owner);
    try {
      const modelProposal = await this.d.propose(input);
      const forced = forceAction && forceAction !== modelProposal.action ? { modelAction: modelProposal.action } : undefined;
      const proposal = forced ? { ...modelProposal, action: forceAction!, rationale: `TEST forceAction ${forceAction} (models: ${modelProposal.action}). ${modelProposal.rationale}` } : modelProposal;
      const r: ProposalRecord = { proposal, owner: input.owner, coin: input.coin, at: this.#now(), status: 'open', ...(forced ? { forced } : {}) };
      this.remember(r);
      this.d.bus.emit(DECISION_EVENTS.proposed, proposalEvent(r));
      // auto: same policy checks as a signed accept; flagged (disagreement, degraded) and hold stay open for the owner
      if (this.d.modes.get(input.owner) === 'auto' && !proposal.flagged && !proposal.error && proposal.action !== 'hold') {
        await this.#execute(r, true).catch(() => undefined); // already reported as decision.rejected
      }
      return r;
    } finally {
      this.#busy.delete(input.owner);
    }
  }

  /** The proposal a signed accept must match (the server verifies the command against its action). */
  get(id: string): ProposalRecord {
    const r = this.proposals.get(id);
    if (!r) throw new HttpError(404, 'unknown proposal');
    return r;
  }

  /** The open proposal `cmd` (already verified: signature, expiry, replay) is about; `action` is what cmd.action must be. */
  #open(id: string, cmd: Command, action: string) {
    const r = this.get(id);
    if (cmd.owner !== r.owner) throw new HttpError(403, 'command.owner is not the proposal owner');
    if (cmd.action !== action || cmd.coin !== r.coin) throw new HttpError(400, `command must be ${action} on ${r.coin}`);
    if (r.status === 'open' && this.#now() - r.at > (this.d.ttlMs ?? this.d.intervalMs ?? PROPOSE_INTERVAL_MS)) r.status = 'expired';
    if (r.status !== 'open') throw new HttpError(409, `proposal is ${r.status}`);
    return r;
  }

  async accept(id: string, cmd: Command) {
    const r = this.#open(id, cmd, this.get(id).proposal.action);
    return this.#execute(r, false);
  }

  /** The owner dismisses an open proposal (signed Command, action reject, coin = the proposal's). */
  reject(id: string, cmd: Command) {
    const r = this.#open(id, cmd, 'reject');
    r.status = 'rejected';
    const out = { id, owner: r.owner, coin: r.coin, action: r.proposal.action, auto: false, reason: 'owner' };
    this.d.bus.emit(DECISION_EVENTS.rejected, out);
    return { ...out, status: r.status };
  }

  async #execute(r: ProposalRecord, auto: boolean) {
    r.status = 'accepted'; // claimed before any await: a second accept gets 409
    const base = { id: r.proposal.id, owner: r.owner, coin: r.coin, action: r.proposal.action, auto };
    try {
      await this.d.checkOwner(r.owner);
      // fresh state: the proposal's snapshot is up to one interval old
      const plan = planDecision(await this.d.legs.snapshot(r.owner), r.proposal.action, r.coin, this.d.policy);
      if (!plan.ok) throw new HedgeRefused(plan.reason);
      const result = plan.orders.length ? await this.d.execute(r.owner, r.proposal.action, r.coin, plan.orders) : null;
      this.d.bus.emit(DECISION_EVENTS.accepted, { ...base, orders: plan.orders, result });
      return { ...base, status: r.status, orders: plan.orders, result };
    } catch (e) {
      r.status = 'rejected';
      this.d.bus.emit(DECISION_EVENTS.rejected, { ...base, reason: (e as Error).message });
      throw e;
    }
  }
}

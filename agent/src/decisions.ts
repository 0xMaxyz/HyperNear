// Decision wiring (propose mode / auto mode) around ts-dev's pure proposeAction (decide.ts).
// The guard loop is separate and never waits on this: proposals take 6-9 s (Jev, then Claude), so they run
// on their own 5-minute timer and off the request path.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Command } from '@hypernear/client';
import type { OrderPolicy } from './config.ts';
import { DECISION_EVENTS, decisionOptions, type Action, type DecisionOption, type Proposal } from './decide.ts';
import type { EventBus } from './events.ts';
import { decisionInput, type DecisionInput } from './facts.ts';
import { HedgeRefused, planDecision, type PlannedOrder } from './hedge.ts';
import type { Legs, OwnerSnapshot } from './legs.ts';
import { HttpError } from './relayer.ts';
import type { StrategyAction, StrategyInput, StrategyProposal } from './strategy/decide.ts';

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
  /** a hedge proposal (decide.ts) or a strategy proposal (strategy/decide.ts, `kind: 'strategy'`) */
  proposal: Proposal | StrategyProposal;
  owner: Hex;
  coin: string;
  at: number;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  recorded?: boolean;
  /** the actions the owner may choose between, least to most exposure (hedge proposals) */
  options?: DecisionOption[];
  /** until when it can be accepted (ms) */
  expiresAt?: number;
  /** HYPERNEAR_TEST=1 only: the action was forced; modelAction is what the models proposed */
  forced?: { modelAction: string };
}

export const isStrategy = (r: ProposalRecord): r is ProposalRecord & { proposal: StrategyProposal } => 'kind' in r.proposal && r.proposal.kind === 'strategy';

/** The decision.proposed payload (flat; agreed with web-dev). Strategy proposals add kind: 'strategy' and strategyId. */
export const proposalEvent = (r: ProposalRecord) => ({
  ...(isStrategy(r) ? { kind: 'strategy' as const, strategyId: r.proposal.strategyId } : {}),
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
  at: r.at,
  ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
  ...(r.options ? { options: r.options } : {}),
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
  /** Strategy decisions (propose only): the facts of an owner's running strategies, the proposal, and what accept does. */
  proposeStrategy?: (input: StrategyInput) => Promise<StrategyProposal>;
  strategyInputs?: (owner: Hex, strategyId?: string) => Promise<StrategyInput[]>;
  executeStrategy?: (owner: Hex, strategyId: string, action: StrategyAction) => Promise<unknown>;
  /** throws HttpError(403) unless the owner opted this agent in and is not frozen */
  checkOwner: (owner: Hex) => Promise<void>;
  owners: () => Hex[] | Promise<Hex[]>;
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

  #ttl() {
    return this.d.ttlMs ?? this.d.intervalMs ?? PROPOSE_INTERVAL_MS;
  }

  start() {
    this.#timer ??= setInterval(() => {
      void Promise.resolve(this.d.owners()).then((owners) => {
        for (const o of owners) {
          void this.prepare(o)
            .then((p) => ('input' in p ? this.run(p.input) : undefined))
            .catch((e) => console.error(`decision for ${o} failed:`, (e as Error).message));
          void this.prepareStrategies(o)
            .then((p) => ('inputs' in p ? Promise.all(p.inputs.map((i) => this.runStrategy(i, false))) : undefined))
            .catch((e) => console.error(`strategy decision for ${o} failed:`, (e as Error).message));
        }
      }, (e) => console.error('decision owners failed:', (e as Error).message));
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
    // a new proposal replaces the owner's open one of the same kind (hedge: any; strategy: the same strategy)
    const same = (x: ProposalRecord) => (isStrategy(r) ? isStrategy(x) && x.proposal.strategyId === r.proposal.strategyId : !isStrategy(x));
    if (!keepOthers) for (const x of this.proposals.values()) if (x.owner === r.owner && x.status === 'open' && same(x)) x.status = 'expired';
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

  /** The fast checks for strategy proposals: mode, opt-in, and the facts of the owner's running strategies (one, if given). */
  async prepareStrategies(owner: Hex, strategyId?: string): Promise<{ inputs: StrategyInput[] } | { skipped: string }> {
    if (!this.d.strategyInputs || !this.d.proposeStrategy) return { skipped: 'strategy decisions are off' };
    if (this.d.modes.get(owner) === 'off') return { skipped: 'decision mode is off' };
    try {
      await this.d.checkOwner(owner);
    } catch (e) {
      return { skipped: (e as Error).message };
    }
    const inputs = await this.d.strategyInputs(owner, strategyId);
    return inputs.length ? { inputs } : { skipped: strategyId ? `no running strategy ${strategyId}` : 'no running strategy' };
  }

  /** Strategy proposal (propose only: never executed here). The periodic timer announces only what is not "continue" or is flagged. */
  async runStrategy(input: StrategyInput, announceContinue = true): Promise<ProposalRecord | undefined> {
    const key = `${input.owner}:${input.strategyId}`;
    if (this.#busy.has(key)) return undefined;
    this.#busy.add(key);
    try {
      const proposal = await this.d.proposeStrategy!(input);
      const r: ProposalRecord = { proposal, owner: input.owner, coin: input.coin, at: this.#now(), status: 'open', expiresAt: this.#now() + this.#ttl() };
      this.remember(r);
      if (announceContinue || proposal.action !== 'continue_strategy' || proposal.flagged) this.d.bus.emit(DECISION_EVENTS.proposed, proposalEvent(r));
      return r;
    } finally {
      this.#busy.delete(key);
    }
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
      const r: ProposalRecord = { proposal, owner: input.owner, coin: input.coin, at: this.#now(), status: 'open', options: decisionOptions(input.ctx), expiresAt: this.#now() + this.#ttl(), ...(forced ? { forced } : {}) };
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
    if (r.status === 'open' && this.#now() - r.at > this.#ttl()) r.status = 'expired';
    if (r.status !== 'open') throw new HttpError(409, `proposal is ${r.status}`);
    return r;
  }

  /** The action a signed accept must carry: the owner's chosen option when the proposal lists it, else the proposal's own. */
  actionFor(id: string, option?: unknown): string {
    const r = this.get(id);
    if (option === undefined || isStrategy(r)) return r.proposal.action;
    if (typeof option !== 'string' || !r.options?.some((o) => o.action === option)) throw new HttpError(400, `option must be one of ${(r.options ?? []).map((o) => o.action).join(', ') || 'none (this proposal has no options)'}`);
    return option;
  }

  async accept(id: string, cmd: Command) {
    const r = this.#open(id, cmd, this.actionFor(id, cmd.action === this.get(id).proposal.action ? undefined : cmd.action));
    return isStrategy(r) ? this.#executeStrategy(r) : this.#execute(r, false, cmd.action as Action);
  }

  /** continue: acknowledged, nothing to do. pause / adjust: the strategy is paused (an adjusted one needs a new draft and a signed start). */
  async #executeStrategy(r: ProposalRecord & { proposal: StrategyProposal }) {
    r.status = 'accepted'; // claimed before any await: a second accept gets 409
    const { action, strategyId } = r.proposal;
    const base = { id: r.proposal.id, owner: r.owner, coin: r.coin, action, kind: 'strategy' as const, strategyId, auto: false };
    try {
      await this.d.checkOwner(r.owner);
      const result = action === 'continue_strategy' ? null : await this.d.executeStrategy!(r.owner, strategyId, action);
      this.d.bus.emit(DECISION_EVENTS.accepted, { ...base, result });
      return { ...base, status: r.status, result, ...(action === 'adjust_strategy' ? { next: 'POST /strategy/draft with the new range or size, then sign a startStrategy' } : {}) };
    } catch (e) {
      r.status = 'rejected';
      this.d.bus.emit(DECISION_EVENTS.rejected, { ...base, reason: (e as Error).message });
      throw e;
    }
  }

  /** The owner dismisses an open proposal (signed Command, action reject, coin = the proposal's). */
  reject(id: string, cmd: Command) {
    const r = this.#open(id, cmd, 'reject');
    r.status = 'rejected';
    const out = { id, owner: r.owner, coin: r.coin, action: r.proposal.action, auto: false, reason: 'owner' };
    this.d.bus.emit(DECISION_EVENTS.rejected, out);
    return { ...out, status: r.status };
  }

  async #execute(r: ProposalRecord, auto: boolean, chosen?: Action) {
    r.status = 'accepted'; // claimed before any await: a second accept gets 409
    const action = chosen ?? (r.proposal.action as Action);
    const base = { id: r.proposal.id, owner: r.owner, coin: r.coin, action, auto, ...(action !== r.proposal.action ? { proposed: r.proposal.action } : {}) };
    try {
      await this.d.checkOwner(r.owner);
      // fresh state: the proposal's snapshot is up to one interval old
      const plan = planDecision(await this.d.legs.snapshot(r.owner), action, r.coin, this.d.policy);
      if (!plan.ok) throw new HedgeRefused(plan.reason);
      const result = plan.orders.length ? await this.d.execute(r.owner, action, r.coin, plan.orders) : null;
      this.d.bus.emit(DECISION_EVENTS.accepted, { ...base, orders: plan.orders, result });
      return { ...base, status: r.status, orders: plan.orders, result };
    } catch (e) {
      r.status = 'rejected';
      this.d.bus.emit(DECISION_EVENTS.rejected, { ...base, reason: (e as Error).message });
      throw e;
    }
  }
}

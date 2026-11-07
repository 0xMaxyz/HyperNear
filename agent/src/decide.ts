/**
 * Decision layer (plan item 5): Jev first, Claude when Jev is not sure.
 *
 * Two layouts, same output (an Action):
 *  - `decide`: one 5-way `choice` question (options shuffled, Jev prefers the first one listed).
 *  - `decideByFactors`: several yes/no (`noul`) questions in ONE request, mapped to an action by a small
 *    deterministic table. Each factor must be decisive (p >= 0.90 or p <= 0.10) for Jev to decide alone;
 *    otherwise the undecided factors go to Claude together with Jev's numbers.
 *
 * Pure: the Jev and Claude clients are injected, so it runs offline against fixtures and in --dry-run replays.
 * `facts` must only hold computed, bucketed strings (no raw numbers, no free text): Jev trusts its state.
 * If Jev is unreachable Claude decides alone (flagged). If both fail, hold (flagged): the margin guard and the
 * contract policy stay in force, this layer never gates them.
 */

// Keep descriptions short (<= 40 chars). From ci32, Jev requests past roughly 1.4 KB hang (not seen from the
// laptop), and the plan wants short option descriptions anyway.
export const ACTIONS = {
  hold: 'keep both legs as they are',
  close_both: 'close both legs now',
  reduce_hedge: 'shrink the short leg',
  add_hedge: 'grow the short leg',
  take_profit: 'close the leg in profit, keep other',
} as const;
export type Action = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as Action[];

// ---------------------------------------------------------------- risk

/** Position state the facts do not carry (raw numbers never go to Jev); used only to rank actions by risk. */
export interface DecideContext {
  /** Notional of the long leg and of the short leg (USD, >= 0). */
  longNotional: number;
  shortNotional: number;
  /** Which leg is in profit (what take_profit would close); null when unknown. */
  profitLeg: 'long' | 'short' | null;
  /** Size of one add/reduce step as a fraction of the larger leg. Default 0.25. */
  stepFraction?: number;
}

const ORDERS: Record<Action, number> = { close_both: 2, hold: 0, reduce_hedge: 1, add_hedge: 1, take_profit: 1 };

/** Without state, rank for a long-heavy pair with the short leg in profit. */
const STATIC_ORDER: Action[] = ['close_both', 'add_hedge', 'hold', 'reduce_hedge', 'take_profit'];

/** Risk of an action = |net directional notional| left after it; ties go to the action with fewer orders. */
export function actionRisk(action: Action, ctx: DecideContext): { exposure: number; orders: number } {
  const { longNotional: L, shortNotional: S } = ctx;
  const step = (ctx.stepFraction ?? 0.25) * Math.max(L, S);
  let net: number;
  switch (action) {
    case 'close_both':
      net = 0;
      break;
    case 'hold':
      net = L - S;
      break;
    case 'add_hedge': // grows the short leg
      net = L - (S + step);
      break;
    case 'reduce_hedge': // shrinks the short leg
      net = L - Math.max(0, S - step);
      break;
    case 'take_profit': // closes the leg in profit; unknown leg: assume the worse case
      net = ctx.profitLeg === 'long' ? -S : ctx.profitLeg === 'short' ? L : Math.max(L, S);
      break;
  }
  return { exposure: Math.abs(net), orders: ORDERS[action] };
}

/** The less risky of two actions: lower exposure, then fewer orders, then the static order. */
export function lessRisky(a: Action, b: Action, ctx?: DecideContext): Action {
  if (a === b) return a;
  if (ctx) {
    const ra = actionRisk(a, ctx);
    const rb = actionRisk(b, ctx);
    if (ra.exposure !== rb.exposure) return ra.exposure < rb.exposure ? a : b;
    if (ra.orders !== rb.orders) return ra.orders < rb.orders ? a : b;
  }
  return STATIC_ORDER.indexOf(a) <= STATIC_ORDER.indexOf(b) ? a : b;
}

// ------------------------------------------------------------ shared types

export type Facts = Record<string, string>;

export interface Escalation {
  action: Action;
  rationale: string;
}

export interface JevAnswer {
  choice: Action;
  confidence: number;
  probabilities: Record<string, number>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fisherYates<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ------------------------------------------------- layout 1: one choice

export interface DecideDeps {
  /** Asks Jev; `order` is the option order to present. */
  jev(facts: Facts, order: Action[]): Promise<JevAnswer>;
  /** Asks Claude (structured output); `jev` is null when Jev failed. */
  escalate(facts: Facts, jev: JevAnswer | null, order: Action[]): Promise<Escalation>;
  shuffle?(xs: Action[]): Action[];
  now?(): number;
}

export interface DecideConfig {
  acceptProbability: number;
  acceptConfidence: number;
}

export const DEFAULT_DECIDE_CONFIG: DecideConfig = { acceptProbability: 0.9, acceptConfidence: 0.9 };

export type DecisionSource = 'jev' | 'claude_agrees' | 'less_risky_of_two' | 'claude_only' | 'fallback_hold';

export interface DecisionAudit {
  facts: Facts;
  order: Action[];
  jev: JevAnswer | null;
  jevError: string | null;
  escalation: Escalation | null;
  escalationError: string | null;
  jevMs: number | null;
  escalationMs: number | null;
}

export interface Decision {
  action: Action;
  source: DecisionSource;
  /** True when the user should look at this one (disagreement or degraded path). */
  flagged: boolean;
  audit: DecisionAudit;
}

export async function decide(
  facts: Facts,
  deps: DecideDeps,
  cfg: DecideConfig = DEFAULT_DECIDE_CONFIG,
  ctx?: DecideContext,
): Promise<Decision> {
  const now = deps.now ?? Date.now;
  const order = (deps.shuffle ?? fisherYates)(ACTION_IDS);
  const audit: DecisionAudit = { facts, order, jev: null, jevError: null, escalation: null, escalationError: null, jevMs: null, escalationMs: null };

  const t0 = now();
  try {
    audit.jev = await deps.jev(facts, order);
  } catch (e) {
    audit.jevError = msg(e);
  }
  audit.jevMs = now() - t0;

  const jev = audit.jev;
  if (jev && (jev.probabilities[jev.choice] ?? 0) >= cfg.acceptProbability && jev.confidence >= cfg.acceptConfidence) {
    return { action: jev.choice, source: 'jev', flagged: false, audit };
  }

  const t1 = now();
  try {
    audit.escalation = await deps.escalate(facts, jev, order);
  } catch (e) {
    audit.escalationError = msg(e);
  }
  audit.escalationMs = now() - t1;

  const esc = audit.escalation;
  if (!esc) return { action: 'hold', source: 'fallback_hold', flagged: true, audit };
  if (!jev) return { action: esc.action, source: 'claude_only', flagged: true, audit };
  if (esc.action === jev.choice) return { action: esc.action, source: 'claude_agrees', flagged: false, audit };
  return { action: lessRisky(esc.action, jev.choice, ctx), source: 'less_risky_of_two', flagged: true, audit };
}

// ------------------------------------------- layout 2: yes/no factors

/** One simple question per factor (keep them short: request size matters, see above). */
export const FACTOR_QUESTIONS = {
  hedgeNeeded: 'Is the hedge still needed (the thesis leg is not at risk)?',
  fundingMaterial: 'Is the funding cost of holding both legs material?',
  nearLiquidation: 'Is either leg close to liquidation?',
  inProfit: 'Is the combined position in profit beyond fees?',
  volatile: 'Is the market volatile enough to cut exposure?',
} as const;
export type FactorKey = keyof typeof FACTOR_QUESTIONS;
export const FACTOR_KEYS = Object.keys(FACTOR_QUESTIONS) as FactorKey[];

/** Probability of "yes" per factor. */
export type FactorProbs = Record<FactorKey, number>;
export type FactorBools = Record<FactorKey, boolean>;

/** The deterministic table: first matching row wins. */
export function actionFromFactors(f: FactorBools): Action {
  if (f.nearLiquidation) return f.volatile ? 'close_both' : 'reduce_hedge';
  if (!f.hedgeNeeded) return 'close_both';
  if (f.inProfit && !f.volatile) return 'take_profit';
  if (f.fundingMaterial && !f.inProfit) return 'reduce_hedge';
  if (f.volatile && !f.inProfit) return 'add_hedge';
  return 'hold';
}

export interface FactorGate {
  yesAtLeast: number;
  noAtMost: number;
}
export const DEFAULT_FACTOR_GATE: FactorGate = { yesAtLeast: 0.9, noAtMost: 0.1 };

/** true / false when decisive, null when undecided. */
export function gateFactors(p: FactorProbs, gate: FactorGate = DEFAULT_FACTOR_GATE): Record<FactorKey, boolean | null> {
  return Object.fromEntries(FACTOR_KEYS.map((k) => [k, p[k] >= gate.yesAtLeast ? true : p[k] <= gate.noAtMost ? false : null])) as Record<
    FactorKey,
    boolean | null
  >;
}

export interface FactorDeps {
  /** One request with all factor questions, asked in the given order. */
  ask(facts: Facts, order: FactorKey[]): Promise<FactorProbs>;
  /** Claude, given Jev's numbers (null when Jev failed) and the factors Jev could not decide. */
  escalate(facts: Facts, probs: FactorProbs | null, undecided: FactorKey[]): Promise<Escalation>;
  shuffle?(xs: FactorKey[]): FactorKey[];
}

export type FactorSource = 'jev_factors' | 'claude_for_undecided' | 'claude_only' | 'fallback_hold';

export interface FactorDecision {
  action: Action;
  source: FactorSource;
  flagged: boolean;
  probs: FactorProbs | null;
  undecided: FactorKey[];
  jevError: string | null;
  escalationError: string | null;
}

export async function decideByFactors(facts: Facts, deps: FactorDeps, gate: FactorGate = DEFAULT_FACTOR_GATE): Promise<FactorDecision> {
  const order = (deps.shuffle ?? fisherYates)(FACTOR_KEYS);
  let probs: FactorProbs | null = null;
  let jevError: string | null = null;
  try {
    probs = await deps.ask(facts, order);
  } catch (e) {
    jevError = msg(e);
  }

  const gated = probs ? gateFactors(probs, gate) : null;
  const undecided = gated ? FACTOR_KEYS.filter((k) => gated[k] === null) : [...FACTOR_KEYS];
  if (probs && gated && undecided.length === 0) {
    return { action: actionFromFactors(gated as FactorBools), source: 'jev_factors', flagged: false, probs, undecided, jevError, escalationError: null };
  }

  try {
    const esc = await deps.escalate(facts, probs, undecided);
    return { action: esc.action, source: probs ? 'claude_for_undecided' : 'claude_only', flagged: !probs, probs, undecided, jevError, escalationError: null };
  } catch (e) {
    return { action: 'hold', source: 'fallback_hold', flagged: true, probs, undecided, jevError, escalationError: msg(e) };
  }
}

// ------------------------------------------------------ proposeAction

/** Event names are fixed: web and contract code against them. */
export const DECISION_EVENTS = {
  proposed: 'decision.proposed',
  accepted: 'decision.accepted',
  rejected: 'decision.rejected',
} as const;

export const SONNET_MODEL = 'claude-sonnet-5-5';
export const OPUS_MODEL = 'claude-opus-5-5';
export const JEV_MODEL = 'jev-1.14.0';
/** Notional (long + short, USD) above which the first escalation goes to Opus. */
export const DEFAULT_ESCALATE_OPUS_NOTIONAL = 1000;

const COMPACT_KEYS: Record<string, string> = {
  hedgeCoverage: 'cover',
  longLegLiquidationDistance: 'longLiq',
  shortLegLiquidationDistance: 'shortLiq',
  combinedPnl: 'pnl',
  fundingOnHedge: 'funding',
  volatility: 'vol',
  trend: 'trend',
  hedgeAge: 'age',
  reserveMargin: 'reserve',
};

/** Same buckets, shorter keys and values (text before the colon): keeps Jev request bodies small (see top of file). */
export function compactFacts(facts: Facts): Facts {
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [COMPACT_KEYS[k] ?? k, v.split(':')[0]!]));
}

export interface OwnerState {
  /** Bucketed facts (see Facts). */
  facts: Facts;
}

export interface ProposeClients {
  /** Jev, one request with all factor questions in the given order. */
  ask(facts: Facts, order: FactorKey[]): Promise<FactorProbs>;
  /** Claude with structured output; `probs` is null when Jev failed. */
  escalate(model: string, facts: Facts, probs: FactorProbs | null, undecided: FactorKey[], ctx: DecideContext): Promise<Escalation>;
  shuffle?(xs: FactorKey[]): FactorKey[];
  now?(): number;
  newId?(): string;
}

export interface ProposeOptions {
  gate?: FactorGate;
  escalateOpusNotional?: number;
}

export type FactorDecidedBy = 'jev' | 'claude';

export interface Proposal {
  id: string;
  action: Action;
  /** jev: all factors decisive, table decided. claude: Claude decided (agreeing with the table or Jev was down).
   *  disagree: Claude and the table differ; the less risky of the two was taken. */
  source: 'jev' | 'claude' | 'disagree';
  factors: Record<FactorKey, { p: number | null; decidedBy: FactorDecidedBy }>;
  rationale: string;
  latencyMs: number;
  /** Model that produced the final action ('jev-1.14.0' when Jev decided alone). */
  model: string;
  /** True when a person should look twice (disagreement, Jev down, or a failed escalation). */
  flagged: boolean;
  error?: string;
  trace: { jevMs: number | null; calls: Array<{ model: string; ms: number }>; tableAction: Action | null };
}

/**
 * Pure proposal for the owner's decision feed (propose mode: nothing is executed here).
 * Jev answers the yes/no factors; decisive ones (p >= 0.90 or <= 0.10) stay with Jev. If any factor is
 * undecided, Claude gets the facts plus Jev's numbers: Sonnet, or Opus when the notional is above
 * `escalateOpusNotional`. If Sonnet's answer differs from the table's, Opus is asked as well and wins.
 * A remaining disagreement with the table takes the less risky action (state-derived ranking).
 */
export async function proposeAction(
  ownerState: OwnerState,
  ctx: DecideContext,
  clients: ProposeClients,
  opts: ProposeOptions = {},
): Promise<Proposal> {
  const now = clients.now ?? Date.now;
  const start = now();
  const gate = opts.gate ?? DEFAULT_FACTOR_GATE;
  const opusAbove = opts.escalateOpusNotional ?? DEFAULT_ESCALATE_OPUS_NOTIONAL;
  const order = (clients.shuffle ?? fisherYates)(FACTOR_KEYS);
  const trace: Proposal['trace'] = { jevMs: null, calls: [], tableAction: null };
  const id = (clients.newId ?? (() => crypto.randomUUID()))();

  let probs: FactorProbs | null = null;
  let error: string | undefined;
  const j0 = now();
  try {
    probs = await clients.ask(ownerState.facts, order);
  } catch (e) {
    error = `jev: ${msg(e)}`;
  }
  trace.jevMs = now() - j0;

  const gated = probs ? gateFactors(probs, gate) : null;
  const undecided = gated ? FACTOR_KEYS.filter((k) => gated[k] === null) : [...FACTOR_KEYS];
  const factors = Object.fromEntries(
    FACTOR_KEYS.map((k) => [k, { p: probs ? probs[k] : null, decidedBy: gated && gated[k] !== null ? 'jev' : 'claude' }]),
  ) as Proposal['factors'];
  if (probs) trace.tableAction = actionFromFactors(Object.fromEntries(FACTOR_KEYS.map((k) => [k, probs![k] >= 0.5])) as FactorBools);

  const done = (p: Omit<Proposal, 'id' | 'factors' | 'latencyMs' | 'trace'>): Proposal => ({
    id,
    factors,
    latencyMs: now() - start,
    trace,
    ...p,
  });

  if (probs && undecided.length === 0) {
    return done({ action: trace.tableAction!, source: 'jev', rationale: 'All factors decisive; action from the factor table.', model: JEV_MODEL, flagged: false });
  }

  const notional = ctx.longNotional + ctx.shortNotional;
  const ask = async (model: string): Promise<Escalation> => {
    const c0 = now();
    try {
      return await clients.escalate(model, ownerState.facts, probs, undecided, ctx);
    } finally {
      trace.calls.push({ model, ms: now() - c0 });
    }
  };

  let model = notional > opusAbove ? OPUS_MODEL : SONNET_MODEL;
  let esc: Escalation;
  try {
    esc = await ask(model);
    if (model === SONNET_MODEL && trace.tableAction && esc.action !== trace.tableAction) {
      model = OPUS_MODEL; // Sonnet disagrees with the table: Opus settles it
      esc = await ask(model);
    }
  } catch (e) {
    return done({ action: 'hold', source: 'claude', rationale: 'Escalation failed; holding.', model, flagged: true, error: [error, `claude: ${msg(e)}`].filter(Boolean).join('; ') });
  }

  const table = trace.tableAction;
  if (table && esc.action !== table) {
    return done({
      action: lessRisky(esc.action, table, ctx),
      source: 'disagree',
      rationale: `${esc.rationale} (Claude: ${esc.action}; factor table: ${table}; took the less risky.)`,
      model,
      flagged: true,
      error,
    });
  }
  return done({ action: esc.action, source: 'claude', rationale: esc.rationale, model, flagged: !probs, error });
}

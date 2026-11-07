/**
 * Strategy decision layer (propose mode only): pause / continue / adjust for a running strategy.
 * Same machinery and gate as decide.ts proposeAction: Jev answers yes/no factors in one request; factors that are
 * decisive (p >= 0.90 or p <= 0.10) stay with Jev and a small table maps them to an action; any undecided factor goes to
 * Claude (Sonnet, then Opus when Sonnet disagrees with the table). A remaining disagreement takes the safer action.
 * Nothing is executed here: the owner accepts a proposal through the existing /decision/:id/accept.
 * Pure: the Jev and Claude clients are injected.
 */
import type { Hex } from 'viem';
import { DEFAULT_FACTOR_GATE, JEV_MODEL, OPUS_MODEL, SONNET_MODEL, type FactorGate, type Facts } from '../decide.ts';

export const STRATEGY_ACTIONS = {
  continue_strategy: 'keep the strategy running',
  pause_strategy: 'pause it and cancel its resting orders',
  adjust_strategy: 'pause it so its range or size can be redrafted',
} as const;
export type StrategyAction = keyof typeof STRATEGY_ACTIONS;
export const STRATEGY_ACTION_IDS = Object.keys(STRATEGY_ACTIONS) as StrategyAction[];

/** Short questions: from ci32 a Jev request body past about 1.4 KB hangs (see jev.ts). */
export const STRATEGY_QUESTIONS = {
  nearLiquidation: 'Is the strategy account close to liquidation?',
  losing: 'Is the strategy losing money beyond its fees today?',
  budgetLow: 'Is most of the strategy top-up budget used?',
  offPlan: 'Is the price outside what the strategy was built for?',
  volatile: 'Is the market volatile enough to stop trading it?',
} as const;
export type StrategyFactorKey = keyof typeof STRATEGY_QUESTIONS;
export const STRATEGY_FACTOR_KEYS = Object.keys(STRATEGY_QUESTIONS) as StrategyFactorKey[];
export type StrategyProbs = Record<StrategyFactorKey, number>;
type Bools = Record<StrategyFactorKey, boolean>;

/** The deterministic table: first matching row wins. */
export function strategyActionFromFactors(f: Bools): StrategyAction {
  if (f.nearLiquidation) return 'pause_strategy';
  if (f.losing && f.budgetLow) return 'pause_strategy';
  if (f.offPlan) return 'adjust_strategy';
  if (f.volatile && f.losing) return 'adjust_strategy';
  return 'continue_strategy';
}

/** Lower = safer. Disagreements take the safer action; ties cannot happen between different actions. */
const SAFETY: Record<StrategyAction, number> = { pause_strategy: 0, adjust_strategy: 1, continue_strategy: 2 };
export const saferOf = (a: StrategyAction, b: StrategyAction) => (SAFETY[a] <= SAFETY[b] ? a : b);

export interface StrategyInput {
  owner: Hex;
  strategyId: string;
  coin: string;
  leg: number;
  /** Bucketed facts only (strings), like decide.ts Facts. */
  facts: Facts;
}

export interface StrategyClients {
  ask(facts: Facts, order: StrategyFactorKey[]): Promise<StrategyProbs>;
  escalate(model: string, facts: Facts, probs: StrategyProbs | null, undecided: StrategyFactorKey[]): Promise<{ action: StrategyAction; rationale: string }>;
  shuffle?(xs: StrategyFactorKey[]): StrategyFactorKey[];
  now?(): number;
  newId?(): string;
}

export interface StrategyProposal {
  id: string;
  kind: 'strategy';
  strategyId: string;
  action: StrategyAction;
  /** jev: all factors decisive. claude: Claude decided. disagree: Claude and the table differ; the safer was taken. */
  source: 'jev' | 'claude' | 'disagree';
  factors: Record<StrategyFactorKey, { p: number | null; decidedBy: 'jev' | 'claude' }>;
  rationale: string;
  latencyMs: number;
  model: string;
  flagged: boolean;
  error?: string;
  trace: { jevMs: number | null; calls: Array<{ model: string; ms: number }>; tableAction: StrategyAction | null };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function shuffled<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function proposeStrategyAction(input: StrategyInput, clients: StrategyClients, gate: FactorGate = DEFAULT_FACTOR_GATE): Promise<StrategyProposal> {
  const now = clients.now ?? Date.now;
  const start = now();
  const order = (clients.shuffle ?? shuffled)(STRATEGY_FACTOR_KEYS);
  const trace: StrategyProposal['trace'] = { jevMs: null, calls: [], tableAction: null };
  const id = (clients.newId ?? (() => crypto.randomUUID()))();

  let probs: StrategyProbs | null = null;
  let error: string | undefined;
  const j0 = now();
  try {
    probs = await clients.ask(input.facts, order);
  } catch (e) {
    error = `jev: ${msg(e)}`;
  }
  trace.jevMs = now() - j0;

  const decisive = (k: StrategyFactorKey) => probs !== null && (probs[k] >= gate.yesAtLeast || probs[k] <= gate.noAtMost);
  const undecided = STRATEGY_FACTOR_KEYS.filter((k) => !decisive(k));
  const factors = Object.fromEntries(STRATEGY_FACTOR_KEYS.map((k) => [k, { p: probs ? probs[k] : null, decidedBy: decisive(k) ? 'jev' : 'claude' }])) as StrategyProposal['factors'];
  if (probs) trace.tableAction = strategyActionFromFactors(Object.fromEntries(STRATEGY_FACTOR_KEYS.map((k) => [k, probs![k] >= 0.5])) as Bools);

  const done = (p: Pick<StrategyProposal, 'action' | 'source' | 'rationale' | 'model' | 'flagged'> & { error?: string }): StrategyProposal => ({
    id, kind: 'strategy', strategyId: input.strategyId, factors, latencyMs: now() - start, trace, ...p,
  });

  if (probs && undecided.length === 0) {
    return done({ action: trace.tableAction!, source: 'jev', rationale: 'All factors decisive; action from the factor table.', model: JEV_MODEL, flagged: false });
  }

  const ask = async (model: string) => {
    const c0 = now();
    try {
      return await clients.escalate(model, input.facts, probs, undecided);
    } finally {
      trace.calls.push({ model, ms: now() - c0 });
    }
  };
  let model = SONNET_MODEL;
  let esc: { action: StrategyAction; rationale: string };
  try {
    esc = await ask(model);
    if (trace.tableAction && esc.action !== trace.tableAction) {
      model = OPUS_MODEL; // Sonnet disagrees with the table: Opus settles it
      esc = await ask(model);
    }
  } catch (e) {
    // fail safe = do nothing new: the margin guard and the strategy's own limits stay in force
    return done({ action: 'continue_strategy', source: 'claude', rationale: 'Escalation failed; no change proposed.', model, flagged: true, error: [error, `claude: ${msg(e)}`].filter(Boolean).join('; ') });
  }
  const table = trace.tableAction;
  if (table && esc.action !== table) {
    return done({ action: saferOf(esc.action, table), source: 'disagree', rationale: `${esc.rationale} (Claude: ${esc.action}; factor table: ${table}; took the safer.)`, model, flagged: true, error });
  }
  return done({ action: esc.action, source: 'claude', rationale: esc.rationale, model, flagged: !probs, error });
}


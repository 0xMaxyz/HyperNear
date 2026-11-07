/**
 * Decision layer (plan item 5): Jev first, Claude when Jev is not sure.
 *
 *  1. Ask Jev one `choice` question with the options in a shuffled order (Jev prefers the first one listed).
 *  2. Accept its answer when probabilities[choice] >= acceptProbability AND confidence >= acceptConfidence.
 *  3. Otherwise escalate to Claude with the same facts plus Jev's distribution.
 *     Same top action: act. Different: take the LESS risky of the two and flag it for the user.
 *  4. If Jev is unreachable, Claude decides alone (flagged). If both fail, hold (flagged): the margin guard and
 *     the contract policy stay in force, this layer never gates them.
 *
 * Pure: the Jev and Claude clients are injected, so it runs offline against fixtures and in --dry-run replays.
 * `facts` must only hold computed, bucketed strings (no raw numbers, no free text): Jev trusts its state.
 */

// Keep these short (<= 40 chars). Over ci32, Jev requests whose JSON body grows past roughly 1.4 KB hang (measured:
// 5 descriptions of 45 chars work, 50 chars time out), and the plan wants short option descriptions anyway.
export const ACTIONS = {
  hold: 'keep both legs as they are',
  close_both: 'close both legs now',
  reduce_hedge: 'shrink the short leg',
  add_hedge: 'grow the short leg',
  take_profit: 'close the leg in profit, keep other',
} as const;
export type Action = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as Action[];

/**
 * Lower = less risky. Assumption for review: flat beats unchanged, which beats anything that leaves a
 * directional leg (take_profit, reduce_hedge), which beats opening new exposure (add_hedge).
 */
export const RISK_RANK: Record<Action, number> = { close_both: 0, hold: 1, take_profit: 2, reduce_hedge: 3, add_hedge: 4 };

export type Facts = Record<string, string>;

export interface JevAnswer {
  choice: Action;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface Escalation {
  action: Action;
  rationale: string;
}

export interface DecideDeps {
  /** Asks Jev; `order` is the option order to present. */
  jev(facts: Facts, order: Action[]): Promise<JevAnswer>;
  /** Asks Claude (structured output); `jev` is null when Jev failed. */
  escalate(facts: Facts, jev: JevAnswer | null, order: Action[]): Promise<Escalation>;
  /** Option shuffle; injectable for reproducible tests. */
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

function fisherYates(xs: Action[]): Action[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function decide(facts: Facts, deps: DecideDeps, cfg: DecideConfig = DEFAULT_DECIDE_CONFIG): Promise<Decision> {
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
  const safer = RISK_RANK[esc.action] <= RISK_RANK[jev.choice] ? esc.action : jev.choice;
  return { action: safer, source: 'less_risky_of_two', flagged: true, audit };
}

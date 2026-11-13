// Which agent suggestions are still waiting for the owner. Pure (no env, no DOM) so it is unit-tested with the agent suite.
import type { Hex } from 'viem';

/** decision.proposed payload (agent/src/decisions.ts proposalEvent), flat. */
export interface Decision {
  id: string;
  owner: Hex;
  coin: string;
  action: string;
  /** jev: Jev decided alone. claude: Claude decided. disagree: they differed, the less risky action was taken. */
  source: 'jev' | 'claude' | 'disagree' | string;
  flagged: boolean;
  /** probability of "yes" per factor question, and who settled it */
  factors: Record<string, { p: number | null; decidedBy: 'jev' | 'claude' }>;
  rationale: string;
  latencyMs: number;
  model: string;
  error?: string;
  recorded?: boolean;
  /** when the agent made it (ms) and until when it can be accepted */
  at?: number;
  expiresAt?: number;
  /** every action the owner may choose, least to most exposure (hedge proposals) */
  options?: DecisionOption[];
  kind?: 'strategy';
  strategyId?: string;
}

export interface DecisionOption {
  action: string;
  risk: 'safest' | 'safer' | 'none' | 'riskier' | 'riskiest';
  exposure: number;
  text: string;
}

/** the part of an agent event this module reads */
export interface AgentEventLike {
  id: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}
/** /owner's `decision` block */
export interface OwnerDecision {
  mode: string;
  latest: (Decision & { status: 'open' | 'accepted' | 'rejected' | 'expired'; at: number }) | null;
}

const asDecision = (e: AgentEventLike) => ((e.data as Partial<Decision>).id !== undefined ? (e.data as unknown as Decision) : undefined);

export type DecisionState = 'open' | 'accepted' | 'declined' | 'expired' | 'replaced' | 'dismissed';
export interface DecisionRow {
  d: Decision;
  at: number;
  state: DecisionState;
}

/**
 * Every proposal the page knows (agent events, newest first, plus /owner's latest), with what became of it. Only the NEWEST proposal of its kind
 * (the hedge, or one strategy) can be open: older ones are `replaced`, so dismissing or accepting the current one never brings an old one back.
 * `dismissed` holds the ids the owner hid with "Not now".
 */
export function decisionRows(events: AgentEventLike[], dismissed: Set<string>, fromView?: OwnerDecision, now = Date.now()): DecisionRow[] {
  const accepted = new Set(events.filter((e) => e.type === 'decision.accepted').map((e) => String(e.data.id)));
  const declined = new Set(events.filter((e) => e.type === 'decision.rejected').map((e) => String(e.data.id)));
  const all = new Map<string, { d: Decision; at: number }>();
  for (const e of events) {
    const d = e.type === 'decision.proposed' ? asDecision(e) : undefined;
    if (d && !all.has(d.id)) all.set(d.id, { d, at: d.at ?? e.at });
  }
  const l = fromView?.latest;
  if (l && !all.has(l.id)) all.set(l.id, { d: l, at: l.at });
  const rows = [...all.values()].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  return rows.map(({ d, at }) => {
    const group = d.kind === 'strategy' ? `strategy:${d.strategyId}` : 'hedge';
    const newest = !seen.has(group);
    seen.add(group);
    const viewStatus = l && l.id === d.id ? l.status : undefined;
    const state: DecisionState =
      accepted.has(d.id) || viewStatus === 'accepted' ? 'accepted'
      : declined.has(d.id) || viewStatus === 'rejected' ? 'declined'
      : viewStatus === 'expired' || (d.expiresAt !== undefined && now > d.expiresAt) ? 'expired'
      : !newest ? 'replaced'
      : dismissed.has(d.id) ? 'dismissed'
      : 'open';
    return { d, at, state };
  });
}

/** The newest decision still waiting for the owner, if any. */
export function pendingDecision(events: AgentEventLike[], dismissed: Set<string>, fromView?: OwnerDecision, now = Date.now()): Decision | undefined {
  return decisionRows(events, dismissed, fromView, now).find((r) => r.state === 'open')?.d;
}

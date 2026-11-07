import type { Hex } from 'viem';
import type { ChainTag } from '@hypernear/client';

export const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? 'http://localhost:8787';
export const CONTRACT_ID = (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? 'leash-spike-1107.testnet';
export const CHAIN_TAG = ((import.meta.env.VITE_CHAIN_TAG as string | undefined) ?? 'near-testnet') as ChainTag;
export const AGENT_ACCOUNT = (import.meta.env.VITE_AGENT_ACCOUNT as string | undefined) ?? 'agent.leash-spike-1107.testnet';
/** Read-only demo owner: the dry-run agent serves the same fixtures for any address. */
export const DEMO_OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;

export interface Position {
  coin: string;
  szi: string;
  entryPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
}
export interface LegSnap {
  leg: number;
  address: Hex;
  agent: { address: Hex; name: string; approvedAt?: number | null } | null;
  clearinghouse: { marginSummary: { accountValue: string }; withdrawable: string; assetPositions: { position: Position }[] };
  spotUsdc: number;
}
export interface OwnerPolicy {
  nonce: number;
  frozen: boolean;
  agent: string | null;
  daily_cap: number; // micro-USDC (contract parse_usd)
  cooldown_sec: number;
  spent_today: number;
}
export interface GuardRow {
  id: string;
  trigger: boolean;
  reasons: string[];
  distance: number | null;
  plausibleMove: number;
}
export interface OwnerView {
  dryRun?: boolean;
  owner: Hex;
  /** `agent: null` with `needsPrepare`: no key yet, the owner signs a prepareAgents command first */
  legs?: { leg: number; address: Hex; agent: { address: Hex; name: string; approvedAt: number | null } | null; needsPrepare?: boolean }[];
  snapshot: { at: number; legs: LegSnap[]; market: { mids: Record<string, string> } };
  policy: OwnerPolicy | null;
  orderPolicy: { maxLeverage: number; maxNotionalUsd: number; allowedCoins: string[]; slippage: number };
  guard: GuardRow[];
  breakeven?: unknown;
  config?: { contractId: string; chainTag: ChainTag; agentAccount: string | null; hlNetwork: 'testnet' | 'mainnet' };
  /** the exact approveAgent intents to sign, one per leg whose key Hyperliquid has not approved */
  pendingApprovals?: PendingApproval[];
  decision?: { mode: DecisionMode; latest: (Decision & { status: 'open' | 'accepted' | 'rejected' | 'expired'; at: number }) | null };
}
export interface AgentEvent {
  id: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}

export class ApiError extends Error {}

async function json(r: Response) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as Record<string, unknown>;
}

export async function getOwner(owner: Hex, signal?: AbortSignal): Promise<OwnerView> {
  try {
    return (await json(await fetch(`${AGENT_URL}/owner/${owner}`, { signal: signal ?? AbortSignal.timeout(8000) }))) as unknown as OwnerView;
  } catch (e) {
    if (e instanceof ApiError || (e as Error).name === 'AbortError') throw e;
    throw new ApiError(`Cannot reach the agent at ${AGENT_URL}. Is it running, and is VITE_AGENT_URL right?`);
  }
}

export async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  try {
    return await json(await fetch(`${AGENT_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Cannot reach the agent at ${AGENT_URL}.`);
  }
}

/** SSE over fetch, because the agent names its events (`event: guard.trigger`) and EventSource has no wildcard. */
export function streamEvents(onEvent: (e: AgentEvent) => void, onState: (s: 'live' | 'down') => void): () => void {
  const ctl = new AbortController();
  let lastId = 0;
  (async () => {
    while (!ctl.signal.aborted) {
      try {
        const r = await fetch(`${AGENT_URL}/events`, { signal: ctl.signal, headers: lastId ? { 'last-event-id': String(lastId) } : {} });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        onState('live');
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const e = JSON.parse(data.slice(6)) as AgentEvent;
            lastId = Math.max(lastId, e.id);
            onEvent(e);
          }
        }
      } catch {
        if (ctl.signal.aborted) return;
      }
      onState('down');
      await new Promise((res) => setTimeout(res, 3000));
    }
  })();
  return () => ctl.abort();
}

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
}

export interface PendingApproval {
  type: 'approveAgent';
  leg: number;
  agent: Hex;
  agentName: string;
  hlNonce: number;
}

export type DecisionMode = 'off' | 'propose' | 'auto';

const asDecision = (e: AgentEvent) => (e.data as Partial<Decision>).id !== undefined ? (e.data as unknown as Decision) : undefined;
export const decisionOf = asDecision;

/** The newest proposal (events are newest first) that no accepted or rejected event has closed; else /owner's open latest. */
export function pendingDecision(events: AgentEvent[], dismissed: Set<string>, fromView?: OwnerView['decision']): Decision | undefined {
  const closed = new Set(events.filter((e) => e.type === 'decision.accepted' || e.type === 'decision.rejected').map((e) => String(e.data.id)));
  for (const e of events) {
    const d = e.type === 'decision.proposed' ? asDecision(e) : undefined;
    if (d && !closed.has(d.id) && !dismissed.has(d.id)) return d;
  }
  const l = fromView?.latest;
  return l && l.status === 'open' && !closed.has(l.id) && !dismissed.has(l.id) ? l : undefined;
}

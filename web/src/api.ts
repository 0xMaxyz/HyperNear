import type { Hex } from 'viem';
import { specHashOfJson, type ChainTag } from '@hypernear/client';

export const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? 'http://localhost:8787';
export const CONTRACT_ID = (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? 'leash-spike-1107.testnet';
export const CHAIN_TAG = ((import.meta.env.VITE_CHAIN_TAG as string | undefined) ?? 'near-testnet') as ChainTag;
export const AGENT_ACCOUNT = (import.meta.env.VITE_AGENT_ACCOUNT as string | undefined) ?? 'agent.leash-spike-1107.testnet';
/** The owner's own TEE agent (optional TEE mode). Unset: the TEE mode cannot be set up from this page. */
export const TEE_AGENT_URL = (import.meta.env.VITE_TEE_AGENT_URL as string | undefined) || undefined;
/** Which agent the owner API calls go to: the server agent, or the TEE agent once the owner is in TEE mode. */
let agentBase = AGENT_URL;
export const pointAgentAt = (tee: boolean) => { agentBase = tee && TEE_AGENT_URL ? TEE_AGENT_URL : AGENT_URL; };
/** the agent the owner calls go to right now (a 1-click session lives on one agent only) */
export const currentAgent = () => agentBase;
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
/** Hyperliquid's 1 USDC new-account fee: paid, owed on the first credit (never-seen account) or owed on the first transfer out (agent/src/activation.ts) */
export type Activation = 'paid' | 'owed-on-credit' | 'owed-on-first-send';
export interface LegSnap {
  leg: number;
  address: Hex;
  agent: { address: Hex; name: string; approvedAt?: number | null } | null;
  clearinghouse: { marginSummary: { accountValue: string; totalMarginUsed?: string }; crossMaintenanceMarginUsed?: string; withdrawable: string; assetPositions: { position: Position }[] };
  spotUsdc: number;
  activation: Activation;
  /** Hyperliquid account mode. On a unified leg `clearinghouse.marginSummary.accountValue` is the spot USDC total, `withdrawable` is total minus hold and `spotUsdc` is 0 (agent/src/funds.ts) */
  abstraction?: 'default' | 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'dexAbstraction' | 'unknown';
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
  snapshot: { at: number; legs: LegSnap[]; market: { mids: Record<string, string>; assets?: { name: string; asset: number; szDecimals: number; maxLeverage: number }[] } };
  policy: OwnerPolicy | null;
  orderPolicy: { maxLeverage: number; maxNotionalUsd: number; allowedCoins: string[]; slippage: number };
  guard: GuardRow[];
  config?: { contractId: string; chainTag: ChainTag; agentAccount: string | null; hlNetwork: 'testnet' | 'mainnet'; teeFeeActivation?: Activation | null };
  /** the exact approveAgent intents to sign, one per leg whose key Hyperliquid has not approved */
  pendingApprovals?: PendingApproval[];
  /** live 1-click trading sessions on this agent (public data; the keys stay in the browser that made them) */
  sessions?: { key: Hex; startedAt: number; expiresAt: number; actions: string[]; maxNotionalUsd?: number; maxLeverage?: number; coins?: string[] }[];
  decision?: { mode: DecisionMode; latest: (Decision & { status: 'open' | 'accepted' | 'rejected' | 'expired'; at: number }) | null };
}
export interface AgentEvent {
  id: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  /** the parsed JSON body of the failed response (a refused draft carries its errors there) */
  readonly body: Record<string, unknown>;
  constructor(message: string, status = 0, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function json(r: Response) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${r.status}`, r.status, body as Record<string, unknown>);
  return body as Record<string, unknown>;
}

export async function getOwner(owner: Hex, signal?: AbortSignal): Promise<OwnerView> {
  try {
    return (await json(await fetch(`${agentBase}/owner/${owner}`, { signal: signal ?? AbortSignal.timeout(8000) }))) as unknown as OwnerView;
  } catch (e) {
    if (e instanceof ApiError || (e as Error).name === 'AbortError') throw e;
    throw new ApiError(`Cannot reach the agent at ${agentBase}. Is it running, and is ${agentBase === AGENT_URL ? 'VITE_AGENT_URL' : 'VITE_TEE_AGENT_URL'} right?`);
  }
}

/** `base` overrides the agent: setTee and payTee always go through the server agent, which stays up when a TEE agent is gone. */
export async function post(path: string, body: unknown, base = agentBase): Promise<Record<string, unknown>> {
  try {
    return await json(await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Cannot reach the agent at ${base}.`);
  }
}

/** SSE over fetch, because the agent names its events (`event: guard.trigger`) and EventSource has no wildcard. */
/** `idOffset` keeps the ids of a second agent's bus apart from the first one's (each bus counts from 1). */
export function streamEvents(onEvent: (e: AgentEvent) => void, onState: (s: 'live' | 'down') => void, base = AGENT_URL, idOffset = 0): () => void {
  const ctl = new AbortController();
  let lastId = 0;
  (async () => {
    while (!ctl.signal.aborted) {
      try {
        const r = await fetch(`${base}/events`, { signal: ctl.signal, headers: lastId ? { 'last-event-id': String(lastId) } : {} });
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
            onEvent({ ...e, id: e.id + idOffset });
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

export type { Decision, DecisionOption } from './decisions';
import type { Decision } from './decisions';

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

export async function getJson<T>(path: string): Promise<T> {
  try {
    return (await json(await fetch(`${agentBase}${path}`, { signal: AbortSignal.timeout(8000) }))) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Cannot reach the agent at ${agentBase}.`);
  }
}

// ---- strategies (agent/src/strategy/*)
export interface StrategySpec {
  id: string;
  type: 'grid' | 'twap';
  leg: number;
  coin: string;
  params: Record<string, number | string>;
  limits: { maxNotional: number; maxLeverage: number; maxDailyLoss: number; topUpCapPerDay: number };
  onStop: 'cancel' | 'flatten';
}
export interface SpecChange {
  path: string;
  from: unknown;
  to: unknown;
}
/** POST /strategy/draft {owner, text}: the model only drafts; the agent validated every number. */
export interface DraftOk {
  spec: StrategySpec;
  specHash: string;
  diff: { against: string; changes: SpecChange[] };
  warnings: string[];
}
export interface DraftRefused {
  ok: false;
  errors: string[];
  /** what the model proposed, unvalidated */
  draft?: unknown;
}
export interface StrategyStatus {
  id: string;
  type: 'grid' | 'twap';
  leg: number;
  coin: string;
  state: string;
  deadman?: string;
  held?: unknown;
  resting?: number;
  twap?: { done: number; skipped: number; filledSize?: string };
  /** the stored spec: what a resume signs the hash of */
  spec?: StrategySpec;
}

/** GET /strategy/library: every template instantiated for one coin and leg at the current price (agent/src/strategy/library.ts). */
export interface LibraryItem {
  id: string;
  title: string;
  blurb: string;
  risk: string;
  type: 'grid' | 'twap';
  spec: StrategySpec;
  specHash: string;
}
export interface LibraryListing {
  coin: string;
  coins: string[];
  mid: number;
  leg: number;
  freeLegs: number[];
  items: LibraryItem[];
}

export { canonicalJson } from '@hypernear/client';

/** sha256 of the canonical JSON, as 0x + 64 hex: the specHash the owner signs (shared with the agent through @hypernear/client). */
export async function specHashOf(spec: unknown): Promise<Hex> {
  return specHashOfJson(spec);
}

/** orders.swept (agent/src/sweep.ts sweptEvent): the clean-up after a relayed freeze, contract-signed Hyperliquid cancels. */
export interface SweepLeg {
  leg: number;
  address: Hex;
  found: number;
  skipped: number;
  cancelled: number;
  txHashes: string[];
  /** one entry per batch: 'ok', 'err: ...' or 'post failed: ...' */
  hl: string[];
  error?: string;
}
export interface Swept {
  owner: Hex;
  trigger: 'freeze';
  legs: SweepLeg[];
  cancelled: number;
  ms: number;
  /** with legs: [] the whole sweep failed */
  error?: string;
}
/** Problems of a sweep, in plain words; empty when every batch was posted ok and no leg failed. */
export function sweepProblems(w: Swept): string[] {
  if (w.error) return [w.error];
  return w.legs.flatMap((l) => [...(l.error ? [`leg ${l.leg}: ${l.error}`] : []), ...l.hl.filter((h) => h !== 'ok').map((h) => `leg ${l.leg}: ${h}`)]);
}

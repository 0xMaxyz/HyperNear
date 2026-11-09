// Optional TEE mode, read side: the contract's get_config / get_tee / get_tee_agent. The agent does not proxy them, so the page
// asks a NEAR RPC node directly (views are public). In --dry-run there is no contract: a small in-page fixture plays both modes.
import type { Hex } from 'viem';
import type { ChainTag, OwnerIntent } from '@hypernear/client';

/** get_tee (packages/hypernear-client TeeInfo; the browser entry does not export the client's types). */
export interface TeeInfo {
  /** null after leaving TEE mode (the entry stays to keep the paid time) */
  measurement_hash: string | null;
  agent_account: string | null;
  /** u64 on the contract: a JSON number over RPC, a string in the fixture; BigInt() takes both */
  paid_until_ns: string | number;
  months_paid: number;
  keys: Record<string, Hex>;
}
/** get_tee_agent */
export interface TeeAgentInfo {
  measurement_hash: string;
  expires_ns: string | number;
}

export interface TeeState {
  /** USD per month and where payTee sends it; null when the contract does not offer TEE mode */
  priceUsd: string | null;
  feeAddress: Hex | null;
  tee: TeeInfo | null;
  /** the owner's TEE agent account as the contract knows it (null: not registered) */
  agent: TeeAgentInfo | null;
}
export interface TeeCtx {
  dryRun: boolean;
  chainTag: ChainTag;
  contractId: string;
}

export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DAY_NS = 86_400_000_000_000n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;

/** "In TEE mode" is a set measurement: a left TEE mode keeps its entry (the paid time) with a null hash. */
export const inTeeMode = (s?: TeeState | null) => s?.tee?.measurement_hash != null;
export const nsToDate = (ns: string | number) => new Date(Number(BigInt(ns) / 1_000_000n));
/** Per month, in micro-USD, exactly as payTee must carry it (the contract refuses any other). */
export const priceMicro = (usd: string) => Math.round(Number(usd) * 1e6);
export const usd = (micro: number) => `$${(micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
/** The run mode is a testnet one: nothing there is attested by hardware, so it is never called "verified". */
export const isDevRun = (chainTag: ChainTag) => chainTag !== 'near-mainnet';

// --- dry-run fixture: server mode first, TEE mode after a (simulated) setTee, back after leaving ---
export const DRY_TEE_ACCOUNT = 'leash-tee-1.hypernear-dry-run.testnet';
const DRY_MEASUREMENT = `0x${'5e'.repeat(8)}${'a7'.repeat(8)}${'0c'.repeat(8)}${'d4'.repeat(8)}`;
const dryFee = '0x7b1e0a5f3c2d4e6f8091a2b3c4d5e6f708192a3b' as Hex;
const dry: { tee: TeeInfo | null } = { tee: null };
const dryAgent = (account: string): TeeAgentInfo | null => (account === DRY_TEE_ACCOUNT ? { measurement_hash: DRY_MEASUREMENT, expires_ns: String(nowNs() + 6n * DAY_NS) } : null);

/** After a relayed setTee / payTee the dry-run agent only simulates, so the fixture applies the intent itself. */
export function dryApply(intent: OwnerIntent) {
  if (intent.type === 'setTee') {
    const left = /^0x0+$/.test(intent.measurementHash);
    dry.tee = { measurement_hash: left ? null : intent.measurementHash, agent_account: left ? null : intent.agentAccount, paid_until_ns: dry.tee?.paid_until_ns ?? '0', months_paid: dry.tee?.months_paid ?? 0, keys: {} };
  } else if (intent.type === 'payTee' && dry.tee) {
    const from = BigInt(dry.tee.paid_until_ns) > nowNs() ? BigInt(dry.tee.paid_until_ns) : nowNs();
    dry.tee = { ...dry.tee, months_paid: dry.tee.months_paid + intent.months, paid_until_ns: String(from + BigInt(intent.months) * 30n * DAY_NS) };
  }
}

const rpcUrl = (c: TeeCtx) => (import.meta.env.VITE_NEAR_RPC as string | undefined) ?? (c.chainTag === 'near-mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com');

async function view<T>(c: TeeCtx, method: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(rpcUrl(c), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: c.contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await r.json()) as { error?: { data?: unknown; message?: string }; result?: { error?: string; result: number[] } };
  const err = j.result?.error ?? j.error?.message;
  if (err) throw new Error(`${method}: ${String(err).slice(0, 160)}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result!.result))) as T;
}

/** get_tee_agent: the contract's record of a TEE agent account, or null when it is not registered. */
export async function lookupTeeAgent(account: string, c: TeeCtx): Promise<TeeAgentInfo | null> {
  if (c.dryRun) return dryAgent(account);
  return view<TeeAgentInfo | null>(c, 'get_tee_agent', { account_id: account });
}

export async function loadTee(owner: Hex, c: TeeCtx): Promise<TeeState> {
  if (c.dryRun) return { priceUsd: '2.00', feeAddress: dryFee, tee: dry.tee, agent: dry.tee?.agent_account ? dryAgent(dry.tee.agent_account) : null };
  const cfg = await view<{ tee_price_usd?: string | number | null; tee_fee_address?: Hex | null }>(c, 'get_config', {});
  // a contract that predates TEE mode has no get_tee: the owner is simply not in TEE mode
  const tee = await view<TeeInfo | null>(c, 'get_tee', { owner: owner.toLowerCase() }).catch((e: Error) => {
    if (/MethodNotFound|not found|no such method/i.test(e.message)) return null;
    throw e;
  });
  return {
    priceUsd: cfg.tee_price_usd ? String(cfg.tee_price_usd) : null,
    feeAddress: cfg.tee_fee_address ?? null,
    tee,
    agent: tee?.agent_account ? await lookupTeeAgent(tee.agent_account, c).catch(() => null) : null,
  };
}

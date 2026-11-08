// TEE mode (docs: plan "optional TEE mode"). Two run modes share one codebase:
//   server: serves every owner who has NOT opted in to TEE (contract get_tee is null)
//   tee:    serves only owners whose get_tee names this image's measurement, who have paid, and whose fee is in HL's ledger
// OwnerScope is the one place that decides; the guard loop, decisions, strategies and /agents/prepare all ask it.
import type { Hex } from 'viem';
import type { HlClient } from '@perps-platform/core';
import { exchangeBody, nearApiBackend, type HyperNearClient, type NearBackend, type TeeAttestation, type TeeMeasurements } from '@hypernear/client';
import type { HlPoster } from './relayer.ts';
import type { Legs } from './legs.ts';

export type RunMode = 'server' | 'tee';

/** Has the TEE fee reached the fee address? Behind a port so tests can mock the ledger. */
export interface TeeLedgerPort {
  feePaid(a: { legAddresses: Hex[]; feeAddress: string; minUsd: number }): Promise<boolean>;
}

/**
 * Reads HL's userNonFundingLedgerUpdates of the owner's legs and adds up usdSends (ledger type internalTransfer, or a
 * `send`) to the fee address. shortcut: the sum must reach one month's price, not months x price (the contract holds
 * paid_until); tighten when the contract exposes the amount paid.
 */
export function hlLedgerPort(hl: Pick<HlClient, 'userNonFundingLedgerUpdates'>): TeeLedgerPort {
  return {
    async feePaid({ legAddresses, feeAddress, minUsd }) {
      const fee = feeAddress.toLowerCase();
      let sum = 0;
      for (const user of legAddresses) {
        for (const u of await hl.userNonFundingLedgerUpdates({ user, startTime: 0 })) {
          const d = u.delta as Record<string, unknown>;
          if (typeof d.destination !== 'string' || d.destination.toLowerCase() !== fee) continue;
          if (d.type === 'internalTransfer') sum += Number(d.usdc ?? 0);
          else if (d.type === 'send') sum += Number(d.usdcValue ?? d.amount ?? 0);
        }
      }
      return sum >= minUsd;
    },
  };
}

export interface ScopeDeps {
  mode: RunMode;
  client: Pick<HyperNearClient, 'getTee' | 'getConfig'>;
  /** tee mode: legs' addresses of an owner, and the ledger check */
  legAddresses?: (owner: Hex) => Promise<Hex[]>;
  ledger?: TeeLedgerPort;
  /** tee mode: the measurement hash this process runs as (known after boot); undefined = serve nobody */
  measurement?: () => string | undefined;
  ttlMs?: number;
  now?: () => number;
}

/** Which owners this process serves. Cached per owner (default 60 s); a lookup error is never cached and never serves. */
export class OwnerScope {
  readonly mode: RunMode;
  readonly #d: ScopeDeps;
  readonly #cache = new Map<string, { at: number; ok: boolean }>();
  constructor(d: ScopeDeps) {
    this.#d = d;
    this.mode = d.mode;
  }

  /** Throws when the contract (or HL) cannot be read: callers decide whether unknown means skip or keep. */
  async serves(owner: Hex): Promise<boolean> {
    const now = (this.#d.now ?? Date.now)();
    const hit = this.#cache.get(owner);
    if (hit && now - hit.at < (this.#d.ttlMs ?? 60_000)) return hit.ok;
    const ok = await this.#decide(owner, now);
    this.#cache.set(owner, { at: now, ok });
    return ok;
  }

  async #decide(owner: Hex, now: number): Promise<boolean> {
    const tee = await this.#d.client.getTee(owner);
    if (this.mode === 'server') return tee === null;
    if (!tee) return false;
    const own = this.#d.measurement?.();
    if (!own || tee.measurement_hash.toLowerCase() !== own.toLowerCase()) return false;
    if (BigInt(tee.paid_until_ns) <= BigInt(now) * 1_000_000n) return false;
    const cfg = await this.#d.client.getConfig();
    if (!cfg.tee_fee_address || !this.#d.ledger || !this.#d.legAddresses) return false;
    return this.#d.ledger.feePaid({ legAddresses: await this.#d.legAddresses(owner), feeAddress: cfg.tee_fee_address, minUsd: Number(cfg.tee_price_usd ?? 0) });
  }

  /** The owners this process serves now; one whose lookup fails is left out this round (fail closed, retried next time). */
  async filter(owners: Hex[]): Promise<Hex[]> {
    const ok = await Promise.all(owners.map((o) => this.serves(o).catch(() => false)));
    return owners.filter((_, i) => ok[i]);
  }

  /** For running work (strategies): false only on a definite "not served"; an unreadable contract keeps it running. */
  stillServes(owner: Hex): Promise<boolean> {
    return this.serves(owner).catch(() => true);
  }
}

/** A NearBackend whose calls are signed by the TEE agent's own account (shade-agent-js); views go straight to the RPC. */
export function shadeBackend(shade: { call: (p: { methodName: string; args: Record<string, unknown>; deposit?: bigint; gas?: bigint; waitUntil?: 'EXECUTED_OPTIMISTIC' }) => Promise<unknown> }, contractId: string, rpcUrl: string): NearBackend {
  const view = nearApiBackend({ rpcUrl }).view;
  return {
    view,
    async call<T>(cid: string, method: string, args: Record<string, unknown>, o: { deposit?: bigint; gasTgas?: number } = {}) {
      if (cid !== contractId) throw new Error(`the TEE agent account only calls ${contractId}, not ${cid}`);
      const value = (await shade.call({ methodName: method, args, deposit: o.deposit, gas: BigInt(o.gasTgas ?? 100) * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' })) as T;
      return { txHash: '', value };
    },
  };
}

interface TcbInfoLike {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  event_log?: { event: string; digest: string; event_payload: string }[];
}

/** FullMeasurements out of the attestation's tcb_info (a fake/dev attestation has no events: zero-filled). */
export function measurementsFrom(t: TcbInfoLike): TeeMeasurements {
  const ev = (name: string) => t.event_log?.find((e) => e.event === name);
  return {
    rtmrs: { mrtd: t.mrtd, rtmr0: t.rtmr0, rtmr1: t.rtmr1, rtmr2: t.rtmr2 },
    key_provider_event_digest: ev('key-provider')?.digest ?? '0'.repeat(96),
    app_compose_hash_payload: ev('compose-hash')?.event_payload ?? '0'.repeat(64),
  };
}

export interface BootDeps {
  shade: { accountId(): string; getAttestation(): Promise<{ tcb_info: TcbInfoLike } & TeeAttestation>; balance?(): Promise<number>; fund?(near: number): Promise<void> };
  client: Pick<HyperNearClient, 'registerTeeAgent' | 'registerTeeAgentDev' | 'getTeeAgent'>;
  /** HYPERNEAR_TEE_DEV=1 (testnet spike): register without a quote */
  dev: boolean;
  /** HYPERNEAR_TEE_MEASUREMENT: the published hash; boot refuses to run as anything else */
  expected?: string;
  fundNear?: number;
}

/** TEE boot, step 1: fund the agent account if a sponsor is set, then register the attestation. Returns the account and its measurement hash. */
export async function bootTee(d: BootDeps) {
  const account = d.shade.accountId();
  if (d.shade.balance && d.shade.fund && (await d.shade.balance()) < 0.3) await d.shade.fund(d.fundNear ?? 1);
  const attestation = await d.shade.getAttestation();
  const measurements = measurementsFrom(attestation.tcb_info);
  if (d.dev) await d.client.registerTeeAgentDev({ measurements });
  else await d.client.registerTeeAgent({ attestation, measurements });
  const rec = await d.client.getTeeAgent(account);
  if (!rec) throw new Error(`register_tee_agent went through but get_tee_agent(${account}) is empty`);
  if (d.expected && d.expected.toLowerCase() !== rec.measurement_hash.toLowerCase()) {
    throw new Error(`this image registered as measurement ${rec.measurement_hash}, not the published ${d.expected}; refusing to serve`);
  }
  return { account, measurementHash: rec.measurement_hash };
}

/**
 * TEE boot, step 2 (per served owner): a fresh in-memory HL key for every registered leg, approved through the contract
 * (tee_approve_agent, the contract signs with the leg's key) and posted to HL. Keys are never written anywhere.
 */
export async function enrollTeeOwner(d: { legs: Legs; client: Pick<HyperNearClient, 'teeApproveAgent' | 'getConfig'>; post: HlPoster; owner: Hex; now?: () => number }) {
  const owner = d.owner.toLowerCase() as Hex;
  const regs = await d.legs.registered(owner);
  if (!regs.length) throw new Error(`owner ${owner} has no registered leg`);
  const chain = (await d.client.getConfig()).hl_mainnet ? 'Mainnet' : 'Testnet';
  const out: { leg: number; agent: Hex; ok: boolean; hl: unknown }[] = [];
  for (const { leg } of regs) {
    const agent = d.legs.keys.ensure(owner, leg, true);
    const signed = await d.client.teeApproveAgent({ owner, leg, hlAddress: agent.address, hlNonce: (d.now ?? Date.now)() }).then((r) => r.value);
    const hl = await d.post(exchangeBody(signed, chain)).catch((e) => ({ status: 'err', response: String(e) }));
    const ok = (hl as { status?: string })?.status === 'ok';
    if (ok) d.legs.keys.markApproved(owner, leg);
    out.push({ leg, agent: agent.address, ok, hl });
  }
  return out;
}

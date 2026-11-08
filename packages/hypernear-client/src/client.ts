import { keccak256, type Hex } from 'viem';
import { PublicKey, type Account } from 'near-api-js';
import { HyperNearContractError, HyperNearError, HyperNearRelayRefusedError } from './errors';
import { MAX_CANCELS_PER_CALL, type ChainTag, type HlCancel, type OwnerIntent } from './intents';
import { DEFAULT_RPC, nearApiBackend, type NearBackend } from './near';

export const MPC_CONTRACT: Record<'testnet' | 'mainnet', string> = {
  testnet: 'v1.signer-prod.testnet',
  mainnet: 'v1.signer',
};
/** yoctoNEAR the relayer attaches; the contract refunds what storage did not use. */
export const OWNER_EXECUTE_DEPOSIT = 10n ** 22n; // 0.01 NEAR
export const REGISTER_LEG_DEPOSIT = 5n * 10n ** 21n; // 0.005 NEAR (contract minimum)

export interface HyperNearConfig {
  admin: string;
  mpc_contract: string;
  hl_mainnet: boolean;
  chain_tag: ChainTag;
  /** TEE mode (contract >= T1); absent on older deployments. USD per month, and where the owner's payTee usdSend goes. */
  tee_price_usd?: string | number;
  tee_fee_address?: Hex | null;
}

/** An owner's TEE opt-in (`get_tee`): the measurement they chose, what they paid for, and the TEE-approved key per leg. */
export interface TeeInfo {
  /** null after the owner left TEE mode (the entry stays to keep the paid time): "in TEE mode" means measurement_hash != null */
  measurement_hash: string | null;
  /** the owner's TEE instance (its NEAR account); only it may act, and only while attested with measurement_hash */
  agent_account: string | null;
  paid_until_ns: string;
  /** cumulative months the owner paid through payTee (the fee must have landed in HL's ledger for all of them) */
  months_paid: number;
  keys: Record<string, Hex>;
}

/** A registered TEE agent account (`get_tee_agent`). */
export interface TeeAgentInfo {
  measurement_hash: string;
  expires_ns: string;
}

/** shade-agent-js's FullMeasurements and DstackAttestationForContract, as the contract's register methods take them. */
export interface TeeMeasurements {
  rtmrs: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string };
  key_provider_event_digest: string;
  app_compose_hash_payload: string;
}
export type TeeAttestation = Record<string, unknown>;

export interface OwnerState {
  nonce: number;
  frozen: boolean;
  agent: string | null;
  daily_cap: number;
  cooldown_sec: number;
  day: number;
  spent_today: number;
  last_rebalance_ns: number;
}

/** The contract's MPC result. big_r = 33-byte compressed point hex (r = big_r[1..]); hex without 0x. */
export interface SignOut {
  payload: string;
  big_r: string;
  s: string;
  recovery_id: number;
  action: Record<string, unknown> | null;
  /** HL L1 actions (cancels): the nonce the leg key signed, the block time in ms. Absent for user-signed actions. */
  nonce?: number;
}

/** One agent name a freeze re-pointed to a keyless burn address (signature null if that MPC sign failed). */
export interface Revoked {
  leg: number;
  name: string;
  burn_address: Hex;
  signature: SignOut | null;
}

/** Agent names approved through the contract for an owner (what a freeze revokes). */
export interface AgentSlot {
  leg: number;
  name: string;
}

/** The HL /exchange body for a contract-signed user action (SignOut.action), ready to POST. */
export function exchangeBody(out: SignOut, hyperliquidChain: 'Mainnet' | 'Testnet') {
  if (!out.action) throw new HyperNearError('SignOut has no action to post');
  const { type, ...fields } = out.action as { type: string } & Record<string, unknown>;
  const action: Record<string, unknown> = { type, signatureChainId: '0x66eee', hyperliquidChain, ...fields };
  if (type === 'approveAgent' && !action.agentName) delete action.agentName; // HL's unnamed agent (signed as "")
  const nonce = (fields.time ?? fields.nonce) as number;
  return { action, nonce, signature: { r: `0x${out.big_r.slice(2)}`, s: `0x${out.s}`, v: 27 + out.recovery_id } };
}

/** HL's mainnet and testnet API roots. */
export const HL_API: Record<'mainnet' | 'testnet', string> = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' };

/**
 * The HL /exchange body for a contract-signed L1 action (a cancel). Not `exchangeBody`: an L1 action must not carry
 * signatureChainId or hyperliquidChain, and it is posted with `vaultAddress: null`.
 */
export function l1ExchangeBody(out: SignOut) {
  if (!out.action || typeof out.nonce !== 'number') throw new HyperNearError('SignOut is not an L1 action (no action or nonce)');
  return { action: out.action, nonce: out.nonce, signature: { r: `0x${out.big_r.slice(2)}`, s: `0x${out.s}`, v: 27 + out.recovery_id }, vaultAddress: null };
}

/** POSTs a contract-signed L1 action to HL /exchange and returns HL's JSON (never throws on status "err"). */
export async function postL1(out: SignOut, network: 'mainnet' | 'testnet', fetchImpl: typeof fetch = fetch): Promise<HlExchangeResponse> {
  const r = await fetchImpl(`${HL_API[network]}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l1ExchangeBody(out)) });
  const text = await r.text();
  try {
    return JSON.parse(text) as HlExchangeResponse;
  } catch {
    return { status: 'err', response: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  }
}

export type HlExchangeResponse = { status: 'ok'; response?: { data?: { statuses?: unknown[] } } & Record<string, unknown> } | { status: 'err'; response: string };

/** One `cancel_orders` transaction: the cancels it carried, its NEAR tx and the signed L1 cancel to post. */
export interface CancelBatch {
  cancels: HlCancel[];
  txHash: string;
  out: SignOut;
}

export interface HyperNearClientOptions {
  contractId: string;
  network?: 'testnet' | 'mainnet';
  /** default FastNEAR for the network */
  rpcUrl?: string;
  /** signs transactions: a relayer (full-access key, pays storage deposits) or an agent (function-call key) */
  sender?: Account;
  /** replaces the near-api-js transport (tests) */
  backend?: NearBackend;
}

export const legPath = (owner: string, leg: number) => `${owner.toLowerCase()}/leg${leg}`;

/** `0x` + 40 lowercase hex, as the contract requires. */
export function assertLowerAddress(a: string, what: string): Hex {
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new HyperNearError(`${what} must be 0x + 40 lowercase hex: ${a}`);
  return a as Hex;
}

export class HyperNearClient {
  readonly contractId: string;
  readonly network: 'testnet' | 'mainnet';
  readonly backend: NearBackend;
  #config?: Promise<HyperNearConfig>;

  constructor(o: HyperNearClientOptions) {
    this.contractId = o.contractId;
    this.network = o.network ?? 'testnet';
    this.backend = o.backend ?? nearApiBackend({ rpcUrl: o.rpcUrl ?? DEFAULT_RPC[this.network], sender: o.sender });
  }

  #view<T>(method: string, args: Record<string, unknown> = {}) {
    return this.backend.view<T>(this.contractId, method, args);
  }

  /** Cached: the contract config does not change. */
  getConfig(): Promise<HyperNearConfig> {
    this.#config ??= this.#view<HyperNearConfig>('get_config');
    return this.#config;
  }

  async getOwner(owner: string): Promise<OwnerState | null> {
    return (await this.#view<OwnerState | null>('get_owner', { owner: owner.toLowerCase() })) ?? null;
  }

  /** Nonce the owner's next intent must carry. */
  async getOwnerNonce(owner: string): Promise<number> {
    return (await this.getOwner(owner))?.nonce ?? 0;
  }

  async getAgentSlots(owner: string): Promise<AgentSlot[]> {
    return (await this.#view<AgentSlot[]>('get_agent_slots', { owner: owner.toLowerCase() })) ?? [];
  }

  async getLeg(owner: string, leg: number): Promise<Hex | null> {
    return (await this.#view<Hex | null>('get_leg', { owner: owner.toLowerCase(), leg })) ?? null;
  }

  /** The owner's TEE opt-in, or null (also null on a contract that predates TEE mode: it has no `get_tee`). */
  async getTee(owner: string): Promise<TeeInfo | null> {
    try {
      return (await this.#view<TeeInfo | null>('get_tee', { owner: owner.toLowerCase() })) ?? null;
    } catch (e) {
      if (/MethodNotFound|method .*not found|no such method/i.test(String((e as Error)?.message ?? e))) return null;
      throw e;
    }
  }

  /** The hash an owner signs in setTee for these measurements: the contract's `measurement_hash` view (0x + sha256 of borsh). */
  async measurementHash(measurements: TeeMeasurements): Promise<string> {
    return this.#view<string>('measurement_hash', { measurements });
  }

  /** A payTee intent with the price and fee address the owner must sign, read from get_config (the contract refuses any other). */
  async payTeeIntent(leg: number, months: number): Promise<Extract<OwnerIntent, { type: 'payTee' }>> {
    const c = await this.getConfig();
    if (!c.tee_price_usd || !c.tee_fee_address) throw new HyperNearError('TEE mode is not offered by this contract (no price / fee address)');
    return { type: 'payTee', leg, months, priceMicro: Math.round(Number(c.tee_price_usd) * 1e6), feeAddress: c.tee_fee_address };
  }

  async getTeeAgent(accountId: string): Promise<TeeAgentInfo | null> {
    return (await this.#view<TeeAgentInfo | null>('get_tee_agent', { account_id: accountId })) ?? null;
  }

  /** EVM address of the leg, from the MPC contract's `derived_public_key` view (works before registration). */
  async deriveLegAddress(owner: string, leg: number): Promise<Hex> {
    const cfg = await this.getConfig();
    const pk = await this.backend.view<string>(cfg.mpc_contract, 'derived_public_key', {
      path: legPath(owner, leg),
      predecessor: this.contractId,
      domain_id: 0,
    });
    const raw = PublicKey.fromString(pk).data;
    if (raw.length !== 64) throw new HyperNearError(`unexpected derived key length ${raw.length}`);
    return `0x${keccak256(raw).slice(-40)}` as Hex;
  }

  /** Idempotent: returns the registered address, registering it first if needed (sender pays the storage deposit). */
  async registerLeg(owner: string, leg: number): Promise<Hex> {
    const o = assertLowerAddress(owner.toLowerCase(), 'owner');
    const existing = await this.getLeg(o, leg);
    if (existing) return existing;
    try {
      const { value } = await this.backend.call<Hex | null>(this.contractId, 'register_leg', { owner: o, leg }, {
        deposit: REGISTER_LEG_DEPOSIT,
      });
      if (value) return value;
      throw new HyperNearContractError('register_leg: MPC derived_public_key failed (deposit refunded)');
    } catch (e) {
      if (e instanceof HyperNearContractError && e.message.includes('leg already registered')) {
        const now = await this.getLeg(o, leg);
        if (now) return now;
      }
      throw e;
    }
  }

  /**
   * `cancel_orders`: while the owner is frozen, anyone may have the contract sign HL L1 cancels for a registered leg
   * (a cancel cannot move funds). More than 16 cancels go in several calls, one NEAR transaction each, in order; each
   * result is returned as soon as it exists in `onBatch` so a failure in a later batch loses nothing already signed.
   */
  async cancelFrozen(args: { owner: Hex; leg: number; cancels: HlCancel[]; onBatch?: (b: CancelBatch) => void | Promise<void> }): Promise<CancelBatch[]> {
    const out: CancelBatch[] = [];
    for (let i = 0; i < args.cancels.length; i += MAX_CANCELS_PER_CALL) {
      const cancels = args.cancels.slice(i, i + MAX_CANCELS_PER_CALL);
      // 300 TGas: the call joins an MPC signature
      const { txHash, value } = await this.backend.call<SignOut>(this.contractId, 'cancel_orders', { owner: args.owner.toLowerCase(), leg: args.leg, cancels }, { gasTgas: 300 });
      const batch = { cancels, txHash, out: value };
      out.push(batch);
      await args.onBatch?.(batch);
    }
    return out;
  }

  /** Raw `owner_execute`; prefer relaySubmit (checks) or NearMasterSigner (maps HL payloads). */
  /**
   * Returns a SignOut for HL actions, a Revoked[] for freeze {frozen: true} (post each with `exchangeBody`), else null.
   * 300 TGas: a freeze signs one approveAgent per tracked agent name in the same transaction.
   */
  async ownerExecute(args: { owner: Hex; nonce: number; intent: OwnerIntent; signature: Hex }) {
    return this.backend.call<SignOut | Revoked[] | null>(this.contractId, 'owner_execute', { ...args, owner: args.owner.toLowerCase() }, {
      deposit: OWNER_EXECUTE_DEPOSIT,
      gasTgas: 300,
    });
  }

  /**
   * Relayer entry: sends a signed owner intent. Refuses owners whose leg is not registered (the intent's leg, or
   * leg 0 for setPolicy/freeze); `register_leg` is the way in. Rate limiting is the server's job.
   */
  async relaySubmit(args: { owner: Hex; nonce: number; intent: OwnerIntent }, signature: Hex) {
    const leg = 'leg' in args.intent ? args.intent.leg : 0;
    if (!(await this.getLeg(args.owner, leg))) {
      throw new HyperNearRelayRefusedError(`owner ${args.owner} has no registered leg ${leg}; register_leg first`);
    }
    return this.ownerExecute({ ...args, signature });
  }

  /** Agent: usdSend from a leg to another registered leg of the same owner (cap + cooldown on chain). */
  rebalance(args: { owner: Hex; fromLeg: number; toAddress: Hex; amount: string; hlTime: number }) {
    return this.backend.call<SignOut | null>(this.contractId, 'rebalance', {
      owner: args.owner.toLowerCase(),
      from_leg: args.fromLeg,
      to_address: args.toAddress,
      amount: args.amount,
      hl_time: args.hlTime,
    });
  }

  /** Agent: spot -> perp only (`toPerp` must be true; the contract refuses false). */
  agentUsdClassTransfer(args: { owner: Hex; leg: number; amount: string; toPerp: boolean; hlNonce: number }) {
    return this.backend.call<SignOut | null>(this.contractId, 'agent_usd_class_transfer', {
      owner: args.owner.toLowerCase(),
      leg: args.leg,
      amount: args.amount,
      to_perp: args.toPerp,
      hl_nonce: args.hlNonce,
    });
  }

  /** TEE agent boot, called from the agent's own NEAR account: the contract verifies the quote (300 TGas). */
  registerTeeAgent(args: { attestation: TeeAttestation; measurements: TeeMeasurements }) {
    return this.backend.call<null>(this.contractId, 'register_tee_agent', args, { gasTgas: 300 });
  }

  /** Testnet spike only: registers without a quote. */
  registerTeeAgentDev(args: { measurements: TeeMeasurements }) {
    return this.backend.call<null>(this.contractId, 'register_tee_agent_dev', args, { gasTgas: 100 });
  }

  /** TEE agent: the contract signs HL approveAgent for `hlAddress` (fixed agent name) with the leg's key; post the result to HL. */
  teeApproveAgent(args: { owner: Hex; leg: number; hlAddress: Hex; hlNonce: number }) {
    return this.backend.call<SignOut>(this.contractId, 'tee_approve_agent', {
      owner: args.owner.toLowerCase(),
      leg: args.leg,
      hl_address: args.hlAddress,
      hl_nonce: args.hlNonce,
    }, { gasTgas: 300 });
  }
}

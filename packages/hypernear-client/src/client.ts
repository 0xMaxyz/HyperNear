import { keccak256, type Hex } from 'viem';
import { PublicKey, type Account } from 'near-api-js';
import { HyperNearContractError, HyperNearError, HyperNearRelayRefusedError } from './errors';
import type { ChainTag, OwnerIntent } from './intents';
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
}

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
}

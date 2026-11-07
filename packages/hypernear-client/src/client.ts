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
  async ownerExecute(args: { owner: Hex; nonce: number; intent: OwnerIntent; signature: Hex }) {
    return this.backend.call<SignOut | null>(this.contractId, 'owner_execute', { ...args, owner: args.owner.toLowerCase() }, {
      deposit: OWNER_EXECUTE_DEPOSIT,
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

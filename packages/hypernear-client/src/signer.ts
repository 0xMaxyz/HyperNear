// HlAsyncSigner whose key is a NEAR Chain Signature held by the hypernear contract.
import type { HlAsyncSigner, HlHex, HlSignPayload } from '@perps-platform/core';
import type { Hex } from 'viem';
import { assertLowerAddress, HyperNearClient, type SignOut } from './client';
import { HyperNearDigestMismatchError, HyperNearMpcSignError, HyperNearUnsupportedActionError } from './errors';
import { hlPayloadDigest } from './hlDigest';
import { ownerIntentTypedData, type OwnerIntent, type OwnerIntentTypedData } from './intents';

/** The contract signs HL actions under this domain chain id only (contract/src/eip712.rs HL_SIGNATURE_CHAIN_ID). */
export const HYPERNEAR_HL_SIGNATURE_CHAIN_ID = 0x66eee;
const ZERO = '0x0000000000000000000000000000000000000000';
const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;

export type NearMasterSignerMode = 'agent' | 'owner';

export interface NearMasterSignerOptions {
  /** Its sender signs the NEAR transactions: the agent's function-call key (agent mode) or a relayer (owner mode). */
  client: HyperNearClient;
  /** Owner EVM address (lowercased here). */
  owner: Hex;
  leg: number;
  mode: NearMasterSignerMode;
  /** Owner mode: signs the owner intent typed data (Privy in the web app, a viem account in tests). */
  signOwnerIntent?: (typedData: OwnerIntentTypedData) => Promise<Hex>;
  /** Skip the lookup when the leg address is already known. */
  legAddress?: Hex;
  /** Called with each NEAR transaction the signer sends (for logs and timelines). */
  onNearTx?: (tx: { method: string; txHash: string }) => void;
}

const unsupported = (msg: string): never => {
  throw new HyperNearUnsupportedActionError(msg);
};

function amountOf(m: Record<string, unknown>): string {
  const a = String(m.amount);
  if (!AMOUNT.test(a) || !/[1-9]/.test(a)) unsupported(`amount must be a plain decimal > 0 with <= 6 decimals: ${a}`);
  return a;
}

/** HL user-signed payload -> what the contract call needs. Throws HyperNearUnsupportedActionError for anything else. */
type Mapped =
  | { kind: 'rebalance'; toAddress: Hex; amount: string; hlTime: number }
  | { kind: 'rebalanceSpot'; toAddress: Hex; amount: string; hlNonce: number }
  | { kind: 'agentUsdClassTransfer'; amount: string; hlNonce: number }
  | { kind: 'owner'; intent: OwnerIntent };

export function mapHlPayload(
  payload: HlSignPayload,
  ctx: { mode: NearMasterSignerMode; owner: Hex; leg: number; hlChain: 'Mainnet' | 'Testnet' }
): Mapped {
  const d = payload.domain;
  if (d.name !== 'HyperliquidSignTransaction' || d.version !== '1' || Number(d.chainId) !== HYPERNEAR_HL_SIGNATURE_CHAIN_ID
    || String(d.verifyingContract).toLowerCase() !== ZERO) {
    unsupported(`domain must be HyperliquidSignTransaction/1/chainId 0x66eee (set HlClient signatureChainId '0x66eee'): ${JSON.stringify(d)}`);
  }
  const m = payload.message;
  if (m.hyperliquidChain !== ctx.hlChain) unsupported(`hyperliquidChain ${String(m.hyperliquidChain)} != contract's ${ctx.hlChain}`);
  const { mode, leg } = ctx;
  switch (payload.primaryType) {
    case 'HyperliquidTransaction:UsdSend': {
      if (mode !== 'agent') return unsupported('usdSend has no owner intent (owners withdraw; agents rebalance between legs)');
      // destination is hashed as a string: the contract only signs lowercase ones
      const toAddress = assertLowerOrThrow(String(m.destination), 'usdSend destination');
      return { kind: 'rebalance', toAddress, amount: amountOf(m), hlTime: Number(m.time) };
    }
    case 'HyperliquidTransaction:SendAsset': {
      if (mode !== 'agent') return unsupported('sendAsset has no owner intent (owners withdraw; agents rebalance between legs)');
      // the contract signs only spot -> spot USDC with no sub-account, so refuse anything else before a NEAR transaction is spent
      if (m.sourceDex !== 'spot' || m.destinationDex !== 'spot' || m.fromSubAccount !== '') unsupported('sendAsset must be spot to spot, with no sub-account');
      if (!/^USDC:0x[0-9a-f]{32}$/.test(String(m.token))) unsupported(`sendAsset token must be spot USDC: ${String(m.token)}`);
      const toAddress = assertLowerOrThrow(String(m.destination), 'sendAsset destination');
      return { kind: 'rebalanceSpot', toAddress, amount: amountOf(m), hlNonce: Number(m.nonce) };
    }
    case 'HyperliquidTransaction:UsdClassTransfer': {
      if (String(m.amount).includes('subaccount')) unsupported('subaccount transfers are not supported');
      const amount = amountOf(m);
      const toPerp = Boolean(m.toPerp);
      if (mode === 'agent') {
        if (!toPerp) unsupported('an agent may only move spot -> perp (toPerp: true)');
        return { kind: 'agentUsdClassTransfer', amount, hlNonce: Number(m.nonce) };
      }
      return { kind: 'owner', intent: { type: 'usdClassTransfer', leg, amount, toPerp, hlNonce: Number(m.nonce) } };
    }
    case 'HyperliquidTransaction:Withdraw': {
      if (mode !== 'owner') return unsupported('only the owner can withdraw');
      if (String(m.destination) !== ctx.owner) unsupported(`withdraw destination must be the owner ${ctx.owner} (lowercase): ${String(m.destination)}`);
      return { kind: 'owner', intent: { type: 'withdraw', leg, amount: amountOf(m), hlTime: Number(m.time) } };
    }
    case 'HyperliquidTransaction:ApproveAgent': {
      if (mode !== 'owner') return unsupported('only the owner can approve an agent');
      // `address` type: case does not change the hash, so lowercasing for the contract is safe
      const agent = String(m.agentAddress).toLowerCase() as Hex;
      return { kind: 'owner', intent: { type: 'approveAgent', leg, agent, agentName: String(m.agentName ?? ''), hlNonce: Number(m.nonce) } };
    }
    default:
      return unsupported(`not signable by the hypernear contract: ${payload.primaryType}`);
  }
}

function assertLowerOrThrow(a: string, what: string): Hex {
  try {
    return assertLowerAddress(a, what);
  } catch (e) {
    return unsupported((e as Error).message);
  }
}

/** r || s || v (v = 27 + recovery_id) from the contract's SignOut. */
export function signOutToHex(out: SignOut): HlHex {
  return `0x${out.big_r.slice(2)}${out.s}${(27 + out.recovery_id).toString(16)}` as HlHex;
}

export class NearMasterSigner implements HlAsyncSigner {
  readonly address: HlHex;
  readonly sign: (payload: HlSignPayload) => Promise<HlHex>;
  readonly #o: NearMasterSignerOptions;
  readonly #owner: Hex;

  /** Resolves the leg address (registered, else derived from the MPC key) and builds the signer. */
  static async create(o: NearMasterSignerOptions): Promise<NearMasterSigner> {
    const addr = o.legAddress ?? (await o.client.getLeg(o.owner, o.leg)) ?? (await o.client.deriveLegAddress(o.owner, o.leg));
    return new NearMasterSigner(o, addr);
  }

  constructor(o: NearMasterSignerOptions, legAddress: Hex) {
    if (o.mode === 'owner' && !o.signOwnerIntent) throw new HyperNearUnsupportedActionError('owner mode needs signOwnerIntent');
    this.#o = o;
    this.#owner = assertLowerAddress(o.owner.toLowerCase(), 'owner');
    this.address = legAddress.toLowerCase() as HlHex;
    this.sign = (payload) => this.#sign(payload);
  }

  async #sign(payload: HlSignPayload): Promise<HlHex> {
    const { client, leg, mode } = this.#o;
    const cfg = await client.getConfig();
    const mapped = mapHlPayload(payload, { mode, owner: this.#owner, leg, hlChain: cfg.hl_mainnet ? 'Mainnet' : 'Testnet' });
    const owner = this.#owner;
    let r: { txHash: string; value: unknown };
    let method: string;
    if (mapped.kind === 'rebalance') {
      method = 'rebalance';
      r = await client.rebalance({ owner, fromLeg: leg, toAddress: mapped.toAddress, amount: mapped.amount, hlTime: mapped.hlTime });
    } else if (mapped.kind === 'rebalanceSpot') {
      method = 'rebalance_spot';
      r = await client.rebalanceSpot({ owner, fromLeg: leg, toAddress: mapped.toAddress, amount: mapped.amount, hlNonce: mapped.hlNonce });
    } else if (mapped.kind === 'agentUsdClassTransfer') {
      method = 'agent_usd_class_transfer';
      r = await client.agentUsdClassTransfer({ owner, leg, amount: mapped.amount, toPerp: true, hlNonce: mapped.hlNonce });
    } else {
      method = 'owner_execute';
      const nonce = await client.getOwnerNonce(owner);
      const typed = ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId: client.contractId, owner, nonce, intent: mapped.intent });
      const signature = await this.#o.signOwnerIntent!(typed);
      r = await client.ownerExecute({ owner, nonce, intent: mapped.intent, signature });
    }
    this.#o.onNearTx?.({ method, txHash: r.txHash });
    const out = r.value as SignOut | null; // never a Revoked[]: the signer does not send freeze
    if (!out) throw new HyperNearMpcSignError(`MPC sign failed for ${payload.primaryType} (leg ${leg})`);
    const want = hlPayloadDigest(payload as never).slice(2);
    if (out.payload !== want) throw new HyperNearDigestMismatchError(`contract signed ${out.payload}, payload hashes to ${want}`);
    return signOutToHex(out);
  }
}

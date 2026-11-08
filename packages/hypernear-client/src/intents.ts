// Owner intents: EIP-712 typed data the owner signs; mirrors contract/src/auth.rs.
import { keccak256, toHex, type Hex } from 'viem';

/** "near-testnet" | "near-mainnet": from the contract's `get_config().chain_tag`. */
export type ChainTag = 'near-testnet' | 'near-mainnet';

/** What an owner can ask the contract for. Addresses are 0x + 40 lowercase hex; amounts plain decimals (<= 6 decimals). */
export type OwnerIntent =
  | { type: 'approveAgent'; leg: number; agent: Hex; agentName?: string; hlNonce: number }
  /** HL withdraw3 to the owner's own address: there is no destination field. */
  | { type: 'withdraw'; leg: number; amount: string; hlTime: number }
  | { type: 'usdClassTransfer'; leg: number; amount: string; toPerp: boolean; hlNonce: number }
  /** `agent` = NEAR account id allowed to call rebalance / agent_usd_class_transfer; "" revokes. */
  | { type: 'setPolicy'; agent: string; dailyCap: string; cooldownSec: number }
  | { type: 'freeze'; frozen: boolean }
  /** Cancels on a leg, signed by the leg's key as an HL L1 action. Allowed at any time, frozen or not. */
  | { type: 'cancelOrders'; leg: number; cancels: HlCancel[] };

/** HL's own cancel entry: a = asset index, o = order id. */
export interface HlCancel {
  a: number;
  o: number;
}

/** Most cancels one `cancel_orders` call or `cancelOrders` intent may carry (contract limit). */
export const MAX_CANCELS_PER_CALL = 16;

export type OwnerIntentType = OwnerIntent['type'];

interface Field {
  name: string;
  type: string;
}

/** For raw `eth_signTypedData_v4` callers, which need it in `types`; viem adds it itself. */
export const HYPERNEAR_DOMAIN_TYPE: readonly Field[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'salt', type: 'bytes32' },
];

const head: Field[] = [
  { name: 'owner', type: 'address' },
  { name: 'nonce', type: 'uint64' },
];

export const OWNER_INTENT_TYPES: Record<OwnerIntentType, readonly [string, readonly Field[]]> = {
  approveAgent: ['ApproveAgent', [...head, { name: 'leg', type: 'uint32' }, { name: 'agent', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'hlNonce', type: 'uint64' }]],
  withdraw: ['Withdraw', [...head, { name: 'leg', type: 'uint32' }, { name: 'amount', type: 'string' }, { name: 'hlTime', type: 'uint64' }]],
  usdClassTransfer: ['UsdClassTransfer', [...head, { name: 'leg', type: 'uint32' }, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' }, { name: 'hlNonce', type: 'uint64' }]],
  setPolicy: ['SetPolicy', [...head, { name: 'agent', type: 'string' }, { name: 'dailyCap', type: 'string' }, { name: 'cooldownSec', type: 'uint64' }]],
  freeze: ['Freeze', [...head, { name: 'frozen', type: 'bool' }]],
  cancelOrders: ['CancelOrders', [...head, { name: 'leg', type: 'uint32' }, { name: 'cancels', type: 'Cancel[]' }]],
};

/** Struct types an intent type refers to (EIP-712 appends them to the type string). */
export const OWNER_INTENT_SUBTYPES = { Cancel: [{ name: 'a', type: 'uint32' }, { name: 'o', type: 'uint64' }] } as const;

export function hypernearDomain(chainTag: ChainTag, contractId: string) {
  return { name: 'Leash', version: '1', salt: keccak256(toHex(`${chainTag}:${contractId}`)) } as const;
}

export interface OwnerIntentTypedData {
  domain: { name: string; version: string; salt: Hex };
  types: Record<string, readonly Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Typed data for viem `signTypedData` (or any EIP-1193 wallet: add `EIP712Domain: HYPERNEAR_DOMAIN_TYPE` to `types`
 * for a raw `eth_signTypedData_v4`). Numbers stay JS numbers so the object is JSON-safe.
 */
export function ownerIntentTypedData(args: {
  chainTag: ChainTag;
  contractId: string;
  owner: Hex;
  nonce: number;
  intent: OwnerIntent;
}): OwnerIntentTypedData {
  const { chainTag, contractId, owner, nonce, intent } = args;
  const [primaryType, fields] = OWNER_INTENT_TYPES[intent.type];
  const { type: _type, ...rest } = intent;
  return {
    domain: hypernearDomain(chainTag, contractId),
    types: { [primaryType]: fields, ...(intent.type === 'cancelOrders' ? { Cancel: OWNER_INTENT_SUBTYPES.Cancel } : {}) },
    primaryType,
    message: { ...(intent.type === 'approveAgent' ? { agentName: '' } : {}), ...rest, owner: owner.toLowerCase(), nonce },
  };
}

// Owner intents (EIP-712) for the hypernear contract; mirrors src/auth.rs. Usable from the agent/web.
import { keccak256, toHex } from "viem";

/** chainTag: "near-testnet" | "near-mainnet" */
export const hypernearDomain = (chainTag, contractId) => ({
  name: "Leash",
  version: "1",
  salt: keccak256(toHex(`${chainTag}:${contractId}`)),
});

const head = [{ name: "owner", type: "address" }, { name: "nonce", type: "uint64" }];
export const OWNER_INTENT_TYPES = {
  approveAgent: ["ApproveAgent", [...head, { name: "leg", type: "uint32" }, { name: "agent", type: "address" }, { name: "agentName", type: "string" }, { name: "hlNonce", type: "uint64" }]],
  withdraw: ["Withdraw", [...head, { name: "leg", type: "uint32" }, { name: "amount", type: "string" }, { name: "hlTime", type: "uint64" }]],
  usdClassTransfer: ["UsdClassTransfer", [...head, { name: "leg", type: "uint32" }, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "hlNonce", type: "uint64" }]],
  setPolicy: ["SetPolicy", [...head, { name: "agent", type: "string" }, { name: "dailyCap", type: "string" }, { name: "cooldownSec", type: "uint64" }]],
  freeze: ["Freeze", [...head, { name: "frozen", type: "bool" }]],
  // cancels = HL's own cancel entries {a: asset, o: oid}; allowed while frozen (a cancel cannot move funds)
  cancelOrders: ["CancelOrders", [...head, { name: "leg", type: "uint32" }, { name: "cancels", type: "Cancel[]" }]],
  // TEE mode: measurementHash = 0x + 64 hex; the zero hash leaves TEE mode
  setTee: ["SetTee", [...head, { name: "measurementHash", type: "bytes32" }]],
  payTee: ["PayTee", [...head, { name: "leg", type: "uint32" }, { name: "months", type: "uint32" }]],
};
/** Struct types referenced by an intent type (EIP-712 appends them to the type string). */
export const OWNER_INTENT_SUBTYPES = { Cancel: [{ name: "a", type: "uint32" }, { name: "o", type: "uint64" }] };

/** Typed data for viem signTypedData / hashTypedData. intent = {type, ...fields} as the contract takes it. */
export function ownerIntentTypedData(chainTag, contractId, owner, nonce, intent) {
  const [primaryType, fields] = OWNER_INTENT_TYPES[intent.type] ?? (() => { throw new Error(`unknown intent ${intent.type}`); })();
  const { type, ...rest } = intent;
  return {
    domain: hypernearDomain(chainTag, contractId),
    types: { [primaryType]: fields, ...(intent.type === "cancelOrders" ? { Cancel: OWNER_INTENT_SUBTYPES.Cancel } : {}) },
    primaryType,
    message: { agentName: "", ...rest, owner, nonce: BigInt(nonce) },
  };
}

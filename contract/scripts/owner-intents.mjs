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
};

/** Typed data for viem signTypedData / hashTypedData. intent = {type, ...fields} as the contract takes it. */
export function ownerIntentTypedData(chainTag, contractId, owner, nonce, intent) {
  const [primaryType, fields] = OWNER_INTENT_TYPES[intent.type] ?? (() => { throw new Error(`unknown intent ${intent.type}`); })();
  const { type, ...rest } = intent;
  return {
    domain: hypernearDomain(chainTag, contractId),
    types: { [primaryType]: fields },
    primaryType,
    message: { agentName: "", ...rest, owner, nonce: BigInt(nonce) },
  };
}

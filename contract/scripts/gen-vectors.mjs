// EIP-712 digests of Hyperliquid user-signed actions, computed with viem; prints test vectors.
// Usage: node gen-vectors.mjs hl    > ../tests/vectors/hl_actions.json
//        node gen-vectors.mjs owner > ../tests/vectors/owner_intents.json
// viem >= 2.57 hashTypedData rejects ":" in struct names (InvalidStructTypeError), so the digest is
// keccak(0x1901 || hashDomain || hashStruct) from viem's own unvalidated parts.
import { concat, hashDomain, hashStruct, hashTypedData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ownerIntentTypedData } from "./owner-intents.mjs";

export const HL_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 0x66eee,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const EIP712_DOMAIN_TYPES = { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] };
const chain = { name: "hyperliquidChain", type: "string" };
// action.type -> [primaryType, fields]; from hyperliquid-python-sdk utils/signing.py
export const HL_TYPES = {
  approveAgent: ["HyperliquidTransaction:ApproveAgent", [chain, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }]],
  usdSend: ["HyperliquidTransaction:UsdSend", [chain, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }]],
  withdraw3: ["HyperliquidTransaction:Withdraw", [chain, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }]],
  usdClassTransfer: ["HyperliquidTransaction:UsdClassTransfer", [chain, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "nonce", type: "uint64" }]],
  // field order checked against @nktkas/hyperliquid 0.33.1 SendAssetTypes
  sendAsset: ["HyperliquidTransaction:SendAsset", [chain, { name: "destination", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationDex", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "fromSubAccount", type: "string" }, { name: "nonce", type: "uint64" }]],
};

/** action = HL /exchange action JSON ({type, ...fields}); numbers may be number or bigint. */
export function hlDigest(hyperliquidChain, action) {
  const [primaryType, fields] = HL_TYPES[action.type] ?? (() => { throw new Error(`unknown action ${action.type}`); })();
  const data = { agentName: "", ...action, hyperliquidChain };
  for (const f of fields) if (f.type === "uint64") data[f.name] = BigInt(data[f.name]);
  return keccak256(concat([
    "0x1901",
    hashDomain({ domain: HL_DOMAIN, types: EIP712_DOMAIN_TYPES }),
    hashStruct({ data, primaryType, types: { [primaryType]: fields } }),
  ]));
}

async function ownerVectors() {
  // well-known PUBLIC web3 test key, fixed so the vectors are deterministic: never fund it, never use off testnet
  const acct = privateKeyToAccount("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
  const [chainTag, contractId, owner] = ["near-testnet", "leash-spike-1107.testnet", acct.address.toLowerCase()];
  const agent = "0x7bfcce9237bb278b0e166f11955a90595fa9c2c6";
  const intents = [
    { type: "approveAgent", leg: 0, agent, agentName: "leash-leg0", hlNonce: 1794050000000 },
    { type: "approveAgent", leg: 3, agent, agentName: "", hlNonce: 1794050000001 },
    { type: "withdraw", leg: 1, amount: "2.5", hlTime: 1794050000002 },
    { type: "usdClassTransfer", leg: 0, amount: "1", toPerp: false, hlNonce: 1794050000003 },
    { type: "setPolicy", agent: "agent.leash.testnet", dailyCap: "100", cooldownSec: 600 },
    { type: "freeze", frozen: true },
    { type: "cancelOrders", leg: 0, cancels: [{ a: 3, o: 64820881296 }, { a: 10000, o: 5 }] },
    { type: "setTee", measurementHash: "0x7b1c0f00a2c9e0e3d7d1d4b9a8a3f1e2c4b5a6978877665544332211ffeeddcc", agentAccount: "abababababababababababababababababababababababababababababababab" },
    { type: "setTee", measurementHash: "0x0000000000000000000000000000000000000000000000000000000000000000", agentAccount: "" },
    { type: "payTee", leg: 2, months: 3, priceMicro: 1000000, feeAddress: "0x306d1dbe4a4f93f06c8070b047ede9f59e37a2dc" },
  ];
  const cases = [];
  for (const [i, intent] of intents.entries()) {
    const td = ownerIntentTypedData(chainTag, contractId, owner, i, intent);
    cases.push({ nonce: i, intent, digest: hashTypedData(td), signature: await acct.signTypedData(td) });
  }
  const domainSeparator = hashDomain({
    domain: ownerIntentTypedData(chainTag, contractId, owner, 0, intents[0]).domain,
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "salt", type: "bytes32" }] },
  });
  return { generator: "viem 2.57.16 hashTypedData+signTypedData", chainTag, contractId, owner, domainSeparator, cases };
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "owner") {
  console.log(JSON.stringify(await ownerVectors(), null, 2));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const a = "0x8ba1f109551bd432803012645ac136ddd64dba72";
  const cases = [
    ["Testnet", { type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000001", agentName: "", nonce: 0 }],
    ["Testnet", { type: "approveAgent", agentAddress: a, agentName: "leash-leg0", nonce: 1794050000000 }],
    ["Mainnet", { type: "approveAgent", agentAddress: "0xffffffffffffffffffffffffffffffffffffffff", agentName: "a much longer agent name ✓", nonce: 1794050000001 }],
    ["Testnet", { type: "usdSend", destination: a, amount: "1", time: 1794050000002 }],
    ["Mainnet", { type: "usdSend", destination: "0x0000000000000000000000000000000000000001", amount: "12.345678", time: 1794050000003 }],
    ["Testnet", { type: "withdraw3", destination: a, amount: "2.5", time: 1794050000004 }],
    ["Mainnet", { type: "withdraw3", destination: a, amount: "1000000", time: 1794050000005 }],
    ["Testnet", { type: "usdClassTransfer", amount: "3", toPerp: true, nonce: 1794050000006 }],
    ["Mainnet", { type: "usdClassTransfer", amount: "0.5", toPerp: false, nonce: 1794050000007 }],
    ["Testnet", { type: "sendAsset", destination: a, sourceDex: "spot", destinationDex: "spot", token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "4", fromSubAccount: "", nonce: 1794050000008 }],
    ["Mainnet", { type: "sendAsset", destination: a, sourceDex: "spot", destinationDex: "spot", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "12.345678", fromSubAccount: "", nonce: 1794050000009 }],
  ];
  const domainSeparator = hashDomain({ domain: HL_DOMAIN, types: EIP712_DOMAIN_TYPES });
  console.log(JSON.stringify({
    generator: "viem 2.57.16 hashDomain+hashStruct",
    domainSeparator,
    cases: cases.map(([hyperliquidChain, action]) => ({ hyperliquidChain, action, digest: hlDigest(hyperliquidChain, action) })),
  }, null, 2));
}

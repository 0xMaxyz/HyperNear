// Gas of a setTee that enters TEE mode for an owner with 3 server agents (one per leg), which burns all 3 in one tx.
// Testnet only, a fresh random owner (nothing funded, nothing on HL). Run on ci32: node tee-switch-gas.ts <leash.testnet>
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { accountFromKeychain, callSign, OWNER_DEPOSIT, REGISTER_LEG_DEPOSIT, tgas } from "./lib.ts";
import { ownerIntentTypedData } from "./owner-intents.mjs";

const contractId = process.argv[2];
if (!contractId?.endsWith(".testnet")) throw new Error("usage: node tee-switch-gas.ts <hypernear-account.testnet>");
const relayer = accountFromKeychain(contractId);
const owner = privateKeyToAccount(generatePrivateKey()); // throwaway testnet owner
const o = owner.address.toLowerCase();
let nonce = 0;
const exec = async (intent: Record<string, unknown>) => {
  const sig = await owner.signTypedData(ownerIntentTypedData("near-testnet", contractId, o, nonce, intent) as never);
  const r = await callSign(relayer, contractId, "owner_execute", { owner: o, nonce, intent, signature: sig }, OWNER_DEPOSIT);
  nonce++;
  return r;
};
for (const leg of [0, 1, 2]) await callSign(relayer, contractId, "register_leg", { owner: o, leg }, REGISTER_LEG_DEPOSIT);
for (const leg of [0, 1, 2]) {
  await exec({ type: "approveAgent", leg, agent: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), agentName: `leash-leg${leg}`, hlNonce: Date.now() });
}
const r = await exec({
  type: "setTee",
  measurementHash: "0x7b1c0f00a2c9e0e3d7d1d4b9a8a3f1e2c4b5a6978877665544332211ffeeddcc",
  agentAccount: "abababababababababababababababababababababababababababababababab",
});
const revoked = r.out as unknown as { leg: number; name: string; signature: unknown }[];
console.log(JSON.stringify({
  owner: o, setTeeTx: r.txHash, gasBurntTotalTgas: tgas(r.gasBurnt), receipts: r.receipts,
  revoked: revoked.map((x) => ({ leg: x.leg, name: x.name, signed: x.signature !== null })),
}, null, 2));

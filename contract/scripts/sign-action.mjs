// Sign a Hyperliquid user-signed action with the leg's MPC key, on demand. Does NOT submit.
// Run on ci32: node contract/scripts/sign-action.mjs <approveAgent|usdSend|withdraw3|usdClassTransfer> <path> '<json-args>' [out.json]
//   json-args = the HL action fields, e.g. usdSend: '{"destination":"0x…lowercase","amount":"1.5","time":1794050000000}'
//   addresses are lowercased here (HL hashes destination as a string); amounts plain decimals, <= 6 decimals.
// Prints (and writes to out.json if given) {derivedAddress, action, nonce, signature:{r,s,v}, digest, signTx, exchangeRequest};
// POST {action, nonce, signature} (= exchangeRequest) to https://api.hyperliquid-testnet.xyz/exchange.
// Contract: $HYPERNEAR_CONTRACT (default leash-spike-1107.testnet), called with its own key from ~/.near-credentials.
import { writeFileSync } from "node:fs";
import { hlDigest } from "./gen-vectors.mjs";
import { accountFromKeychain, callSign, derivedEvmAddress, recover, toRsv } from "./lib.ts";

const HL_CHAIN = "Testnet";

export async function signHlAction(contractId, path, input) {
  const action = { ...input };
  for (const k of ["destination", "agentAddress"]) if (typeof action[k] === "string") action[k] = action[k].toLowerCase();
  const master = await derivedEvmAddress(contractId, path);
  const digest = hlDigest(HL_CHAIN, action);
  const r = await callSign(accountFromKeychain(contractId), contractId, "admin_sign_hl", { path, action });
  if (`0x${r.out.payload}` !== digest) throw new Error(`contract digest 0x${r.out.payload} != viem digest ${digest}`);
  const signer = await recover(digest, r.out);
  if (signer.toLowerCase() !== master) throw new Error(`recovered ${signer} != derived ${master}`);
  const { r: sr, s, v, lowS } = toRsv(r.out);
  if (!lowS) throw new Error("high-s signature");
  const { type, ...fields } = action;
  const exchangeRequest = {
    action: { type, hyperliquidChain: HL_CHAIN, signatureChainId: "0x66eee", ...fields },
    nonce: action.time ?? action.nonce,
    signature: { r: sr, s, v },
  };
  return { derivedAddress: master, ...exchangeRequest, master, digest, signTx: r.txHash,
    gasTGas: (Number(r.gasBurnt) / 1e12).toFixed(2), exchangeRequest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [type, path, json, outFile] = process.argv.slice(2);
  if (!type || !path || !json) throw new Error("usage: node sign-action.mjs <action> <path> '<json-args>'");
  const contractId = process.env.HYPERNEAR_CONTRACT ?? "leash-spike-1107.testnet";
  const out = JSON.stringify(await signHlAction(contractId, path, { type, ...JSON.parse(json) }), null, 2);
  if (outFile) writeFileSync(outFile, out + "\n");
  console.log(out);
}

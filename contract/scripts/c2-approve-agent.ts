// C2 prep: MPC-signed HL testnet `approveAgent` for the leg at path "test/leg0". Does NOT submit.
// Run on ci32: node c2-approve-agent.ts <hypernear-account.testnet> > ../out/c2-approve-agent.json
// The throwaway agent key is written to ~/.near-credentials/hypernear-agent-test-leg0.key (mode 600), never printed.
// To re-sign later with a fresh nonce: node sign-approve.mjs test/leg0 <agentAddress> <nonceMs> leash-leg0
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { type Hex } from "viem";
import { derivedEvmAddress } from "./lib.ts";
import { signApproveAgent } from "./sign-approve.mjs";

const contractId = process.argv[2];
if (!contractId) throw new Error("usage: node c2-approve-agent.ts <hypernear-account>");
const path = "test/leg0";

const keyFile = `${homedir()}/.near-credentials/hypernear-agent-test-leg0.key`;
if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const agentAddress = privateKeyToAddress(readFileSync(keyFile, "utf8").trim() as Hex).toLowerCase();

const legs: Record<string, Hex> = {};
for (const p of ["test/leg0", "test/leg1"]) legs[p] = await derivedEvmAddress(contractId, p);
const signed = await signApproveAgent(contractId, path, agentAddress, Date.now(), "leash-leg0");

console.log(JSON.stringify({
  note: "NOT submitted. POST exchangeRequest to https://api.hyperliquid-testnet.xyz/exchange once the master is funded. HL rejects stale nonces (~1 day): re-sign on ci32 with `node contract/scripts/sign-approve.mjs test/leg0 <agentAddress> <nonceMs> leash-leg0`.",
  network: "hyperliquid-testnet / near-testnet",
  hypernearContract: contractId,
  mpcContract: "v1.signer-prod.testnet",
  legs,
  agentAddress,
  agentName: "leash-leg0",
  agentKeyLocation: "ci32:~/.near-credentials/hypernear-agent-test-leg0.key",
  ...signed,
}, null, 2));

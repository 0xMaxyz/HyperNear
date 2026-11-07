// Re-sign HL testnet `approveAgent` for a leg on demand (HL wants a recent nonce). Does NOT submit.
// Run on ci32: node contract/scripts/sign-approve.mjs <path> <agentAddr> <nonceMs> [agentName]
// Shorthand for sign-action.mjs approveAgent; see there for output and $HYPERNEAR_CONTRACT.
import { signHlAction } from "./sign-action.mjs";

export async function signApproveAgent(contractId, path, agentAddr, nonce, agentName = "") {
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error(`bad nonce ${nonce}`);
  const out = await signHlAction(contractId, path, { type: "approveAgent", agentAddress: agentAddr.toLowerCase(), agentName, nonce });
  if (!agentName) delete out.exchangeRequest.action.agentName; // as the python SDK does for an unnamed agent (signed as "")
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, agentAddr, nonceMs, agentName] = process.argv.slice(2);
  if (!path || !agentAddr || !nonceMs) throw new Error("usage: node sign-approve.mjs <path> <agentAddr> <nonceMs> [agentName]");
  const contractId = process.env.HYPERNEAR_CONTRACT ?? "leash-spike-1107.testnet";
  console.log(JSON.stringify(await signApproveAgent(contractId, path, agentAddr, Number(nonceMs), agentName ?? ""), null, 2));
}

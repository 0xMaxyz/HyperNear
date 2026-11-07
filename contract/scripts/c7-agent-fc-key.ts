// C7: the agent calls `rebalance` with a FUNCTION-CALL access key (receiver = hypernear, methods = agent methods,
// so it cannot attach a deposit), and the MPC deposit is paid from the contract's balance.
// Run on ci32 after owner-smoke.ts (needs the test owner's legs 0/1): node c7-agent-fc-key.ts <hypernear-account.testnet>
// Creates agent.<hypernear> once; its ONLY key is that function-call key (secret in ~/.near-credentials, mode 600).
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { actions, KeyPairEd25519 } from "near-api-js";
import { privateKeyToAccount } from "viem/accounts";
import { accountFromKeychain, callSign, depositFlow, OWNER_DEPOSIT, provider, recover, RPC, tgas } from "./lib.ts";
import { ownerIntentTypedData } from "./owner-intents.mjs";
import { hlDigest } from "./gen-vectors.mjs";

const contractId = process.argv[2];
if (!contractId) throw new Error("usage: node c7-agent-fc-key.ts <hypernear-account>");
const agentId = `agent.${contractId}`;
const AGENT_METHODS = ["rebalance", "agent_usd_class_transfer"];
const near = accountFromKeychain(contractId);
const rpc = async (method: string, params: object) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as any;
};
const balance = async (id: string) =>
  BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: id })).result.amount);

const credFile = `${homedir()}/.near-credentials/testnet/${agentId}.json`;
if (!existsSync(credFile)) {
  const kp = KeyPairEd25519.fromRandom();
  const pub = kp.getPublicKey();
  writeFileSync(credFile, JSON.stringify({ account_id: agentId, public_key: pub.toString(), private_key: kp.toString() }), { mode: 0o600 });
  const res: any = await near.signAndSendTransaction({
    receiverId: agentId,
    actions: [
      actions.createAccount(),
      actions.transfer(2n * 10n ** 23n), // 0.2 NEAR for gas
      actions.addFunctionCallAccessKey(pub, contractId, AGENT_METHODS, 2n * 10n ** 23n),
    ],
  });
  console.log(`created ${agentId} (only key: function-call) tx ${res.transaction_outcome.id}`);
}

// Expect exactly one key on the agent account, FunctionCall-scoped to the hypernear contract.
const keys = (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: agentId })).result.keys;
console.log("agent keys:", JSON.stringify(keys.map((k: any) => ({ public_key: k.public_key, permission: k.access_key.permission }))));
const onlyFc = keys.length === 1 && keys[0].access_key.permission.FunctionCall?.receiver_id === contractId;

// The owner (public test key) sets this agent; the relayer (full-access key) pays any storage.
const acct = privateKeyToAccount("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
const owner = acct.address.toLowerCase();
const view = (method: string, args: object) => provider.callFunction<any>({ contractId, method, args });
const st = await view("get_owner", { owner });
const legs = [await view("get_leg", { owner, leg: 0 }), await view("get_leg", { owner, leg: 1 })];
if (!legs[0] || !legs[1]) throw new Error("run owner-smoke.ts first (legs 0/1 not registered)");
if (st?.agent !== agentId) {
  const cfg = await view("get_config", {});
  const intent = { type: "setPolicy", agent: agentId, dailyCap: "5", cooldownSec: 0 };
  const nonce = st?.nonce ?? 0;
  const signature = await acct.signTypedData(ownerIntentTypedData(cfg.chain_tag, contractId, owner, nonce, intent));
  const r = await callSign(near, contractId, "owner_execute", { owner, nonce, intent, signature }, OWNER_DEPOSIT);
  console.log(`setPolicy agent=${agentId} tx ${r.txHash}`);
}

const agent = accountFromKeychain(agentId); // signs with the function-call key
const hypernearBefore = await balance(contractId);
const time = Date.now();
// 100 TGas: a function-call key's allowance (0.2 NEAR) must cover prepaid gas at the pessimistic gas price
const r = await callSign(agent, contractId, "rebalance", { owner, from_leg: 0, to_address: legs[1], amount: "1", hl_time: time }, 0n, "100");
const digest = hlDigest("Testnet", { type: "usdSend", destination: legs[1], amount: "1", time });
const signer = (await recover(digest, r.out)).toLowerCase();
const flow = await depositFlow(r.txHash, agentId);
for (const row of flow) console.log(`  receipt: ${row}`);
const tx = (await rpc("EXPERIMENTAL_tx_status", { tx_hash: r.txHash, sender_account_id: agentId, wait_until: "FINAL" })).result.transaction;
const usedKey = keys.find((k: any) => k.public_key === tx.public_key);
const mpcFromContract = flow.some((x) => x.startsWith(`${contractId} -> v1.signer-prod.testnet sign deposit=1 yocto`));
const agentAttachedNothing = tx.actions.every((a: any) => a.FunctionCall && BigInt(a.FunctionCall.deposit) === 0n);
console.log(`rebalance tx ${r.txHash} signer=${tx.signer_id} key=${tx.public_key} permission=${JSON.stringify(usedKey?.access_key.permission)}`);
console.log(`gas ${tgas(r.gasBurnt)} TGas; hypernear balance delta ${(await balance(contractId)) - hypernearBefore} yocto (includes gas rewards)`);
const ok = onlyFc && !!usedKey?.access_key.permission.FunctionCall && mpcFromContract && agentAttachedNothing && signer === legs[0];
console.log(ok ? "C7 PASS" : `C7 FAIL onlyFc=${onlyFc} mpcFromContract=${mpcFromContract} agentAttachedNothing=${agentAttachedNothing} signerOk=${signer === legs[0]}`);
process.exit(ok ? 0 : 1);

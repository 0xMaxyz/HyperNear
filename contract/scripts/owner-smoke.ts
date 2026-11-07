// Live testnet smoke of the policy contract (owner intents, legs, agent rebalance). Signs, never submits to HL.
// Run on ci32: NEAR_NETWORK=testnet node owner-smoke.ts <hypernear-account.testnet>
// Owner = $HYPERNEAR_TEST_OWNER_KEY, or with NEAR_NETWORK=testnet the public test key (never fund it). Agent = the contract account.
import { privateKeyToAccount } from "viem/accounts";
import { accountFromKeychain, callSign, derivedEvmAddress, outcomeHeights, OWNER_DEPOSIT, provider, recover, REGISTER_LEG_DEPOSIT, tgas, testOwnerKey } from "./lib.ts";
import { ownerIntentTypedData } from "./owner-intents.mjs";
import { hlDigest } from "./gen-vectors.mjs";

const contractId = process.argv[2];
if (!contractId) throw new Error("usage: node owner-smoke.ts <hypernear-account>");
const acct = privateKeyToAccount(testOwnerKey());
const owner = acct.address.toLowerCase();
const near = accountFromKeychain(contractId);
const view = (method: string, args: object) => provider.callFunction<any>({ contractId, method, args });
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; console.log(`${ok ? "OK  " : "FAIL"} ${what}`); };
const expectFail = async (what: string, msg: string, f: () => Promise<unknown>) => {
  try { await f(); check(false, `${what} (expected "${msg}")`); }
  catch (e) { check(String((e as Error).message ?? e).includes(msg), `${what} rejected: ${msg}`); }
};

const cfg = await view("get_config", {});
console.log("config", JSON.stringify(cfg));

const legs: string[] = [];
for (const leg of [0, 1]) {
  const derived = await derivedEvmAddress(contractId, `${owner}/leg${leg}`);
  let addr = await view("get_leg", { owner, leg });
  if (!addr) {
    const r = await callSign(near, contractId, "register_leg", { owner, leg }, REGISTER_LEG_DEPOSIT);
    addr = r.out as unknown as string;
    console.log(`register_leg ${leg}: tx ${r.txHash} gas ${tgas(r.gasBurnt)} TGas`);
  }
  check(addr === derived, `leg${leg} ${addr} == MPC derived ${derived}`);
  legs.push(addr);
}

const execOwner = async (intent: any) => {
  const nonce = (await view("get_owner", { owner }))?.nonce ?? 0;
  const signature = await acct.signTypedData(ownerIntentTypedData(cfg.chain_tag, contractId, owner, nonce, intent));
  const r = await callSign(near, contractId, "owner_execute", { owner, nonce, intent, signature }, OWNER_DEPOSIT);
  return { ...r, nonce, signature };
};

const pol = await execOwner({ type: "setPolicy", agent: contractId, dailyCap: "1000", cooldownSec: 0 });
check(pol.out === null, `setPolicy tx ${pol.txHash} gas ${tgas(pol.gasBurnt)} TGas`);
await expectFail("replayed owner intent", "bad nonce", () => callSign(near, contractId, "owner_execute",
  { owner, nonce: pol.nonce, intent: { type: "setPolicy", agent: contractId, dailyCap: "1000", cooldownSec: 0 }, signature: pol.signature }));

const hlNonce = Date.now();
const uct = await execOwner({ type: "usdClassTransfer", leg: 0, amount: "1", toPerp: true, hlNonce });
const uctDigest = hlDigest("Testnet", { type: "usdClassTransfer", amount: "1", toPerp: true, nonce: hlNonce });
check(`0x${uct.out.payload}` === uctDigest && (await recover(uctDigest, uct.out)).toLowerCase() === legs[0],
  `owner usdClassTransfer signed by leg0, tx ${uct.txHash} gas ${tgas(uct.gasBurnt)} TGas ${uct.ms.toFixed(0)} ms`);

const time = Date.now();
const reb = await callSign(near, contractId, "rebalance", { owner, from_leg: 0, to_address: legs[1], amount: "1", hl_time: time });
const rebDigest = hlDigest("Testnet", { type: "usdSend", destination: legs[1], amount: "1", time });
check(`0x${reb.out.payload}` === rebDigest && (await recover(rebDigest, reb.out)).toLowerCase() === legs[0],
  `agent rebalance leg0->leg1 signed by leg0, tx ${reb.txHash} gas ${tgas(reb.gasBurnt)} TGas`);
await expectFail("rebalance over the daily cap", "daily cap exceeded", () =>
  callSign(near, contractId, "rebalance", { owner, from_leg: 0, to_address: legs[1], amount: "1000", hl_time: time + 1 }));
await expectFail("rebalance to a foreign address", "not a registered leg", () =>
  callSign(near, contractId, "rebalance", { owner, from_leg: 0, to_address: "0x75c450e9597b5ca41aa86b18f630f51278c350e3", amount: "1", hl_time: time + 2 }));

// Where the ~12 s goes: block heights of each receipt of the usdClassTransfer tx.
const hs = await outcomeHeights(uct.res);
console.log("latency breakdown (block heights):", hs.map((h) => `${h.executor}@${h.height}`).join(" "));

console.log(failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`);
process.exit(failures ? 1 : 0);

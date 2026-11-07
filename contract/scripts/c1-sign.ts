// C1 + C14 + C6 (NEAR side). Run on ci32: node c1-sign.ts <hypernear-account.testnet> [runs=10]
// C1: sign_raw on a known digest; the recovered signer must equal the MPC-derived EVM address.
// C14: gas burnt, deposit charged, sign + callback inside one tx. C6: latency p50/p95.
import { keccak256, toHex, type Hex } from "viem";
import { accountFromKeychain, callSign, depositFlow, derivedEvmAddress, outcomeHeights, pct, recover, RPC, tgas, toRsv } from "./lib.ts";

const contractId = process.argv[2];
const runs = Number(process.argv[3] ?? 10);
if (!contractId) throw new Error("usage: node c1-sign.ts <hypernear-account> [runs]");
const path = "test/c1";
const account = accountFromKeychain(contractId); // admin == contract account in the spike

const expected = await derivedEvmAddress(contractId, path);
console.log(`derived (MPC view) ${path}: ${expected}`);

const lat: number[] = [];
const chain: number[] = []; // first block of the tx -> block of the last receipt (on_signed / refunds)
let failures = 0;
for (let i = 0; i < runs; i++) {
  const digest: Hex = keccak256(toHex(`hypernear C1 known digest #${i}`));
  try {
    const r = await callSign(account, contractId, "sign_raw", { path, payload: digest.slice(2) });
    const signer = await recover(digest, r.out);
    const { lowS } = toRsv(r.out);
    const ok = signer.toLowerCase() === expected.toLowerCase() && r.out.payload === digest.slice(2);
    if (!ok) failures++;
    lat.push(r.ms);
    const hs = await outcomeHeights(r.res);
    const span = Math.max(...hs.map((h) => h.ms)) - Math.min(...hs.map((h) => h.ms));
    chain.push(span);
    console.log(`run ${i}: ${ok ? "C1 OK" : "C1 MISMATCH"} tx=${r.txHash} ms=${r.ms.toFixed(0)} gas=${tgas(r.gasBurnt)}TGas ` +
      `chain=${span}ms blocks=${Math.max(...hs.map((h) => h.height)) - Math.min(...hs.map((h) => h.height))} cost=${r.tokensBurnt}yocto receipts=${r.receipts} lowS=${lowS} signer=${signer}`);
    if (i === 0) for (const row of await depositFlow(r.txHash, contractId)) console.log(`  receipt: ${row}`);
  } catch (e) {
    failures++;
    console.log(`run ${i}: ERROR ${(e as Error).message}`);
  }
}
console.log(`C6 sign_raw latency submit->EXECUTED_OPTIMISTIC over ${lat.length} runs: ` +
  `p50=${pct(lat, 50).toFixed(0)}ms p95=${pct(lat, 95).toFixed(0)}ms min=${Math.min(...lat).toFixed(0)} max=${Math.max(...lat).toFixed(0)}`);
console.log(`on-chain span (tx block -> last receipt block): p50=${pct(chain, 50)}ms p95=${pct(chain, 95)}ms; RPC ${RPC}`);
console.log(failures === 0 ? "C1 PASS" : `C1 FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);

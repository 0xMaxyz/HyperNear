// T0 spike: gas of one on-chain dstack (TDX) attestation verification. Run on ci32 against a contract built with
// `--features tee`: node tee-verify-gas.ts <account.testnet> <ppid-hex>
// Sends tee_verify_spike with the recorded fixture (contract/tests/tee/attestation.json) and prints gas burnt.
import { readFileSync } from "node:fs";
import { accountFromKeychain, tgas } from "./lib.ts";
import { teraToGas } from "near-api-js";

const [contractId, ppid] = process.argv.slice(2);
if (!contractId || !ppid) throw new Error("usage: node tee-verify-gas.ts <account.testnet> <ppid-hex>");
const att = JSON.parse(readFileSync(new URL("../tests/tee/attestation.json", import.meta.url), "utf8"));
const quote = Uint8Array.from(att.quote as number[]);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const t = att.tcb_info;
const measurements = {
  rtmrs: { mrtd: t.mrtd, rtmr0: t.rtmr0, rtmr1: t.rtmr1, rtmr2: t.rtmr2 },
  key_provider_event_digest: t.event_log.find((e: { event: string }) => e.event === "key-provider").digest,
  app_compose_hash_payload: t.compose_hash,
};
const args = { attestation: att, report_data: hex(quote.slice(568, 632)), measurements, ppid, ts_sec: 1_786_622_400 };
const argBytes = Buffer.byteLength(JSON.stringify(args));
const account = accountFromKeychain(contractId);
const t0 = performance.now();
const res: any = await account.callFunctionRaw({ contractId, methodName: "tee_verify_spike", args, gas: teraToGas("300"), deposit: 0n, waitUntil: "EXECUTED_OPTIMISTIC" });
const ms = performance.now() - t0;
const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
const gasBurnt = outcomes.reduce((a: bigint, o: any) => a + BigInt(o.outcome.gas_burnt), 0n);
const fnGas = BigInt(res.receipts_outcome[0].outcome.gas_burnt);
const ok = res.status?.SuccessValue !== undefined;
const value = ok ? JSON.parse(Buffer.from(res.status.SuccessValue, "base64").toString() || "null") : res.status;
console.log(JSON.stringify({ contractId, tx: res.transaction_outcome.id, ok, argBytes, ms: Math.round(ms), gasBurntTotalTgas: tgas(gasBurnt), functionCallReceiptTgas: tgas(fnGas), value }, null, 2));

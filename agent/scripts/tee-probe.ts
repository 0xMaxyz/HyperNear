// TEE probe: what does shade-agent-js hand us here? Prints the agent's NEAR account, whether the quote is real, and the
// shape of the attestation (field names and sizes, never values of anything secret). Never reads or prints private keys.
//   node agent/scripts/tee-probe.ts          (plain: no /var/run/dstack.sock, so shade-agent-js returns its fake attestation)
// shade-agent-js looks for the socket at exactly /var/run/dstack.sock (real CVM, or the dstack simulator mounted there).
import { ShadeClient } from "@neardefi/shade-agent-js";

const network = (process.env.NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";
const client = await ShadeClient.create({
  networkId: network,
  agentContractId: process.env.NEAR_CONTRACT_ID ?? "leash-spike-1107.testnet",
});
console.log("account id        :", client.accountId());

const att = await client.getAttestation();
const quoteBytes = att.quote.length;
console.log("quote bytes       :", quoteBytes, quoteBytes > 0 ? "(REAL quote)" : "(EMPTY: fake attestation, no TEE)");
console.log("attestation keys  :", Object.keys(att).join(", "));
console.log("collateral fields :", Object.entries(att.collateral).map(([k, v]) => `${k}(${String(v).length})`).join(", "));
const t = att.tcb_info;
console.log("tcb_info keys     :", Object.keys(t).join(", "));
for (const k of ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "os_image_hash", "compose_hash", "device_id"] as const) {
  const v = String(t[k] ?? "");
  console.log(`  ${k.padEnd(14)}:`, v ? `${v.slice(0, 16)}...(${v.length} hex)` : "(empty)", /^0*$/.test(v) ? "ZERO" : "");
}
console.log("  event_log       :", t.event_log?.length ?? 0, "events;", (t.event_log ?? []).map((e) => e.event).filter(Boolean).slice(0, 8).join(", "));
console.log("  app_compose     :", String(t.app_compose ?? "").length, "chars");

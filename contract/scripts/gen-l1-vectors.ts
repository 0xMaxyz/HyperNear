// Test vectors for Hyperliquid L1 `cancel` signing (phantom agent), computed with packages/core's hashHlL1Action
// (the HL SDK's msgpack + keccak) and viem's hashTypedData. Mirrors src/l1.rs.
// Usage (ci32, after `pnpm --filter @perps-platform/core build`): node gen-l1-vectors.ts > ../tests/vectors/l1_cancel.json
import { hashTypedData, zeroAddress, type Hex } from "viem";
import { hashHlL1Action } from "../../packages/core/dist/index.js";

type Cancel = { a: number; o: number };

function l1(cancels: Cancel[], nonce: number, mainnet: boolean) {
  const action = { type: "cancel", cancels };
  const connectionId = hashHlL1Action({ action, nonce }) as Hex;
  const digest = hashTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId },
  });
  return { action, nonce, mainnet, connectionId, digest };
}

const many = (n: number): Cancel[] => Array.from({ length: n }, (_, i) => ({ a: i * 37, o: 64_820_881_296 + i }));
const NONCE = 1_794_134_049_350;

const out = {
  exchangeDomain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
  // msgpack integer widths: fixint (<128), uint8, uint16, uint32, uint64; array: fixarray (<16), array16 (16)
  cases: [
    l1([{ a: 3, o: 64_820_881_296 }], NONCE, false), // fixint a, uint64 o
    l1([{ a: 3, o: 64_820_881_296 }], NONCE, true), // same action, mainnet source "a"
    l1([{ a: 0, o: 0 }], 1, false), // zeros
    l1([{ a: 127, o: 127 }], NONCE, false), // fixint edge
    l1([{ a: 200, o: 255 }], NONCE, false), // uint8
    l1([{ a: 10_000, o: 65_535 }], NONCE, false), // uint16 (spot asset ids are 10000+)
    l1([{ a: 110_000, o: 4_294_967_295 }], NONCE, false), // uint32
    l1([{ a: 4, o: 4_294_967_296 }], NONCE, false), // uint64 lower edge
    l1(many(15), NONCE, true), // fixarray edge
    l1(many(16), NONCE, false), // array16, the per-call cap
  ],
  // the digest HL testnet accepted in the C20 spike (validation/results/C20.json): not SDK self-consistency
  hlAccepted: {
    action: { type: "cancel", cancels: [{ a: 3, o: 64_820_881_296 }] },
    nonce: NONCE,
    mainnet: false,
    connectionId: "0xb5b293e03b88b94998a19e937efdc659f139974c5a14f19c449f4bc7da44e4c0",
    digest: "0xa705918097339c705d7a7c284de10921704680f9a060c1f609476e617bbf1ae4",
  },
};
const recomputed = l1(out.hlAccepted.action.cancels, NONCE, false);
if (recomputed.digest !== out.hlAccepted.digest) throw new Error("SDK digest differs from the one HL accepted in C20");
console.log(JSON.stringify(out, null, 2));

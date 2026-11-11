// The spec hash an owner signs inside a Command (startStrategy, placeOrder, cancelOrder): sha256 of the spec's canonical JSON.
// One implementation for the agent and the browser, so the two can never disagree about what was signed.
import { sha256, toBytes, type Hex } from 'viem';

/** Canonical JSON: object keys sorted at every level, so the hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 0x + 64 hex: sha256 of the canonical JSON. */
export function specHashOfJson(spec: unknown): Hex {
  return sha256(toBytes(canonicalJson(spec)));
}

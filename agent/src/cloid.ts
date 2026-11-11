// The client order id is the journal: every order the agent places carries a 16-byte cloid that says what it was for, so fills can be
// labelled later from Hyperliquid's own data (works in TEE mode too, where nothing is written to disk).
// Layout: 0x 4c48 ("LH") | kind (1 byte) | group (5 bytes, shared by the orders of one action, e.g. both hedge legs) | random (8 bytes).
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';

export const CLOID_KINDS = { open: 1, reduce: 2, protect: 3, hedgeOpen: 4, hedgeClose: 5, strategy: 6 } as const;
export type CloidKind = keyof typeof CLOID_KINDS;

const PREFIX = '4c48';
const KIND_BY_ID = Object.fromEntries(Object.entries(CLOID_KINDS).map(([k, v]) => [v, k])) as Record<number, CloidKind>;

/** A fresh group id (5 random bytes, hex): pass the same one to every order of one action. */
export const newGroup = () => randomBytes(5).toString('hex');

export function makeCloid(kind: CloidKind, group: string = newGroup()): Hex {
  if (!/^[0-9a-f]{10}$/.test(group)) throw new Error('cloid group must be 10 hex chars');
  return `0x${PREFIX}${CLOID_KINDS[kind].toString(16).padStart(2, '0')}${group}${randomBytes(8).toString('hex')}`;
}

/** Undefined for a cloid we did not make (an order placed from another tool or the HL site). */
export function parseCloid(c: string | null | undefined): { kind: CloidKind; group: string } | undefined {
  const m = /^0x4c48([0-9a-f]{2})([0-9a-f]{10})[0-9a-f]{16}$/.exec((c ?? '').toLowerCase());
  const kind = m && KIND_BY_ID[parseInt(m[1]!, 16)];
  return kind ? { kind, group: m![2]! } : undefined;
}

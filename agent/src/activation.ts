// Hyperliquid's 1 USDC new-account activation fee, which lands in one of two places:
//   owed-on-credit      userRole 'missing' (never seen): the next credit to it loses 1 (testnet C10: send 20, credited 19). Whoever sends adds 1.
//   owed-on-first-send  seen, but it has not yet made a transfer to another address: that first transfer costs the SENDER 1 on top
//                       (mainnet: fee "1.0" feeToken USDC on the first outgoing send, the destination got the full amount;
//                       a funded account's userRole is already 'user', so only its ledger tells). Its spendable USDC is withdrawable - 1.
//   paid                neither is owed; cannot revert, so it is cached for good.
import type { HlClient } from '@perps-platform/core';

export type Activation = 'paid' | 'owed-on-credit' | 'owed-on-first-send';

type Hl = Pick<HlClient, 'userRole' | 'userNonFundingLedgerUpdates'>;

const paid = new WeakMap<object, Set<string>>(); // per client: only 'paid' is kept forever
const owedAt = new WeakMap<object, Map<string, number>>(); // owed-on-first-send, kept 30 s so a leg that never sends is not re-scanned every tick
const OWED_TTL_MS = 30_000;

/**
 * A ledger row that shows the account paid its activation: a withdrawal or an outgoing transfer to another address (a self-send to
 * another dex does not count). A credit row with fee 1.0 does NOT: on mainnet that row also sits in the receiver's ledger but the
 * sender paid it. shortcut: a testnet account credited net of the fee (C10) reads as owed-on-first-send until it sends, so we
 * reserve 1 USDC there that was already taken; drop this if testnet exactness ever matters.
 */
export function paysActivation(addr: string, delta: Record<string, unknown>): boolean {
  const user = typeof delta.user === 'string' ? delta.user.toLowerCase() : undefined;
  const dest = typeof delta.destination === 'string' ? delta.destination.toLowerCase() : undefined;
  if (delta.type === 'withdraw') return true;
  return user === addr && dest !== undefined && dest !== addr;
}

export async function activationStatus(hl: Hl, address: string, now = Date.now()): Promise<Activation> {
  const a = address.toLowerCase();
  const done = paid.get(hl) ?? paid.set(hl, new Set()).get(hl)!;
  if (done.has(a)) return 'paid';
  const owed = owedAt.get(hl) ?? owedAt.set(hl, new Map()).get(hl)!;
  if (now - (owed.get(a) ?? -Infinity) < OWED_TTL_MS) return 'owed-on-first-send';
  // an RPC error assumes the worst for amounts that must land in full: new account, then a first send still to come
  const role = await hl.userRole({ user: a as `0x${string}` }).catch(() => undefined);
  if (!role || role.role === 'missing') return 'owed-on-credit';
  const rows = await hl.userNonFundingLedgerUpdates({ user: a as `0x${string}`, startTime: 0 }).catch(() => undefined);
  if (rows?.some((r) => paysActivation(a, r.delta as Record<string, unknown>))) {
    done.add(a);
    return 'paid';
  }
  if (rows) owed.set(a, now);
  return 'owed-on-first-send';
}

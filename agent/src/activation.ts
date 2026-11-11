// Hyperliquid's 1 USDC new-account activation fee. Who pays depends on how the account was first credited (skill: hyperliquid-account-activation):
//   HyperCore send to a never-seen account   the SENDER pays it: that transfer's ledger row carries fee 1.0, and the receiver owes nothing later.
//                                            Measured on testnet 2026-11-11: send 25 -> fee 1.0, the leg holds ~24, and its first send out (to an
//                                            existing account) carries fee 0.0. The mainnet owner reports the same ("sender pays, receiver never").
//   HyperEVM / bridge credit (no fee row)    nobody pays at the credit; the account pays 1.0 on its first transfer out or withdraw
//                                            (mainnet ledgers in tests/fixtures/activation-ledgers.json: first outgoing send fee 1.0).
// Statuses:
//   owed-on-credit      userRole 'missing' (never seen): the next credit to it carries the fee (testnet: taken from what arrives).
//   owed-on-first-send  seen, activated without a fee row, and it has not yet sent out: its first transfer costs it 1. Spendable USDC is withdrawable - 1.
//   paid                nothing is owed (activated by a fee-carrying HyperCore credit, or it already paid); cannot revert, so it is cached for good.
import type { HlClient } from '@perps-platform/core';

export type Activation = 'paid' | 'owed-on-credit' | 'owed-on-first-send';

type Hl = Pick<HlClient, 'userRole' | 'userNonFundingLedgerUpdates'>;

const paid = new WeakMap<object, Set<string>>(); // per client: only 'paid' is kept forever
const owedAt = new WeakMap<object, Map<string, number>>(); // owed-on-first-send, kept 30 s so a leg that never sends is not re-scanned every tick
const OWED_TTL_MS = 30_000;

/**
 * A ledger row that shows the account paid its own activation: a withdrawal or an outgoing transfer to another address (a self-send to
 * another dex does not count). A later credit row carrying fee 1.0 does NOT: that is the SENDER's first-send fee (mainnet account B received one
 * while already active). Only the account's FIRST row can be its activation: see `activatedByCredit`.
 */
export function paysActivation(addr: string, delta: Record<string, unknown>): boolean {
  const user = typeof delta.user === 'string' ? delta.user.toLowerCase() : undefined;
  const dest = typeof delta.destination === 'string' ? delta.destination.toLowerCase() : undefined;
  if (delta.type === 'withdraw') return true;
  return user === addr && dest !== undefined && dest !== addr;
}

/** The account's first ledger row is a credit that carried the 1 USDC fee: a HyperCore send to a never-seen account, paid by the sender. */
export function activatedByCredit(addr: string, rows: { time: number; delta: unknown }[]): { fee: number } | undefined {
  const first = [...rows].sort((x, y) => x.time - y.time)[0]?.delta as Record<string, unknown> | undefined;
  const dest = typeof first?.destination === 'string' ? first.destination.toLowerCase() : undefined;
  const fee = Number(first?.fee ?? 0);
  return dest === addr.toLowerCase() && fee > 0 ? { fee } : undefined;
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
  if (rows && (activatedByCredit(a, rows) || rows.some((r) => paysActivation(a, r.delta as Record<string, unknown>)))) {
    done.add(a);
    return 'paid';
  }
  if (rows) owed.set(a, now);
  return 'owed-on-first-send';
}

/**
 * The deposit history: Hyperliquid's ledger and this platform's own exchange
 * rows, in one list.
 *
 * The history tab rendered only the ledger, so a user who deposited from an
 * exchange saw — at best — a bridge credit with no connection to the request
 * they had opened, and while the deposit was still crossing, nothing at all.
 * Their tracker lived inside a flow they had already left.
 *
 * The properties worth holding are about honesty rather than layout:
 *
 *  1. Nothing is dropped. A row with an unreadable timestamp sorts last; it
 *     does not disappear.
 *  2. A deposit sits at `createdAt`, not `updatedAt` — otherwise polling moves
 *     it to the top of the list and it reads as a new deposit each time.
 *  3. [#1083] The two records of one completed deposit are ONE row — but only
 *     where they can be matched without guessing. The join's whole value is in
 *     what it refuses: same amount with no recorded delivery time, two deposits
 *     a human could not tell apart, an incoming transfer that merely happens to
 *     match. Each of those leaves both rows standing.
 */
import { describe, expect, it } from 'vitest';

import {
  filterDepositHistory,
  isCexDepositEntry,
  mergeDepositHistory,
  type CexDepositHistoryInput,
  type HlLedgerUpdate,
} from '../../src/index';

const ACCOUNT = '0x0000008398d108F4DC04d84518F3B4eC5E4A86C5';
const CTX = { network: 'mainnet' as const, account: ACCOUNT };

const at = (iso: string) => Date.parse(iso);

function ledgerEntry(iso: string, delta: Record<string, unknown>): HlLedgerUpdate {
  return { time: at(iso), hash: `0x${iso.replace(/\D/g, '')}`, delta } as HlLedgerUpdate;
}

function deposit(overrides: Partial<CexDepositHistoryInput> = {}): CexDepositHistoryInput {
  return {
    id: 'dep-1',
    route: 'B',
    phase: 'routing',
    amount: '100',
    asset: 'USDT',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:05:00.000Z',
    ...overrides,
  };
}

describe('the deposit history merges both sources, newest first', () => {
  it('interleaves exchange rows with ledger rows by time', () => {
    const merged = mergeDepositHistory({
      ledger: [
        ledgerEntry('2026-08-10T09:00:00.000Z', { type: 'deposit', usdc: '250' }),
        ledgerEntry('2026-08-10T11:00:00.000Z', { type: 'deposit', usdc: '75' }),
      ],
      cexDeposits: [deposit()],
      ctx: CTX,
    });

    expect(merged.map((row) => row.source)).toEqual(['hyperliquid', 'cex', 'hyperliquid']);
    expect(merged.map((row) => row.time)).toEqual([
      at('2026-08-10T11:00:00.000Z'),
      at('2026-08-10T10:00:00.000Z'),
      at('2026-08-10T09:00:00.000Z'),
    ]);
  });

  it('places a deposit where it was opened, not where it was last polled', () => {
    // `updatedAt` moves on every poll. Sorting on it would lift the row to the
    // top of the list each time, which reads as a second deposit.
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T23:00:00.000Z', { type: 'deposit', usdc: '10' })],
      cexDeposits: [deposit({ createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-11T08:00:00.000Z' })],
      ctx: CTX,
    });
    expect(merged[0]?.source).toBe('hyperliquid');
  });

  it('keeps a row whose timestamp cannot be read, at the end', () => {
    const merged = mergeDepositHistory({
      ledger: [],
      cexDeposits: [deposit({ id: 'unreadable', createdAt: 'not-a-date' }), deposit({ id: 'fine' })],
      ctx: CTX,
    });
    // A money history may render a row in the wrong place. It may never omit one.
    expect(merged.map((row) => (isCexDepositEntry(row) ? row.id : ''))).toEqual(['fine', 'unreadable']);
  });

  it('carries what a user needs to recognise the row, and no internal detail', () => {
    const [row] = mergeDepositHistory({
      ledger: [],
      cexDeposits: [
        deposit({ phase: 'arrived', deliveredAmount: '98.79', route: 'A' }),
      ],
      ctx: CTX,
    });
    expect(row && isCexDepositEntry(row) ? row : null).toMatchObject({
      id: 'dep-1',
      route: 'A',
      phase: 'arrived',
      amount: '100',
      asset: 'USDT',
      deliveredAmount: '98.79',
    });
    // No address, no transaction hash, no escrow: the exchange payload carries
    // none and this must not invent a place to put one.
    expect(JSON.stringify(row)).not.toMatch(/0x[0-9a-f]{20}/i);
  });

  it('joins the two ends of one completed deposit into one row, keeping both references', () => {
    // The credit is money in the account; the request is what the user opened.
    // Hyperliquid calls the credit "Credited from HyperEVM" because that is how
    // the terminal leg lands — both are true, and the user should see one thing.
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T10:06:00.000Z', { type: 'deposit', usdc: '98.79' })],
      cexDeposits: [
        deposit({
          phase: 'arrived',
          deliveredAmount: '98.79',
          deliveredAt: '2026-08-10T10:12:00.000Z',
        }),
      ],
      ctx: CTX,
    });
    expect(merged).toHaveLength(1);
    const [row] = merged;
    expect(row && isCexDepositEntry(row)).toBe(true);
    // Both references survive: the request id for support, and the ledger's
    // transaction hash for the chain. Hiding the ledger row would lose the
    // second, which is the one fact the deposit payload cannot supply.
    expect(row && isCexDepositEntry(row) ? row.id : null).toBe('dep-1');
    expect(row && isCexDepositEntry(row) ? row.ledger?.hash : null).toBeTruthy();
    expect(row && isCexDepositEntry(row) ? row.ledger?.kind : null).toBe('bridge-deposit');
  });

  it('refuses the join when the rail recorded no delivery time', () => {
    // Amount alone is not identifying — the reported history held three rows of
    // `3 USDT` — so a match needs the time anchor too. Without it both rows
    // stand, which is the honest answer.
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T10:06:00.000Z', { type: 'deposit', usdc: '98.79' })],
      cexDeposits: [deposit({ phase: 'arrived', deliveredAmount: '98.79' })],
      ctx: CTX,
    });
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((row) => row.source))).toEqual(new Set(['hyperliquid', 'cex']));
  });

  it('refuses the join when two deposits are indistinguishable', () => {
    // Exactly the case a guess gets wrong: two deposits of the same amount, in
    // the same window, and one credit. Attaching a transaction hash to the
    // wrong one is worse than showing three rows.
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T10:06:00.000Z', { type: 'deposit', usdc: '3' })],
      cexDeposits: [
        deposit({
          id: 'twin-a',
          phase: 'arrived',
          deliveredAmount: '3',
          deliveredAt: '2026-08-10T10:07:00.000Z',
        }),
        deposit({
          id: 'twin-b',
          phase: 'arrived',
          deliveredAmount: '3',
          deliveredAt: '2026-08-10T10:08:00.000Z',
        }),
      ],
      ctx: CTX,
    });
    expect(merged).toHaveLength(3);
    expect(
      merged.filter(isCexDepositEntry).every((row) => row.ledger === null),
    ).toBe(true);
  });

  it('refuses the join when the credit is outside the delivery window', () => {
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T04:00:00.000Z', { type: 'deposit', usdc: '98.79' })],
      cexDeposits: [
        deposit({
          phase: 'arrived',
          deliveredAmount: '98.79',
          deliveredAt: '2026-08-10T10:12:00.000Z',
        }),
      ],
      ctx: CTX,
    });
    expect(merged).toHaveLength(2);
  });

  it('never joins an incoming transfer from another account', () => {
    // A same-amount transfer in the same window is not how this rail delivers,
    // and admitting it would let one swallow a real deposit's ledger row.
    const merged = mergeDepositHistory({
      ledger: [
        ledgerEntry('2026-08-10T10:06:00.000Z', {
          type: 'internalTransfer',
          usdc: '98.79',
          user: '0x1111111111111111111111111111111111111111',
          destination: ACCOUNT,
        }),
      ],
      cexDeposits: [
        deposit({
          phase: 'arrived',
          deliveredAmount: '98.79',
          deliveredAt: '2026-08-10T10:12:00.000Z',
        }),
      ],
      ctx: CTX,
    });
    expect(merged).toHaveLength(2);
  });

  it('never joins a deposit that has not arrived', () => {
    const merged = mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T10:06:00.000Z', { type: 'deposit', usdc: '98.79' })],
      cexDeposits: [
        deposit({
          phase: 'routing',
          deliveredAmount: '98.79',
          deliveredAt: '2026-08-10T10:12:00.000Z',
        }),
      ],
      ctx: CTX,
    });
    expect(merged).toHaveLength(2);
  });
});

describe('filtering the deposit history', () => {
  const merged = () =>
    mergeDepositHistory({
      ledger: [ledgerEntry('2026-08-10T09:00:00.000Z', { type: 'deposit', usdc: '250' })],
      cexDeposits: [
        deposit({ id: 'b-routing', route: 'B', phase: 'routing' }),
        deposit({ id: 'a-arrived', route: 'A', phase: 'arrived' }),
        deposit({ id: 'b-attention', route: 'B', phase: 'attention' }),
      ],
      ctx: CTX,
    });

  it('returns everything when nothing is asked', () => {
    expect(filterDepositHistory(merged())).toHaveLength(4);
    expect(filterDepositHistory(merged(), { source: 'all' })).toHaveLength(4);
  });

  it('separates the two sources', () => {
    expect(filterDepositHistory(merged(), { source: 'hyperliquid' })).toHaveLength(1);
    expect(filterDepositHistory(merged(), { source: 'cex' })).toHaveLength(3);
  });

  it('narrows by route and by phase', () => {
    const byRoute = filterDepositHistory(merged(), { route: 'B' });
    expect(byRoute.map((row) => (isCexDepositEntry(row) ? row.id : ''))).toEqual([
      'b-routing',
      'b-attention',
    ]);
    const byPhase = filterDepositHistory(merged(), { phase: 'arrived' });
    expect(byPhase.map((row) => (isCexDepositEntry(row) ? row.id : ''))).toEqual(['a-arrived']);
  });

  it('drops the ledger when asked a question only an exchange row can answer', () => {
    // Rather than leaving Hyperliquid rows in a list filtered to "Route A",
    // where they would look like routed deposits.
    for (const filter of [{ route: 'A' as const }, { phase: 'arrived' as const }]) {
      expect(filterDepositHistory(merged(), filter).every(isCexDepositEntry)).toBe(true);
    }
  });
});

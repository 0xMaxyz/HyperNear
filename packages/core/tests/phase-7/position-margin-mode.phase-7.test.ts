/**
 * [#825] Phase 7 · Epic 7.11 — the clearinghouse summary carries the position's
 * margin mode.
 *
 * `leverageToString` flattened `{ type, value }` down to the scalar, which threw
 * away the cross/isolated discriminant Hyperliquid actually sends. Nothing
 * downstream could tell the two apart, so the positions row offered an
 * isolated-margin adjustment on cross positions — an action the exchange always
 * refuses, and exactly what the third testnet walk hit.
 *
 * Also pins Hyperliquid's initial leverage, which the order ticket has to assume
 * for any market the account holds no position in. Assuming the market ceiling
 * instead was the second half of the bug: "Max" on a 40x market produced an
 * order four times the size the balance supported.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HL_DEFAULT_LEVERAGE,
  SdkManager,
  effectiveDefaultLeverage,
  fetchClearinghouseSummary,
} from '../../src';
import type { HlClientLike } from '../../src';

const USER = '0x1111111111111111111111111111111111111111';

/** `leverage` is deliberately `unknown`: the wire form varies (typed object or
 * bare scalar) and the mapper has to cope with both. */
function createMockSdkManager(leverage: unknown, opts: { maxLeverage?: unknown; omitMaxLeverage?: boolean } = {}) {
  const maxLeverage = opts.maxLeverage ?? 40;
  const hlClient = {
    network: 'mainnet' as const,
    clearinghouseState: vi.fn(async () => ({
      marginSummary: {
        accountValue: '1000',
        totalMarginUsed: '100',
        totalNtlPos: '0',
        totalRawUsd: '0',
      },
      crossMarginSummary: {
        accountValue: '1000',
        totalMarginUsed: '100',
        totalNtlPos: '0',
        totalRawUsd: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '900',
      assetPositions: [
        {
          type: 'oneWay' as const,
          position: {
            coin: 'BTC',
            szi: '0.5',
            entryPx: '60000',
            unrealizedPnl: '50',
            leverage,
            ...(opts.omitMaxLeverage ? {} : { maxLeverage }),
            marginUsed: '3000',
            liquidationPx: '54000',
            positionValue: '0',
            returnOnEquity: '0',
            cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
          },
        },
      ],
      time: 0,
    })),
  };
  return new SdkManager({ hlClientFactory: () => hlClient as unknown as HlClientLike });
}

describe('[#825] the summary carries each position’s margin mode', () => {
  it('reports a cross position as cross', async () => {
    const summary = await fetchClearinghouseSummary(
      createMockSdkManager({ type: 'cross', value: 10 }),
      USER
    );
    expect(summary!.positions[0].marginMode).toBe('cross');
    // The scalar the rest of the UI already reads is unchanged.
    expect(summary!.positions[0].leverage).toBe('10');
  });

  it('reports an isolated position as isolated', async () => {
    const summary = await fetchClearinghouseSummary(
      createMockSdkManager({ type: 'isolated', value: 4, rawUsd: '250' }),
      USER
    );
    expect(summary!.positions[0].marginMode).toBe('isolated');
    expect(summary!.positions[0].leverage).toBe('4');
  });

  // A bare scalar carries no type. Guessing "cross" here would put the margin
  // affordance back on rows that cannot use it — unknown must stay unknown.
  it('reports null for the bare-scalar leverage form rather than guessing cross', async () => {
    const summary = await fetchClearinghouseSummary(createMockSdkManager(7), USER);
    expect(summary!.positions[0].marginMode).toBeNull();
    expect(summary!.positions[0].leverage).toBe('7');
  });

  it('reports null for an unrecognized leverage type', async () => {
    const summary = await fetchClearinghouseSummary(
      createMockSdkManager({ type: 'somethingElse', value: 3 }),
      USER
    );
    expect(summary!.positions[0].marginMode).toBeNull();
  });

  it('carries the position’s own maxLeverage through', async () => {
    const summary = await fetchClearinghouseSummary(
      createMockSdkManager({ type: 'cross', value: 10 }, { maxLeverage: 25 }),
      USER
    );
    expect(summary!.positions[0].maxLeverage).toBe(25);
  });

  it('leaves maxLeverage undefined when the payload omits it', async () => {
    const summary = await fetchClearinghouseSummary(
      createMockSdkManager({ type: 'cross', value: 10 }, { omitMaxLeverage: true }),
      USER
    );
    expect(summary!.positions[0].maxLeverage).toBeUndefined();
  });
});

describe('[#825] the leverage a market defaults to', () => {
  it('is 10x — Hyperliquid’s initial value, not the market ceiling', () => {
    expect(HL_DEFAULT_LEVERAGE).toBe(10);
    expect(effectiveDefaultLeverage(40)).toBe(10);
    expect(effectiveDefaultLeverage(50)).toBe(10);
  });

  it('clamps down to a market that allows less', () => {
    expect(effectiveDefaultLeverage(3)).toBe(3);
    expect(effectiveDefaultLeverage(1)).toBe(1);
  });

  it('never returns something unusable for a nonsense ceiling', () => {
    expect(effectiveDefaultLeverage(0)).toBe(1);
    expect(effectiveDefaultLeverage(-5)).toBe(1);
    expect(effectiveDefaultLeverage(Number.NaN)).toBe(1);
  });
});

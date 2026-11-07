/**
 * [#585] Phase 7 · Epic 7.1 · Task 7.1.5 — realtime funding-rate updates +
 * liquidation warnings over the WS fan-out gateway.
 *
 * The backend half: the clearinghouse summary the fan-out gateway's account
 * path serves (`/account/summary`, driven by userFills through the gateway) now
 * carries the per-position `liquidationPx` + `marginUsed` the UI needs to
 * populate a real liquidation distance — never the hardcoded `0` it stubbed
 * before — and the venue-neutral risk derivation those figures feed. Funding
 * stays REST-polled through `metaAndAssetCtxs`; this suite pins the freshness
 * SLA that decision rides on.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FUNDING_MAX_AGE_MS,
  LIQUIDATION_WARNING_THRESHOLD_PERCENT,
  SdkManager,
  fetchClearinghouseSummary,
  isNearLiquidation,
  liquidationDistancePercent,
  type HlClientLike,
} from '../../src/index';

const USER = '0x1234567890123456789012345678901234567890';

interface PositionOverrides {
  liquidationPx?: string | null;
  marginUsed?: string;
  /** Drop `marginUsed` from the venue payload entirely, to prove the default. */
  omitMarginUsed?: boolean;
}

function createMockHlClient(overrides?: PositionOverrides) {
  const position: Record<string, unknown> = {
    coin: 'BTC',
    szi: '0.5',
    entryPx: '60000',
    unrealizedPnl: '50',
    leverage: { type: 'cross' as const, value: 10 },
    positionValue: '0',
    returnOnEquity: '0',
    liquidationPx: overrides?.liquidationPx === undefined ? '54000' : overrides.liquidationPx,
    maxLeverage: 50,
    cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
  };
  if (!overrides?.omitMarginUsed) {
    position.marginUsed = overrides?.marginUsed ?? '3000';
  }
  return {
    network: 'mainnet' as const,
    clearinghouseState: vi.fn(async () => ({
      marginSummary: { accountValue: '1000', totalMarginUsed: '100', totalNtlPos: '0', totalRawUsd: '0' },
      crossMarginSummary: { accountValue: '1000', totalMarginUsed: '100', totalNtlPos: '0', totalRawUsd: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '900',
      assetPositions: [{ type: 'oneWay' as const, position }],
      time: 0,
    })),
  };
}

function createMockSdkManager(overrides?: PositionOverrides) {
  const hlClient = createMockHlClient(overrides);
  const manager = new SdkManager({
    hlClientFactory: () => hlClient as unknown as HlClientLike,
  });
  return { manager, hlClient };
}

describe('7.1.5 — clearinghouse summary carries liquidation price + margin used', () => {
  it('surfaces a real liquidationPx and marginUsed from the account payload', async () => {
    const { manager } = createMockSdkManager();
    const summary = await fetchClearinghouseSummary(manager, USER);
    const [pos] = summary!.positions;
    expect(pos.liquidationPx).toBe('54000');
    expect(pos.marginUsed).toBe('3000');
  });

  it('maps a null liquidationPx through as null (no liquidation risk)', async () => {
    const { manager } = createMockSdkManager({ liquidationPx: null });
    const summary = await fetchClearinghouseSummary(manager, USER);
    expect(summary!.positions[0].liquidationPx).toBeNull();
  });

  it('defaults marginUsed to "0" when the venue omits it', async () => {
    const { manager } = createMockSdkManager({ omitMarginUsed: true });
    const summary = await fetchClearinghouseSummary(manager, USER);
    expect(summary!.positions[0].marginUsed).toBe('0');
  });
});

describe('7.1.5 — liquidation distance derivation', () => {
  it('computes the percentage distance from mark to the liquidation price', () => {
    // long: mark 60000, liq 54000 → 10% away
    expect(liquidationDistancePercent(60000, 54000)).toBeCloseTo(10);
    // short: mark 60000, liq 66000 → 10% away (absolute distance)
    expect(liquidationDistancePercent(60000, 66000)).toBeCloseTo(10);
  });

  it('recomputes live as the mark moves toward the liquidation price', () => {
    const far = liquidationDistancePercent(60000, 54000)!;
    const near = liquidationDistancePercent(56000, 54000)!;
    expect(near).toBeLessThan(far);
    expect(near).toBeCloseTo((2000 / 56000) * 100);
  });

  it('returns null (not a scary 0%) when there is no liquidation price', () => {
    expect(liquidationDistancePercent(60000, null)).toBeNull();
    expect(liquidationDistancePercent(60000, undefined)).toBeNull();
  });

  it('returns null when the mark price is not a usable positive number', () => {
    expect(liquidationDistancePercent(0, 54000)).toBeNull();
    expect(liquidationDistancePercent(Number.NaN, 54000)).toBeNull();
  });
});

describe('7.1.5 — liquidation warning threshold', () => {
  it('flags a position inside the warning band', () => {
    expect(isNearLiquidation(LIQUIDATION_WARNING_THRESHOLD_PERCENT - 0.5)).toBe(true);
    expect(isNearLiquidation(LIQUIDATION_WARNING_THRESHOLD_PERCENT)).toBe(true);
  });

  it('does not flag a comfortably distant or unknown position', () => {
    expect(isNearLiquidation(LIQUIDATION_WARNING_THRESHOLD_PERCENT + 0.5)).toBe(false);
    expect(isNearLiquidation(null)).toBe(false);
  });

  it('honors a caller-supplied threshold', () => {
    expect(isNearLiquidation(8, 10)).toBe(true);
    expect(isNearLiquidation(8, 5)).toBe(false);
  });
});

describe('7.1.5 — funding-rate freshness SLA (REST-polled decision)', () => {
  it('exposes a bounded, sane max-age SLA for the REST-polled funding rate', () => {
    // Funding accrues hourly; the SLA is far tighter than that but still a real,
    // testable ceiling — not "whenever". A degenerate 0 or an unbounded window
    // would make "no stale data" untestable.
    expect(FUNDING_MAX_AGE_MS).toBeGreaterThan(0);
    expect(FUNDING_MAX_AGE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

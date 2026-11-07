import { describe, expect, it } from 'vitest';

import {
  LIQUIDATION_WARNING_THRESHOLD_PERCENT,
  isNearLiquidation,
  liquidationDistancePercent,
} from '../src/liquidation';

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

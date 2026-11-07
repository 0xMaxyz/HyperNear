import { describe, expect, it } from 'vitest';
import { breakeven, combinedPnl, type Breakeven, type BreakevenInput } from '../src/breakeven';
import cases from './fixtures/breakeven.json';

describe('breakeven (fixture driven)', () => {
  for (const c of cases as Array<{ name: string; input: BreakevenInput; expect: Breakeven }>) {
    it(c.name, () => {
      const r = breakeven(c.input);
      expect(r.kind).toBe(c.expect.kind);
      if (r.kind === 'price' && c.expect.kind === 'price') {
        // relative tolerance: absolute digits would depend on the price magnitude
        expect(Math.abs(r.price - c.expect.price) / c.expect.price).toBeLessThan(1e-12);
        // PnL really is ~0 at the reported price (relative to the leg notional)
        expect(Math.abs(combinedPnl(c.input, r.price))).toBeLessThan(1e-9 * r.price);
      }
      if (r.kind === 'locked' && c.expect.kind === 'locked') expect(Math.abs(r.lockedPnl - c.expect.lockedPnl)).toBeLessThan(1e-12 * Math.max(1, Math.abs(c.expect.lockedPnl)));
    });
  }

  it('combinedPnl matches the hand formula for unequal sizes with fees', () => {
    const input = cases[3]!.input as BreakevenInput;
    expect(combinedPnl(input, 110)).toBeCloseTo(0.997 * 110 - 101, 9);
  });

  it('locked case needs a mark price', () => {
    expect(() =>
      breakeven({
        legs: [
          { side: 'long', size: 1, entryPx: 1, feesPaid: 0, netFunding: 0 },
          { side: 'short', size: 1, entryPx: 1, feesPaid: 0, netFunding: 0 },
        ],
        closeFeeRate: 0,
      }),
    ).toThrow(/markPx/);
  });

  it('rejects empty books and non-positive legs', () => {
    expect(() => breakeven({ legs: [], closeFeeRate: 0 })).toThrow();
    expect(() => breakeven({ legs: [{ side: 'long', size: 0, entryPx: 1, feesPaid: 0, netFunding: 0 }], closeFeeRate: 0 })).toThrow();
  });
});

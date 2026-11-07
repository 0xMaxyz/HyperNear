/**
 * Phase 7 · fourth testnet walk (2026-08-05), finding C10 — an order's size
 * must sit on Hyperliquid's `szDecimals` grid.
 *
 * The walk found that closing a position at any percentage other than 100%
 * failed with `order 0: Order has invalid size.`. 100% worked because that size
 * came off the exchange already on-grid; 25% of a 2-decimal market's position
 * did not, and neither did anything float arithmetic touched.
 *
 * These cases are the ones that actually shipped broken, not a sweep of the
 * input space: a percentage that lands off-grid, float noise, and the
 * already-exact size that must survive untouched.
 */
import { describe, expect, it } from 'vitest';

import { quantizeSize } from '../../src/hl/pricing';

describe('[C10] quantizeSize', () => {
  it('truncates a percentage close that lands off the grid', () => {
    // 25% of 1.55 on a 2-decimal market — the exact shape the walk rejected.
    expect(quantizeSize('0.3875', 2)).toBe('0.38');
  });

  it('absorbs float noise from a percentage computation', () => {
    expect(quantizeSize(String((0.1 * 3) / 100), 4)).toBe('0.003');
    expect(quantizeSize('0.30000000000000004', 2)).toBe('0.3');
  });

  it('leaves an already-on-grid size exactly as it was', () => {
    expect(quantizeSize('0.5', 5)).toBe('0.5');
    expect(quantizeSize('1.55', 2)).toBe('1.55');
    // The 100% case: a size read back from the exchange must never move.
    expect(quantizeSize('0.01', 5)).toBe('0.01');
  });

  it('rounds DOWN, never up — a size is a claim on a balance', () => {
    // 0.999 → 0.99, not 1.0: rounding up would ask to close more than is open.
    expect(quantizeSize('0.999', 2)).toBe('0.99');
    expect(quantizeSize('0.98999999', 2)).toBe('0.98');
  });

  it('handles integer-only markets and integral sizes', () => {
    expect(quantizeSize('7.9', 0)).toBe('7');
    expect(quantizeSize('7', 0)).toBe('7');
    expect(quantizeSize('12', 3)).toBe('12');
  });

  it('strips the trailing zeros the wire does not need', () => {
    expect(quantizeSize('1.5000', 4)).toBe('1.5');
    expect(quantizeSize('2.000', 2)).toBe('2');
  });

  it('rounds a negative size towards zero, and never produces -0', () => {
    expect(quantizeSize('-0.3875', 2)).toBe('-0.38');
    expect(quantizeSize('-0.004', 2)).toBe('0');
  });

  it('refuses inputs it cannot quantize rather than guessing', () => {
    expect(() => quantizeSize('1e-7', 4)).toThrow(/decimal string/);
    expect(() => quantizeSize('abc', 4)).toThrow(/decimal string/);
    expect(() => quantizeSize('', 4)).toThrow(/decimal string/);
    expect(() => quantizeSize('0.5', -1)).toThrow(/szDecimals/);
    expect(() => quantizeSize('0.5', 1.5)).toThrow(/szDecimals/);
  });

  it('does not lose precision by round-tripping through Number', () => {
    // `Number('0.1') * 10 !== 1`; a string-based quantizer has no such hazard.
    expect(quantizeSize('0.1', 1)).toBe('0.1');
    expect(quantizeSize('0.07', 2)).toBe('0.07');
    expect(quantizeSize('1234567890.123456789', 6)).toBe('1234567890.123456');
  });
});

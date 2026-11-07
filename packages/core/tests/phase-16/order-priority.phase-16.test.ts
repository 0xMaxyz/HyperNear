/**
 * Phase 16 Epic A.2 — write priority fees.
 *
 * The unit under test is the basis-points → `grouping: { p }` conversion.
 * Its contract is deliberately strict, because the fee it encodes is charged
 * to the **user's** undelegated HYPE staking balance, not to the platform
 * (spike 16.1.2). Two consequences drive every case below:
 *
 *  - an out-of-range request is **rejected, never clamped** — silently
 *    substituting a different rate spends someone else's money at a number
 *    they did not choose;
 *  - "no priority" is **absence**, not `{ p: 0 }` — a zero grouping is a
 *    positive assertion on the wire where the default `'na'` belongs.
 */
import { describe, expect, it } from 'vitest';

import {
  HL_MAX_ORDER_PRIORITY_BPS,
  InvalidOrderPriorityError,
  orderPriorityFromBps,
} from '../../src/hl/priority';
import { HL_MAX_ORDER_PRIORITY_P, HL_ORDER_PRIORITY_P_PER_BP } from '../../src/hl/types';

describe('[Epic 16.A.2] orderPriorityFromBps', () => {
  it('treats undefined and zero as "no priority fee" — absent, not { p: 0 }', () => {
    expect(orderPriorityFromBps(undefined)).toBeUndefined();
    expect(orderPriorityFromBps(0)).toBeUndefined();
  });

  it('converts basis points to the p/1e8 fraction the exchange expects', () => {
    expect(orderPriorityFromBps(1)).toEqual({ p: HL_ORDER_PRIORITY_P_PER_BP });
    expect(orderPriorityFromBps(0.5)).toEqual({ p: 5_000 });
    expect(orderPriorityFromBps(3)).toEqual({ p: 30_000 });
  });

  it('accepts exactly the documented ceiling of 8 bps', () => {
    expect(HL_MAX_ORDER_PRIORITY_BPS).toBe(8);
    expect(orderPriorityFromBps(HL_MAX_ORDER_PRIORITY_BPS)).toEqual({
      p: HL_MAX_ORDER_PRIORITY_P,
    });
  });

  it('rejects above the ceiling rather than clamping to it', () => {
    // Clamping would charge 8 bps to a caller who asked for 9 — a different
    // amount of the user's own staked HYPE than they authorised.
    expect(() => orderPriorityFromBps(8.1)).toThrow(InvalidOrderPriorityError);
    expect(() => orderPriorityFromBps(100)).toThrow(/exceed 8 bps/);
  });

  it('rejects negative and non-finite requests', () => {
    expect(() => orderPriorityFromBps(-1)).toThrow(/negative/);
    expect(() => orderPriorityFromBps(Number.NaN)).toThrow(/finite/);
    expect(() => orderPriorityFromBps(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('rejects a positive request too small to encode, instead of silently sending nothing', () => {
    // 0.00001 bps rounds to p = 0. Returning "no priority" here would look
    // identical to success while the caller paid for, and received, nothing.
    expect(() => orderPriorityFromBps(0.00001)).toThrow(/rounds to zero/);
  });

  it('carries a typed code so callers can map it to a wire error', () => {
    try {
      orderPriorityFromBps(9);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidOrderPriorityError).code).toBe('INVALID_ORDER_PRIORITY');
    }
  });
});

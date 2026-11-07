/**
 * [#892, #1170] Task 14.4.5c — Route A's platform floor, its all-in cost, and
 * the manual recovery fee schedule.
 *
 * The floor moved from $50 to $5 in #1170. It is asserted against the constant
 * wherever the point is "every surface reports the same one", and against a
 * literal only where the point is the boundary itself — the floor's *value* is
 * an economic decision that may move again, and a test that pins it in six
 * places turns a one-line decision into a diff nobody reads.
 *
 * The two properties worth pinning here rather than only through a route
 * handler:
 *
 *  1. **A refusal names which limit bound.** The platform floor and the
 *     provider's live `withdrawMin`/`withdrawMax` are different constraints and
 *     a user can act on only one of them — "invalid amount" over the top of both
 *     is the disclosure failure this task exists to end.
 *  2. **The refusal's percentage is the comparison's percentage.** The floor's
 *     whole argument is "at this size the fees are N% of your deposit", and that
 *     number has to be the one the route card shows. Two derivations of it is
 *     how they start disagreeing.
 */
import { describe, expect, it } from 'vitest';

import {
  assertRouteAAmount,
  compareCexDepositRoutes,
  DEPOSIT_RECOVERY_FEE_MAX_USD,
  DEPOSIT_RECOVERY_FEE_MIN_USD,
  DEPOSIT_RECOVERY_FEE_PERCENT,
  DEPOSIT_RECOVERY_FEE_SCHEDULE,
  quoteDepositRecovery,
  routeACostDisclosure,
  ROUTE_A_MIN_DEPOSIT_USD,
  ROUTE_A_TEST_MIN_DEPOSIT_USD,
  RouteAAmountRefusedError,
} from '../../src/index';

/** Nobitex's live production fee, the figure 14.1.4 recorded. */
const FEE = '0.7';

function refusalFor(input: Parameters<typeof assertRouteAAmount>[0]): RouteAAmountRefusedError {
  try {
    assertRouteAAmount(input);
  } catch (err) {
    if (err instanceof RouteAAmountRefusedError) return err;
    throw err;
  }
  throw new Error('expected the amount to be refused');
}

describe('[#892, #1170] the Route A platform floor', () => {
  it('is $5 — lowered from $50 once the deposit started paying its own gas (#1170)', () => {
    expect(ROUTE_A_MIN_DEPOSIT_USD).toBe('5');
  });

  it('is still ABOVE the exchange floor, so the platform limit is the binding one', () => {
    // The floor exists because gas is a FIXED cost. Dropping it under Nobitex's
    // ~2 USDT withdrawMin would make it decorative — the exchange would refuse
    // first — and would put real deposits in the band the test override calls
    // "deliberately uneconomic".
    expect(Number(ROUTE_A_MIN_DEPOSIT_USD)).toBeGreaterThan(2);
  });

  it('admits exactly the floor and refuses a cent under it', () => {
    const floor = ROUTE_A_MIN_DEPOSIT_USD;
    const under = (Number(floor) - 0.01).toFixed(2);
    expect(() => assertRouteAAmount({ amount: floor, exchangeFee: FEE })).not.toThrow();
    expect(refusalFor({ amount: under, exchangeFee: FEE }).bound).toBe('platform-floor');
  });

  it('names the platform floor, and states the percentage the deposit would cost', () => {
    const refusal = refusalFor({ amount: '4', exchangeFee: FEE });
    expect(refusal.bound).toBe('platform-floor');
    expect(refusal.limit).toBe(ROUTE_A_MIN_DEPOSIT_USD);
    // The percentage IS the argument for the floor. "Minimum $50" alone reads
    // as an arbitrary gate.
    const expected = routeACostDisclosure({ amount: '4', exchangeFee: FEE }).totalCostPercent;
    expect(refusal.message).toContain(`${expected}%`);
  });

  it('refuses a non-numeric or non-positive amount as a floor refusal, not a crash', () => {
    expect(refusalFor({ amount: '0', exchangeFee: FEE }).bound).toBe('platform-floor');
    expect(refusalFor({ amount: 'abc', exchangeFee: FEE }).bound).toBe('platform-floor');
  });
});

describe('[#893] the test-only floor override, never on unless a caller passes it', () => {
  it('is ignored by default — a $2 deposit still clears the real floor refusal path', () => {
    expect(refusalFor({ amount: '2', exchangeFee: FEE }).limit).toBe(ROUTE_A_MIN_DEPOSIT_USD);
  });

  it('lowers the floor everywhere the override is threaded: refusal, disclosure, and comparison', () => {
    // Asserted against the constant, not a literal, EXCEPT where the point is
    // the boundary itself. The floor is a test-rig value that moves with what
    // the walk needs; what must not move is that every surface reports the SAME
    // one, which is the bug this test exists for.
    const floor = ROUTE_A_TEST_MIN_DEPOSIT_USD;
    const below = String(Number(floor) / 2);

    expect(() =>
      assertRouteAAmount({ amount: floor, exchangeFee: FEE, minDepositUsdOverride: floor }),
    ).not.toThrow();
    const refusal = refusalFor({
      amount: below,
      exchangeFee: FEE,
      minDepositUsdOverride: floor,
    });
    expect(refusal.limit).toBe(floor);

    const disclosure = routeACostDisclosure({
      amount: below,
      exchangeFee: FEE,
      minDepositUsdOverride: floor,
    });
    expect(disclosure.minimumUsd).toBe(floor);
    expect(disclosure.meetsMinimum).toBe(false);

    const compared = compareCexDepositRoutes({
      amount: String(Number(floor) + 1),
      exchangeFee: FEE,
      routeAMinDepositUsdOverride: floor,
    }).routes.find((route) => route.route === 'A');
    expect(compared?.minimumUsd).toBe(floor);
    expect(compared?.meetsMinimum).toBe(true);
  });

  /**
   * The flag's whole purpose: put the platform floor UNDER the exchange's, so
   * the walk is bounded by the rail's real constraint. If a future edit raises
   * it back above Nobitex's ~2 USDT `withdrawMin`, the platform starts binding
   * again and this fails rather than quietly shrinking the testable range.
   */
  it('sits below Nobitex’s live withdrawMin, so the exchange floor is the binding one', () => {
    expect(Number(ROUTE_A_TEST_MIN_DEPOSIT_USD)).toBeLessThan(2);
  });
});

describe("[#892] the provider's live limits are a SEPARATE refusal", () => {
  it('names the provider minimum when it binds above the platform floor', () => {
    const refusal = refusalFor({ amount: '120', exchangeFee: FEE, providerMin: '150' });
    expect(refusal.bound).toBe('provider-minimum');
    expect(refusal.limit).toBe('150');
    expect(refusal.message).toContain('150');
  });

  it('names the provider maximum, which the platform floor can never express', () => {
    const refusal = refusalFor({ amount: '5000', exchangeFee: FEE, providerMax: '1000' });
    expect(refusal.bound).toBe('provider-maximum');
    expect(refusal.limit).toBe('1000');
  });

  it('checks the platform floor FIRST — a $3 deposit is ours to refuse, not the exchange’s', () => {
    // Both bounds refuse this amount. The one a user can act on ("deposit more,
    // this route has a floor") has to be the one they are told.
    expect(refusalFor({ amount: '3', exchangeFee: FEE, providerMin: '20' }).bound).toBe(
      'platform-floor',
    );
  });

  it('ignores a provider limit the exchange did not publish', () => {
    expect(() => assertRouteAAmount({ amount: '250', exchangeFee: FEE })).not.toThrow();
    expect(() =>
      assertRouteAAmount({ amount: '250', exchangeFee: FEE, providerMin: 'unknown' }),
    ).not.toThrow();
  });

  it('[#1047] bounds them on the SUBMITTED amount, the same as Route B', () => {
    // The provider's cap applies to its own `amount` parameter, and what goes
    // in that is `amount + fee` — so an amount within one fee of the cap is
    // refused HERE, at quote time, rather than after the two-code ceremony.
    const refusal = refusalFor({ amount: '999.5', exchangeFee: FEE, providerMax: '1000' });
    expect(refusal.bound).toBe('provider-maximum');
    expect(refusal.message).toContain('1000.2');
    expect(() =>
      assertRouteAAmount({ amount: '998', exchangeFee: FEE, providerMax: '1000' }),
    ).not.toThrow();
  });
});

describe('[#892] the all-in cost includes the exchange fee, a cost on top of the deposit', () => {
  it('is the comparison’s own Route A column — never a second derivation', () => {
    const disclosure = routeACostDisclosure({ amount: '250', exchangeFee: FEE });
    const compared = compareCexDepositRoutes({ amount: '250', exchangeFee: FEE }).routes.find(
      (route) => route.route === 'A',
    );
    expect(disclosure).toEqual(compared);
  });

  it('moves with the LIVE fee rather than a frozen constant', () => {
    // Nobitex charges 0.7 USDT on production and 1.0 on testnet. A quote from
    // the wrong environment's fee is a guess dressed as a disclosure.
    const production = routeACostDisclosure({ amount: '100', exchangeFee: '0.7' });
    const testnet = routeACostDisclosure({ amount: '100', exchangeFee: '1.0' });
    expect(production.exchangeFeeUsd).toBe('0.70');
    expect(testnet.exchangeFeeUsd).toBe('1.00');
    expect(Number(testnet.totalCostUsd)).toBeGreaterThan(Number(production.totalCostUsd));
  });

  it('keeps chain gas as its own line, as the phase’s table quotes it', () => {
    const cost = routeACostDisclosure({ amount: '100', exchangeFee: FEE });
    expect(cost.gasUsd).toBe('0.15');
    expect(Number(cost.totalCostUsd)).toBeCloseTo(
      Number(cost.routeCostUsd) + Number(cost.gasUsd) + Number(cost.exchangeFeeUsd),
      2,
    );
  });

  it('reports the floor and whether the amount meets it, without hiding the price', () => {
    const under = routeACostDisclosure({ amount: '4', exchangeFee: FEE });
    expect(under.minimumUsd).toBe(ROUTE_A_MIN_DEPOSIT_USD);
    expect(under.meetsMinimum).toBe(false);
    // Priced anyway: a user refused with no number cannot see why.
    expect(Number(under.totalCostUsd)).toBeGreaterThan(0);
  });
});

describe('[#892] the manual recovery fee schedule', () => {
  it('is 10% with a $10 minimum and a $100 cap, and it is manual', () => {
    expect(DEPOSIT_RECOVERY_FEE_PERCENT).toBe(10);
    expect(DEPOSIT_RECOVERY_FEE_MIN_USD).toBe('10');
    expect(DEPOSIT_RECOVERY_FEE_MAX_USD).toBe('100');
    expect(DEPOSIT_RECOVERY_FEE_SCHEDULE.manual).toBe(true);
    expect(DEPOSIT_RECOVERY_FEE_SCHEDULE.cases).toEqual(['stale-address', 'wrong-token']);
  });

  it('charges the flat minimum where 10% is under it', () => {
    const quote = quoteDepositRecovery('50');
    expect(quote.feeUsd).toBe('10.00');
    expect(quote.returnedUsd).toBe('40.00');
    expect(quote.bound).toBe('minimum');
  });

  it('charges 10% in the middle of the range', () => {
    expect(quoteDepositRecovery('500')).toMatchObject({
      feeUsd: '50.00',
      returnedUsd: '450.00',
      bound: 'percent',
    });
  });

  it('caps at $100 however large the deposit', () => {
    expect(quoteDepositRecovery('50000')).toMatchObject({ feeUsd: '100.00', bound: 'maximum' });
  });

  it('does NOT recover a sub-minimum deposit — the fee would be the whole thing', () => {
    // The carve-out the disclosure has to state up front. Answering it as "fee
    // $10, returned $0.00" would be the same arithmetic and a much worse
    // sentence: the user is owed the truth that nothing comes back.
    const quote = quoteDepositRecovery('8');
    expect(quote.recovered).toBe(false);
    expect(quote.bound).toBe('not-recovered');
    expect(quote.returnedUsd).toBe('0.00');
    // …and the boundary itself: at exactly the minimum the fee is the deposit.
    expect(quoteDepositRecovery(DEPOSIT_RECOVERY_FEE_MIN_USD).recovered).toBe(false);
    expect(DEPOSIT_RECOVERY_FEE_SCHEDULE.notRecoveredAtOrBelowUsd).toBe('10');
  });
});

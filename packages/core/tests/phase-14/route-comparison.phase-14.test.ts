/**
 * [#778] Task 14.5.1 — the route comparison and the readiness projection.
 *
 * Two properties are worth pinning here rather than only through the UI:
 *
 *  1. **The cost model reproduces the phase's own measured table.** The
 *     acceptance criteria quote "Route A 68 bp vs B 51 bp @ $100; 35 vs 22 @
 *     $1 000" as the thing a user must see, and those figures come from a live
 *     measurement — a model that drifted from them would be a disclosure that
 *     quietly stopped being true.
 *  2. **The readiness copy obeys ADR 14.2.** The version this replaced told
 *     users to turn safe-withdrawal mode on and asked for four API-key scopes.
 *     Both are the opposite of what this rail wants, and copy is exactly the
 *     kind of thing that rots back without an assertion holding it.
 */
import { describe, expect, it } from 'vitest';

import {
  buildLinkReadinessReport,
  compareCexDepositRoutes,
  CONTROL_COPY,
  CONTROL_WEIGHT,
  rialsToTomans,
  readinessSignalsFromProbe,
  ROUTE_A_MIN_DEPOSIT_USD,
  ROUTE_B_MIN_DEPOSIT_USD,
} from '../../src/index';

/** Route cost only — the measured table excludes the exchange's own fee. */
function bpsWithoutExchangeFee(amount: string, route: 'A' | 'B'): number {
  const found = compareCexDepositRoutes({ amount, exchangeFee: '0' }).routes.find((r) => r.route === route);
  return found!.totalCostBps;
}

describe('[#778] the cost model reproduces the phase-14 economics table', () => {
  it('prices Route A at 68 bp on $100 and 35 bp on $1 000', () => {
    // Gas is quoted separately in the roadmap's table ("68 bp + ~$0.15 gas"), so
    // it is subtracted back out here rather than the model hiding it.
    const at100 = compareCexDepositRoutes({ amount: '100', exchangeFee: '0' }).routes[0];
    const at1000 = compareCexDepositRoutes({ amount: '1000', exchangeFee: '0' }).routes[0];
    expect(Math.round(((Number(at100.totalCostUsd) - Number(at100.gasUsd)) / 100) * 10_000)).toBe(68);
    expect(Math.round(((Number(at1000.totalCostUsd) - Number(at1000.gasUsd)) / 1000) * 10_000)).toBe(35);
  });

  it('prices Route B at 51 bp on $100 and 22 bp on $1 000, gas quoted separately', () => {
    // Same treatment Route A gets above, and it stopped being a no-op in #1170:
    // `ROUTE_B_GAS_USD` was `0`, so subtracting it did nothing and the roadmap's
    // 51 bp was the whole cost. Route B pays BNB for its own sweep, that gas is
    // now charged to the deposit, and the all-in figure is a basis point higher
    // than the table quotes. The table's number is the ROUTE cost; the gas is
    // its own line, exactly as it is for Route A.
    const at100 = compareCexDepositRoutes({ amount: '100', exchangeFee: '0' }).routes[1];
    const at1000 = compareCexDepositRoutes({ amount: '1000', exchangeFee: '0' }).routes[1];
    expect(Math.round(((Number(at100.totalCostUsd) - Number(at100.gasUsd)) / 100) * 10_000)).toBe(51);
    expect(Math.round(((Number(at1000.totalCostUsd) - Number(at1000.gasUsd)) / 1000) * 10_000)).toBe(22);
  });

  it('charges Route B one basis point MORE all-in than the table, and that is the gas', () => {
    // The whole of #1170's Route B half, in one number: the rail was always
    // paying this and calling it zero.
    expect(bpsWithoutExchangeFee('100', 'B')).toBe(52);
    expect(bpsWithoutExchangeFee('1000', 'B')).toBe(22);
  });

  it('keeps Route A dearer than Route B at every size — that is the routed premium', () => {
    for (const amount of ['50', '100', '250', '1000', '5000']) {
      const { routes } = compareCexDepositRoutes({ amount, exchangeFee: '0.7' });
      expect(routes[0].totalCostBps, amount).toBeGreaterThan(routes[1].totalCostBps);
    }
  });
});

describe('[#778] the exchange fee sits in FRONT of both routes', () => {
  it('adds the same fee to each column and never nets it out', () => {
    const { routes } = compareCexDepositRoutes({ amount: '100', exchangeFee: '0.7' });
    expect(routes.map((r) => r.exchangeFeeUsd)).toEqual(['0.70', '0.70']);
    // At $100 Nobitex's flat fee is ~70 bp — larger than the entire routed
    // premium. A disclosure naming only the route would understate the deposit's
    // cost by roughly half.
    expect(routes[1].totalCostBps).toBeGreaterThan(bpsWithoutExchangeFee('100', 'B') + 60);
  });

  it('reads the fee from the caller rather than freezing one', () => {
    // Production charges 0.7 and testnet 1.0. Quoting a user from the wrong
    // environment's fee is the difference between a disclosure and a guess.
    const production = compareCexDepositRoutes({ amount: '100', exchangeFee: '0.7' });
    const testnet = compareCexDepositRoutes({ amount: '100', exchangeFee: '1.0' });
    expect(testnet.routes[1].totalCostUsd).not.toBe(production.routes[1].totalCostUsd);
  });
});

describe('[#778] minimums are per-route and refused with the percentage', () => {
  it('holds each route to its OWN floor — they stopped being the same number in #1170', () => {
    // Route A's dropped to $5 once its chain gas was charged to the deposit
    // rather than absorbed by the platform; Route B pays no chain gas and its
    // floor never had that argument behind it, so it did not move. An amount
    // under BOTH still refuses both.
    expect(ROUTE_A_MIN_DEPOSIT_USD).toBe('5');
    expect(ROUTE_B_MIN_DEPOSIT_USD).toBe('50');
    const { routes, selectable } = compareCexDepositRoutes({ amount: '4', exchangeFee: '0.7' });
    expect(routes[0].meetsMinimum).toBe(false);
    expect(routes[1].meetsMinimum).toBe(false);
    expect(selectable).toEqual([]);
  });

  it('an amount between the two floors clears Route A and not Route B', () => {
    const { routes } = compareCexDepositRoutes({ amount: '20', exchangeFee: '0.7' });
    const a = routes.find((route) => route.route === 'A');
    const b = routes.find((route) => route.route === 'B');
    expect(a?.meetsMinimum).toBe(true);
    expect(b?.meetsMinimum).toBe(false);
  });

  it('an amount above $50 clears both floors, distinctly from availability', () => {
    const { routes, selectable } = compareCexDepositRoutes({ amount: '60', exchangeFee: '0.7' });
    expect(routes[0].meetsMinimum).toBe(true);
    // Route A still isn't selectable — it meets the floor but isn't `available`
    // until epic 14.4's driver ships (a separate gate, see the describe below).
    expect(routes[1].meetsMinimum).toBe(true);
    expect(selectable).toEqual(['B']);
  });

  it('still prices a route it will not let you pick, so the refusal is explicable', () => {
    const { routes } = compareCexDepositRoutes({ amount: '25', exchangeFee: '0.7' });
    // 4%+ of the deposit. That number IS the argument for the floor.
    expect(Number(routes[1].totalCostPercent)).toBeGreaterThan(4);
    expect(routes[1].meetsMinimum).toBe(false);
  });

  it('offers nothing when the amount clears no route', () => {
    expect(compareCexDepositRoutes({ amount: '10', exchangeFee: '0.7' }).selectable).toEqual([]);
  });
});

describe('[#778] Route A is priced but withheld, and says why', () => {
  it('names what is missing rather than "coming soon"', () => {
    const routeA = compareCexDepositRoutes({ amount: '500', exchangeFee: '0.7' }).routes[0];
    expect(routeA.available).toBe(false);
    expect(routeA.plannedReasonCode).toBe('rail-unconfigured');
    expect(routeA.plannedReference).not.toMatch(/coming soon/i);
  });

  it('becomes selectable the moment its driver lands, with no other change', () => {
    const { routes, selectable } = compareCexDepositRoutes({
      amount: '500',
      exchangeFee: '0.7',
      routeA: { available: true },
    });
    expect(routes[0].available).toBe(true);
    expect(routes[0].plannedReference).toBeUndefined();
    expect(routes[0].plannedReasonCode).toBeUndefined();
    expect(selectable).toEqual(['A', 'B']);
  });

  /**
   * The reason used to be frozen: one sentence saying the routed path "needs
   * its HD wallets, gas tanks and chain watchers (epic 14.4); only the direct
   * route is built on this deployment". It went false when Route A's withdrawal
   * shipped and kept rendering on the amount screen of every deposit — a
   * capability withheld for a reason that no longer existed, which is the #794
   * convention inverted.
   */
  it('names the switch that is actually off, per caller', () => {
    const reasons = (['deposit-address-pending', 'gas-tanks-unavailable', 'rail-unconfigured'] as const)
      .map(
        (reason) =>
          compareCexDepositRoutes({
            amount: '500',
            exchangeFee: '0.7',
            routeA: { available: false, reason },
          }).routes[0],
      );

    expect(reasons.map((r) => r.plannedReasonCode)).toEqual([
      'deposit-address-pending',
      'gas-tanks-unavailable',
      'rail-unconfigured',
    ]);
    // Three different sentences, each naming its own switch — and none of them
    // claiming the route is unbuilt.
    expect(new Set(reasons.map((r) => r.plannedReference)).size).toBe(3);
    for (const route of reasons) {
      expect(route.plannedReference).toBeTruthy();
      expect(route.plannedReference).not.toMatch(/unbuilt|only the direct route/i);
    }
  });
});

describe('[#778] rials → tomans is a factor of ten, and carries its unit', () => {
  it('divides by ten and labels the result', () => {
    expect(rialsToTomans('1500000')).toEqual({ value: '150000', unit: 'toman' });
  });

  it('is never applied to a USD figure — those are already dollars', () => {
    // Guardrail by construction: every field the comparison emits is USD, so
    // there is no rial-denominated number in it to convert. A factor-of-ten
    // error on a deposit amount is not a cosmetic bug.
    const { routes } = compareCexDepositRoutes({ amount: '100', exchangeFee: '0.7' });
    // 0.80 route + 0.01 gas + 0.70 exchange fee. The cent is Route B's own
    // chain gas, which read `0` until #1170.
    expect(routes[1].totalCostUsd).toBe('1.22');
  });
});

describe('[#778] readiness copy obeys ADR 14.2', () => {
  it('never asks a user to enable safe-withdrawal mode', () => {
    // The copy this replaced called it "the strongest control the API offers".
    // It is the switch that REMOVES the per-withdrawal two-channel factor: with
    // it on and our address saved, a stolen key withdraws with no codes at all.
    const copy = CONTROL_COPY['safe-withdrawal-mode'];
    expect(copy.remediation.toLowerCase()).not.toMatch(/turn (it )?on|enable/);
    expect(copy.unverifiableAdvice.toLowerCase()).not.toMatch(/turn (it )?on|enable/);
  });

  it('asks for read and withdraw only', () => {
    const copy = CONTROL_COPY['key-permissions'];
    expect(copy.remediation.toLowerCase()).toContain('read and withdraw');
    for (const line of [copy.assertion, copy.remediation, copy.unverifiableAdvice]) {
      expect(line.toLowerCase()).not.toContain('address-book');
      expect(line.toLowerCase()).not.toContain('request-otp');
    }
  });

  it('classes the two whitelisting controls as advisory and the rest as required', () => {
    expect(CONTROL_WEIGHT['safe-withdrawal-mode']).toBe('advisory');
    expect(CONTROL_WEIGHT['destination-whitelisted']).toBe('advisory');
    expect(CONTROL_WEIGHT['key-permissions']).toBe('required');
    expect(CONTROL_WEIGHT['egress-allowlist']).toBe('required');
  });

  it('does not block readiness on an advisory failure', () => {
    const report = buildLinkReadinessReport({
      linkId: 'l1',
      providerId: 'nobitex',
      request: { asset: 'USDT', network: 'BSC', destination: '0xabc' },
      signals: [
        { id: 'egress-allowlist', status: 'satisfied' },
        { id: 'destination-whitelisted', status: 'failed' },
      ],
    });
    // "Correctly configured" on this rail MEANS the destination is not saved.
    // Blocking here would refuse every user it is built for.
    expect(report.ready).toBe(true);
    expect(report.failing).toEqual([]);
    expect(report.advisories).toEqual(['destination-whitelisted']);
    // Reported with a real instruction all the same, because a user who turned
    // the restriction on themselves needs to know why the exchange refuses us.
    expect(report.checks.find((c) => c.id === 'destination-whitelisted')?.remediation).toBeTruthy();
  });

  it('blocks on a required failure and keeps every remediation distinct', () => {
    const report = buildLinkReadinessReport({
      linkId: 'l1',
      providerId: 'nobitex',
      request: { asset: 'USDT', network: 'BSC', destination: '0xabc' },
      signals: [
        { id: 'key-permissions', status: 'failed' },
        { id: 'egress-allowlist', status: 'failed' },
      ],
    });
    expect(report.ready).toBe(false);
    expect(report.failing).toEqual(['key-permissions', 'egress-allowlist']);
    const fixes = report.checks.filter((c) => c.status === 'failed').map((c) => c.remediation);
    expect(new Set(fixes).size).toBe(fixes.length);
  });

  it('never shrinks the checklist when a connector reports less', () => {
    const report = buildLinkReadinessReport({
      linkId: 'l1',
      providerId: 'nobitex',
      request: { asset: 'USDT', network: 'BSC', destination: '0xabc' },
      signals: [],
    });
    // A checklist that gets SHORTER as a connector gets weaker reports a less
    // capable integration as a cleaner one.
    expect(report.checks).toHaveLength(7);
    expect(report.unverifiable).toHaveLength(7);
    expect(report.ready).toBe(true);
  });
});

describe('[#778] readiness inferred from behaviour', () => {
  it('treats one successful authenticated call as evidence for three controls', () => {
    const signals = readinessSignalsFromProbe({
      balances: { ok: true },
      egressIp: '203.0.113.7',
    });
    // An unallowlisted or expired key could not have produced that response.
    const byId = new Map(signals.map((s) => [s.id, s]));
    expect(byId.get('egress-allowlist')?.status).toBe('satisfied');
    expect(byId.get('key-expiry')?.status).toBe('satisfied');
    expect(byId.get('egress-allowlist')?.detail).toBe('203.0.113.7');
    // But NOT permissions: a working key does not prove it lacks `trade`. That
    // stays unverifiable, which is what the report fills in.
    expect(byId.has('key-permissions')).toBe(false);
  });

  it('reports nothing at all rather than a guess when a probe fails opaquely', () => {
    const signals = readinessSignalsFromProbe({ balances: { ok: false, error: new Error('socket hang up') } });
    // A transport failure names no control. Claiming one failed would send the
    // user to re-create a perfectly good API key.
    expect(signals).toEqual([]);
  });
});

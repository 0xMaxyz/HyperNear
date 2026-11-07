import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD_CONFIG, evaluateGuard, evaluateLeg, plausibleMove, type GuardConfig, type GuardLegInput, type GuardReason } from '../src/guard';
import cases from './fixtures/guard.json';

describe('guard (fixture driven)', () => {
  for (const c of cases as Array<{ name: string; cfg?: Partial<GuardConfig>; leg: GuardLegInput; expect: { trigger: boolean; reasons: GuardReason[] } }>) {
    it(c.name, () => {
      const r = evaluateLeg(c.leg, { ...DEFAULT_GUARD_CONFIG, ...c.cfg });
      expect({ trigger: r.trigger, reasons: r.reasons }).toEqual(c.expect);
    });
  }

  it('plausible move for 60% vol over 2 x 15.8 s at 3 sigma is about 0.18%', () => {
    expect(plausibleMove(0.6, DEFAULT_GUARD_CONFIG)).toBeCloseTo(0.0018, 4);
  });

  it('evaluateGuard keeps leg order and flags only the weak leg', () => {
    const [a, b] = evaluateGuard([
      { id: 'a', markPx: 100000, liquidationPx: 90000, marginRatio: 5, annualVol: 0.6 },
      { id: 'b', markPx: 100000, liquidationPx: 99900, marginRatio: 5, annualVol: 0.6 },
    ]);
    expect([a!.id, a!.trigger, b!.id, b!.trigger]).toEqual(['a', false, 'b', true]);
  });
});

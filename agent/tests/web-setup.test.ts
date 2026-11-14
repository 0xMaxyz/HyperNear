import { describe, expect, it } from 'vitest';
import { canApprove, isFunded, legMoney, setupSteps, type SetupLeg } from '../../web/src/setup.ts';

const leg = (n: number, o: { value?: number; spot?: number; approved?: boolean; value_raw?: string } = {}): SetupLeg => ({
  leg: n,
  clearinghouse: { marginSummary: { accountValue: o.value_raw ?? String(o.value ?? 0) } },
  spotUsdc: o.spot ?? 0,
  agent: o.approved ? { approvedAt: 1 } : null,
});
const base = (legs: SetupLeg[], o: { policyAgent?: boolean; topLegs?: { agent: unknown; needsPrepare?: boolean }[] } = {}) => ({
  registered: new Set(legs.map((l) => l.leg)),
  topLegs: o.topLegs ?? legs.map(() => ({ agent: { address: '0x1' } })),
  legs,
  policyAgent: o.policyAgent ?? true,
});

describe('legMoney / isFunded', () => {
  it('counts a unified leg (equity in accountValue, spot 0) and a default leg (perp plus spot)', () => {
    expect(isFunded(leg(0, { value: 80.2 }))).toBe(true);
    expect(isFunded(leg(0, { value: 0, spot: 5 }))).toBe(true);
    expect(legMoney(leg(0, { value: 3, spot: 2 }))).toBe(5);
  });
  it('no money, or a value that is not a number, is not funded', () => {
    expect(isFunded(leg(0))).toBe(false);
    expect(legMoney(leg(0, { value_raw: 'NaN' }))).toBe(0);
    expect(legMoney(leg(0, { value_raw: '' }))).toBe(0);
  });
});

describe('setupSteps', () => {
  it('everything done: legs 0 and 1 funded and approved, policy set', () => {
    const legs = [leg(0, { value: 40, approved: true }), leg(1, { value: 35, approved: true })];
    expect(setupSteps(base(legs))).toEqual([true, true, true, true, true]);
  });

  it('an empty reserve leg 2 does not keep the Fund or Approve step undone', () => {
    const legs = [leg(0, { value: 40, approved: true }), leg(1, { value: 35, approved: true }), leg(2)];
    expect(setupSteps(base(legs))).toEqual([true, true, true, true, true]);
  });

  it('an unfunded leg 0 or 1 keeps Fund undone', () => {
    const legs = [leg(0, { value: 40, approved: true }), leg(1, { value: 0 })];
    expect(setupSteps(base(legs))[2]).toBe(false);
  });

  it('only a missing leg, key or policy turns the other steps off', () => {
    expect(setupSteps(base([leg(0, { value: 1, approved: true })]))[0]).toBe(false); // leg 1 not registered
    const legs = [leg(0, { value: 1, approved: true }), leg(1, { value: 1, approved: true })];
    expect(setupSteps(base(legs, { topLegs: [{ agent: null }, { agent: { a: 1 } }] }))[1]).toBe(false);
    expect(setupSteps(base(legs, { topLegs: [{ agent: {}, needsPrepare: true }] }))[1]).toBe(false);
    expect(setupSteps(base(legs, { policyAgent: false }))[4]).toBe(false);
    expect(setupSteps(base([leg(0, { value: 1 }), leg(1, { value: 1, approved: true })]))[3]).toBe(false); // leg 0 key not approved yet
  });

  it('no legs at all: nothing is done', () => {
    expect(setupSteps(base([], { policyAgent: false }))).toEqual([false, false, false, false, false]);
  });
});

describe('canApprove', () => {
  it('only a funded leg can be approved, an unfunded extra leg does not block the others', () => {
    const legs = [leg(0, { value: 5 }), leg(1, { value: 5 }), leg(2)];
    expect([0, 1, 2, 3].map((n) => canApprove(n, legs))).toEqual([true, true, false, false]);
  });
});

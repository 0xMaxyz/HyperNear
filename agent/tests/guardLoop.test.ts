import { describe, expect, it } from 'vitest';
import type { OwnerState } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard } from '../src/guard.ts';
import { DEFAULT_LOOP_CONFIG, GuardLoop, planRebalance } from '../src/guardLoop.ts';
import { guardInputs, type Legs } from '../src/legs.ts';
import { ch, OWNER, snap } from './agent-helpers.ts';

const NOW = Date.UTC(2026, 10, 7, 12);
const DAY = Math.floor(NOW / 86_400_000);
const policy = (o: Partial<OwnerState> = {}): OwnerState => ({
  nonce: 1, frozen: false, agent: 'agent.testnet', daily_cap: 50e6, cooldown_sec: 30, day: DAY, spent_today: 0, last_rebalance_ns: 0, ...o,
});
const healthy = () => ch({ accountValue: 14.8, maint: 0.38, withdrawable: 4.7, positions: [{ coin: 'BTC', szi: '0.0004', liq: '50000' }] });
const stressed = () => ch({ accountValue: 0.36, maint: 0.19, withdrawable: 0, positions: [{ coin: 'BTC', szi: '-0.0002', lev: 40, liq: '101200' }] });
const plan = (s = snap(healthy(), stressed()), p: OwnerState | null = policy(), agent = 'agent.testnet', cfg = DEFAULT_LOOP_CONFIG) =>
  planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), p, agent, NOW, cfg);

describe('planRebalance', () => {
  it('stressed leg1 is topped up from leg0: max(target - value, $1), within withdrawable', () => {
    expect(plan()).toEqual({
      kind: 'rebalance',
      from: { leg: 0, address: '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac' },
      to: { leg: 1, address: '0x8056c4fa3aad69cf04c2ade906c58489e76c9986' },
      amount: '1.00',
      reasons: ['margin_floor'],
      activationFeeUsd: 0,
      sourceFeeUsd: 0,
    });
  });

  it('nothing to do when no leg triggers', () => {
    expect(plan(snap(healthy(), healthy()))).toEqual({ kind: 'none' });
  });

  it('amount is bounded by the source withdrawable share and the daily cap left', () => {
    const big = { ...DEFAULT_LOOP_CONFIG, targetMultiple: 100 }; // needs 18.6 USD
    expect(plan(undefined, undefined, undefined, big)).toMatchObject({ amount: '4.23' }); // 0.9 x 4.7
    expect(plan(undefined, policy({ spent_today: 48.5e6 }), undefined, big)).toMatchObject({ amount: '1.50' });
    expect(plan(undefined, policy({ spent_today: 48.5e6, day: DAY - 1 }), undefined, big)).toMatchObject({ amount: '4.23' }); // new day
  });

  it.each([
    ['not opted in', null, 'agent.testnet', /not opted/],
    ['another agent', policy({ agent: 'other.testnet' }), 'agent.testnet', /not this service/],
    ['frozen', policy({ frozen: true }), 'agent.testnet', /frozen/],
    ['cooldown', policy({ last_rebalance_ns: (NOW - 10_000) * 1e6 }), 'agent.testnet', /cooldown for 20 s/],
    ['cap used up', policy({ spent_today: 50e6 }), 'agent.testnet', /only \$0.00/],
  ])('blocked: %s', (_n, p, agent, re) => {
    expect(plan(undefined, p as OwnerState | null, agent as string)).toMatchObject({ kind: 'blocked', stressedLeg: 1, reason: re });
  });

  it('blocked when no other leg has withdrawable USDC', () => {
    const dry = ch({ accountValue: 14.8, maint: 0.38, withdrawable: 0, positions: [{ coin: 'BTC', szi: '0.0004', liq: '50000' }] });
    expect(plan(snap(dry, stressed()))).toMatchObject({ kind: 'blocked', reason: /no other leg/ });
  });

  it('cooldown over: allowed again', () => {
    expect(plan(undefined, policy({ last_rebalance_ns: (NOW - 31_000) * 1e6 }))).toMatchObject({ kind: 'rebalance' });
  });
});

describe('GuardLoop.tick (detect-only, no agent key)', () => {
  it('emits one trigger event per state change, then ok when the leg recovers', async () => {
    let s = snap(healthy(), stressed());
    const legs = { snapshot: async () => s, client: { getOwner: async () => policy() }, network: 'testnet' } as unknown as Legs;
    const bus = new EventBus();
    const loop = new GuardLoop({ legs, bus, agentId: 'agent.testnet', owners: () => [OWNER], now: () => NOW });
    expect(await loop.tick(OWNER)).toMatchObject({ kind: 'rebalance', amount: '1.00' });
    await loop.tick(OWNER);
    expect(bus.since().filter((e) => e.type === 'guard.trigger')).toHaveLength(1);
    expect(bus.since().find((e) => e.type === 'guard.trigger')!.data).toMatchObject({ owner: OWNER, detectedAt: NOW });
    s = snap(healthy(), healthy());
    await loop.tick(OWNER);
    expect(bus.since().at(-1)!.type).toBe('guard.ok');
    expect(bus.since().some((e) => e.type.startsWith('guard.rebalance'))).toBe(false);
  });
});

describe('planRebalance for a strategy leg (per-strategy budget, reserve leg only)', () => {
  const withReserve = () => {
    const s = snap(healthy(), stressed());
    s.legs.push({ leg: 2, address: '0x1111111111111111111111111111111111111111', agent: null, clearinghouse: ch({ accountValue: 30, maint: 0, withdrawable: 30 }), spotUsdc: 0, activation: 'paid' });
    return s;
  };
  const run = (budget: number | undefined, cfg = { ...DEFAULT_LOOP_CONFIG, targetMultiple: 100 }) => {
    const s = withReserve();
    return planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), policy(), 'agent.testnet', NOW, cfg, (leg) => (leg === 1 ? budget : undefined));
  };

  it('draws from the reserve leg only, never from the hedge leg 0, and no more than the strategy budget', () => {
    expect(run(5)).toMatchObject({ kind: 'rebalance', from: { leg: 2 }, to: { leg: 1 }, amount: '5.00' }); // needs 18.6, reserve has 27, budget 5
  });

  it('refuses once the strategy budget is used, even though the reserve and the contract cap have plenty', () => {
    expect(run(0)).toMatchObject({ kind: 'blocked', stressedLeg: 1, reason: expect.stringContaining('strategy top-up budget used') });
    expect(run(0.5)).toMatchObject({ kind: 'blocked' }); // below the $1 minimum
  });

  it('without a reserve leg funded there is nothing to draw from', () => {
    const s = snap(healthy(), stressed());
    expect(planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), policy(), 'agent.testnet', NOW, DEFAULT_LOOP_CONFIG, () => 5)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('reserve leg 2') });
  });

  it('a hedge-leg top-up never drains a strategy leg, even the healthiest one', () => {
    const s = withReserve();
    s.legs = s.legs.filter((l) => l.leg !== 2);
    // leg 3 runs a grid: richest and healthiest, so it would win the sort without the filter
    s.legs.push({ leg: 3, address: '0x3333333333333333333333333333333333333333', agent: null, clearinghouse: ch({ accountValue: 50, maint: 0, withdrawable: 50 }), spotUsdc: 0, activation: 'paid' });
    const grid = (leg: number) => (leg === 3 ? 5 : undefined);
    const p = (snapshot: typeof s) => planRebalance(snapshot, evaluateGuard(guardInputs(snapshot, 0.6), DEFAULT_GUARD_CONFIG), policy(), 'agent.testnet', NOW, DEFAULT_LOOP_CONFIG, grid);
    expect(p(s)).toMatchObject({ kind: 'rebalance', from: { leg: 0 }, to: { leg: 1 } });
    // a budget already used (0) is still a strategy leg; with leg 0 dry there is no source at all
    s.legs[0] = { ...s.legs[0]!, clearinghouse: ch({ accountValue: 14.8, maint: 0.38, withdrawable: 0, positions: [{ coin: 'BTC', szi: '0.0004', liq: '50000' }] }) };
    expect(p(s)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('without a strategy') });
    expect(planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), policy(), 'agent.testnet', NOW, DEFAULT_LOOP_CONFIG, (leg) => (leg === 3 ? 0 : undefined))).toMatchObject({ kind: 'blocked' });
  });

  it('a leg with no strategy keeps the old behaviour (healthiest other leg)', () => {
    expect(run(undefined, DEFAULT_LOOP_CONFIG)).toMatchObject({ kind: 'rebalance', from: { leg: 2 } }); // leg 2 is the healthiest anyway
    const s = snap(healthy(), stressed());
    expect(planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), policy(), 'agent.testnet', NOW, DEFAULT_LOOP_CONFIG, () => undefined)).toMatchObject({ from: { leg: 0 } });
  });
});

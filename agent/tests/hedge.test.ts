import { describe, expect, it } from 'vitest';
import { fillOf, planCloseHedge, planOpenHedge } from '../src/hedge.ts';
import { floorSize, roundPx } from '../src/market.ts';
import { ch, POLICY, snap } from './agent-helpers.ts';

describe('planOpenHedge', () => {
  it('short leg1 at ratio x leg0 size, same leverage, IOC below mid', () => {
    const p = planOpenHedge(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0003', lev: 3 }] })), 'BTC', 0.5, POLICY);
    expect(p).toEqual({
      ok: true,
      leverage: { value: 3, isCross: true },
      order: { leg: 1, coin: 'BTC', asset: 3, isBuy: false, size: '0.00015', price: '97000', reduceOnly: false, notionalUsd: 15 },
    });
  });

  it('buys when leg0 is short; keeps isolated margin mode', () => {
    const p = planOpenHedge(snap(ch({ positions: [{ coin: 'BTC', szi: '-0.0004', lev: 2, type: 'isolated' }] })), 'BTC', 1, POLICY);
    expect(p.ok && p.order.isBuy && p.order.price === '103000' && p.leverage.isCross === false && p.order.size === '0.00040').toBe(true);
  });

  it.each([
    ['coin not allowed', 'SOL', 0.5, ch({ positions: [{ coin: 'SOL', szi: '1' }] }), ch(), /not allowed/],
    ['ratio 0', 'BTC', 0, ch({ positions: [{ coin: 'BTC', szi: '0.001' }] }), ch(), /ratio/],
    ['ratio > 1', 'BTC', 1.5, ch({ positions: [{ coin: 'BTC', szi: '0.001' }] }), ch(), /ratio/],
    ['leg0 flat', 'BTC', 0.5, ch(), ch(), /no BTC position/],
    ['leverage above policy', 'BTC', 0.5, ch({ positions: [{ coin: 'BTC', szi: '0.001', lev: 10 }] }), ch(), /above policy max 5x/],
    ['notional above policy', 'BTC', 1, ch({ positions: [{ coin: 'BTC', szi: '0.002' }] }), ch(), /above policy max \$100/],
    ['below HL minimum', 'BTC', 0.5, ch({ positions: [{ coin: 'BTC', szi: '0.00015' }] }), ch(), /below HL minimum/],
    ['leg1 already positioned', 'BTC', 0.5, ch({ positions: [{ coin: 'BTC', szi: '0.0003' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0001' }] }), /already holds/],
  ])('refuses: %s', (_n, coin, ratio, l0, l1, re) => {
    const p = planOpenHedge(snap(l0, l1), coin as string, ratio as number, POLICY);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toMatch(re as RegExp);
  });

  it('refuses when leg1 is not registered', () => {
    const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0003' }] }));
    s.legs = s.legs.slice(0, 1);
    expect(planOpenHedge(s, 'BTC', 0.5, POLICY)).toMatchObject({ ok: false, reason: /legs 0 and 1/ });
  });
});

describe('planCloseHedge', () => {
  it('reduce-only IOC on both legs, opposite each side', () => {
    const p = planCloseHedge(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0003' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.00015' }] })), 'BTC', POLICY);
    expect(p.ok && p.orders.map((o) => [o.leg, o.isBuy, o.size, o.price, o.reduceOnly])).toEqual([
      [0, false, '0.00030', '97000', true],
      [1, true, '0.00015', '103000', true],
    ]);
  });

  it('skips flat legs; nothing to do when both are flat', () => {
    const one = planCloseHedge(snap(ch(), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] })), 'BTC', POLICY);
    expect(one.ok && one.orders.map((o) => o.leg)).toEqual([1]);
    expect(planCloseHedge(snap(ch(), ch()), 'BTC', POLICY).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('roundPx: 5 significant figures, <= 6 - szDecimals decimals', () => {
    expect(roundPx(97123.456, 5)).toBe('97123');
    expect(roundPx(3456.789, 4)).toBe('3456.8');
    expect(roundPx(1.234567, 2)).toBe('1.2346');
  });
  it('floorSize never rounds up', () => {
    expect(floorSize(0.000159, 5)).toBe('0.00015');
    expect(floorSize(0.00015, 5)).toBe('0.00015');
  });
  it('fillOf throws on an HL error status', () => {
    expect(() => fillOf({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match' } as never] } } })).toThrow(/immediately match/);
    expect(fillOf({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 5, totalSz: '0.1', avgPx: '1' } } as never] } } }).oid).toBe(5);
  });
});

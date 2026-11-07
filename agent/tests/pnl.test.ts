import { describe, expect, it } from 'vitest';
import type { HlUserFill, HlUserFunding } from '@perps-platform/core';
import { breakevens, DEFAULT_TAKER_RATE, legCosts, openTime } from '../src/pnl.ts';
import { ch, snap } from './agent-helpers.ts';

const fill = (coin: string, time: number, startPosition: string, fee: string): HlUserFill =>
  ({ coin, px: "100000", sz: "0.0001", side: "B", time, startPosition, dir: "Open Long", closedPnl: "0", hash: "0x0", oid: 1, crossed: true, fee } as unknown as HlUserFill);
const funding = (coin: string, time: number, usdc: string): HlUserFunding =>
  ({ time, hash: '0x0', delta: { type: 'funding', coin, usdc, szi: '0', fundingRate: '0' } } as unknown as HlUserFunding);

describe('pnl inputs', () => {
  it('counts fees and funding only since the current position opened', () => {
    const fills = [fill('BTC', 1, '0', '9'), fill('BTC', 2, '0.0001', '9'), fill('BTC', 10, '0', '0.5'), fill('BTC', 11, '0.0001', '0.25'), fill('ETH', 12, '0', '7')];
    expect(openTime(fills, 'BTC')).toBe(10);
    const c = legCosts({ leg: 0, fills, funding: [funding('BTC', 5, '-3'), funding('BTC', 12, '-0.1'), funding('BTC', 13, '0.04')], takerRate: 0.0004 }, 'BTC');
    expect(c.feesPaid).toBeCloseTo(0.75, 10);
    expect(c.netFunding).toBeCloseTo(-0.06, 10);
  });
});

describe('breakevens', () => {
  it('hedged pair: one row per coin with the combined break-even', () => {
    const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }));
    const [b] = breakevens(s, [
      { leg: 0, fills: [fill('BTC', 1, '0', '0.02')], funding: [], takerRate: 0.0005 },
      { leg: 1, fills: [fill('BTC', 1, '0', '0.01')], funding: [funding('BTC', 2, '0.005')], takerRate: 0.0004 },
    ]);
    expect(b).toMatchObject({ coin: 'BTC', kind: 'price', lockedPnl: null, feesPaid: 0.03, netFunding: 0.005 });
    expect(b!.netSize).toBeCloseTo(0.0002, 12);
    // slope = 0.0002 - 0.0005*0.0006, constant = -(0.0002*100000) - 0.03 + 0.005 -> P = 20.025 / 0.0001997
    expect(b!.breakEvenPx).toBeCloseTo(20.025 / 0.0001997, 3);
    expect(b!.estCloseFees).toBeCloseTo(0.0005 * 100000 * 0.0006, 10);
  });

  it('equal and opposite sizes: locked PnL, no break-even price; no data -> base taker rate', () => {
    const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0002' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }));
    const [b] = breakevens(s, []);
    expect(b).toMatchObject({ kind: 'locked', breakEvenPx: null, feesPaid: 0, netFunding: 0 });
    expect(b!.lockedPnl).toBeCloseTo(-DEFAULT_TAKER_RATE * 100000 * 0.0004, 10);
  });

  it('no positions: empty', () => {
    expect(breakevens(snap(ch(), ch()), [])).toEqual([]);
  });
});

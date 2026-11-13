import { describe, expect, it } from 'vitest';
import type { HlUserFill, HlUserFunding } from '@perps-platform/core';
import { makeCloid } from '../src/cloid.ts';
import { buildCycles, feeLinesOf, historyRows, nextFundingAt, openComposites, openTime, setupFeePaid, type LegHistory } from '../src/positions.ts';
import { ch, snap } from './agent-helpers.ts';

let t = 1_000;
let tid = 0;
const fill = (x: { side: 'B' | 'A'; sz: string; px?: string; start: string; pnl?: string; fee?: string; cloid?: string; coin?: string; twapId?: number; oid?: number; dir?: string }): HlUserFill => ({
  coin: x.coin ?? 'BTC', px: x.px ?? '100000', sz: x.sz, side: x.side, time: (t += 1000), startPosition: x.start, dir: x.dir ?? 'Open Long', closedPnl: x.pnl ?? '0',
  hash: `0x${'0'.repeat(64)}`, oid: x.oid ?? ++tid, crossed: true, fee: x.fee ?? '0.1', tid: ++tid, feeToken: 'USDC', twapId: x.twapId ?? null, ...(x.cloid ? { cloid: x.cloid as `0x${string}` } : {}),
});
const fund = (time: number, usdc: string, coin = 'BTC'): HlUserFunding => ({ time, hash: `0x${'0'.repeat(64)}`, delta: { type: 'funding', coin, usdc } as HlUserFunding['delta'] });

describe('buildCycles', () => {
  it('a cycle runs from flat to flat; adds and partial closes stay in it', () => {
    const cycles = buildCycles(
      [
        fill({ side: 'B', sz: '0.01', start: '0', fee: '0.4' }),
        fill({ side: 'B', sz: '0.01', start: '0.01', fee: '0.4' }),
        fill({ side: 'A', sz: '0.005', start: '0.02', pnl: '1', fee: '0.2', dir: 'Close Long' }),
        fill({ side: 'A', sz: '0.015', start: '0.015', pnl: '3', fee: '0.6', dir: 'Close Long' }),
        fill({ side: 'A', sz: '0.01', start: '0', fee: '0.4', dir: 'Open Short' }),
      ],
      'BTC',
    );
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ side: 'long', realized: 4, closedAt: expect.any(Number) });
    expect(cycles[0]!.fees).toBeCloseTo(1.6, 9);
    expect(cycles[1]).toMatchObject({ side: 'short', realized: 0, fees: 0.4 });
    expect(cycles[1]!.closedAt).toBeUndefined();
  });

  it('a fill that flips through zero is split: its fee is shared by size, the PnL belongs to the closing part', () => {
    const [a, b] = buildCycles([fill({ side: 'B', sz: '0.01', start: '0', fee: '0.1' }), fill({ side: 'A', sz: '0.015', start: '0.01', pnl: '2', fee: '0.3', dir: 'Long > Short' })], 'BTC');
    expect(a).toMatchObject({ side: 'long', realized: 2 });
    expect(a!.fees).toBeCloseTo(0.1 + 0.2, 9); // 0.01 of the 0.015 closes the long
    expect(b).toMatchObject({ side: 'short', realized: 0 });
    expect(b!.fees).toBeCloseTo(0.1, 9);
  });

  it('fee components: open/add vs reduce, taker vs maker, builder; they add up to the cycle total', () => {
    // fills get their time when created, so create them in order
    const f1 = fill({ side: 'B', sz: '0.01', start: '0', fee: '0.4' });
    const maker = { ...fill({ side: 'B', sz: '0.01', start: '0.01', fee: '0.05' }), crossed: false };
    const withBuilder = { ...fill({ side: 'A', sz: '0.005', start: '0.02', pnl: '1', fee: '0.2', dir: 'Close Long' }), builderFee: '0.03' };
    const f4 = fill({ side: 'A', sz: '0.015', start: '0.015', fee: '0.6', dir: 'Close Long' });
    const [c] = buildCycles([f1, maker, withBuilder, f4], 'BTC');
    const lines = feeLinesOf(c!.parts);
    const by = (label: string) => lines.find((l) => l.label === label)!;
    expect(by('Opening and adding, taker')).toMatchObject({ fills: 1, amount: 0.4, notional: 1000 });
    expect(by('Opening and adding, maker')).toMatchObject({ fills: 1, amount: 0.05 });
    expect(by('Reducing and closing, taker')).toMatchObject({ fills: 2 });
    expect(by('Reducing and closing, taker').amount).toBeCloseTo(0.8, 9);
    expect(by('Builder fee').amount).toBeCloseTo(0.03, 9);
    expect(by('Opening and adding, taker').ratePct).toBeCloseTo(0.04, 9);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(c!.fees, 9);
    expect(c!.fees).toBeCloseTo(0.4 + 0.05 + 0.2 + 0.03 + 0.6, 9);
  });

  it('a flip books the closing share as reduce and the rest as open', () => {
    const [a, b] = buildCycles([fill({ side: 'B', sz: '0.01', start: '0', fee: '0.1' }), fill({ side: 'A', sz: '0.015', start: '0.01', pnl: '2', fee: '0.3', dir: 'Long > Short' })], 'BTC');
    expect(feeLinesOf(a!.parts).find((l) => l.role === 'reduce')!.amount).toBeCloseTo(0.2, 9);
    expect(feeLinesOf(b!.parts)).toMatchObject([{ role: 'open', amount: expect.closeTo(0.1, 9) }]);
  });

  it('openTime is the last fill from flat', () => {
    const f = [fill({ side: 'B', sz: '1', start: '0' }), fill({ side: 'B', sz: '1', start: '1' }), fill({ side: 'A', sz: '2', start: '2' }), fill({ side: 'B', sz: '1', start: '0' })];
    expect(openTime(f, 'BTC')).toBe(f[3]!.time);
    expect(openTime(f, 'ETH')).toBe(0);
  });
});

/** a snapshot where leg 0 is long and leg 1 short, both with a given unrealized PnL */
const hedged = (u0: string, u1: string) => {
  const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }), '100000');
  s.legs[0]!.clearinghouse.assetPositions[0]!.position.unrealizedPnl = u0;
  s.legs[1]!.clearinghouse.assetPositions[0]!.position.unrealizedPnl = u1;
  return s;
};
const legData = (leg: number, over: Partial<LegHistory>): LegHistory => ({ leg, address: (snap(ch()).legs[leg]?.address ?? `0x${'0'.repeat(39)}${leg}`) as `0x${string}`, fills: [], funding: [], ledger: [], takerRate: 0.00045, activation: 'paid', setupFeeUsd: 1, ...over });

describe('openComposites', () => {
  it('pairs legs 0 and 1 into a hedge; position PnL adds every line, the setup fee once per leg', () => {
    const open0 = fill({ side: 'B', sz: '0.0004', start: '0', fee: '0.02' });
    const open1 = fill({ side: 'A', sz: '0.0002', start: '0', fee: '0.01', dir: 'Open Short', cloid: makeCloid('hedgeOpen') });
    const data = [
      legData(0, { fills: [open0], funding: [fund(open0.time + 10, '-0.03')] }),
      legData(1, { fills: [open1], funding: [fund(open1.time + 10, '0.02')] }),
    ];
    const [c, ...more] = openComposites(hedged('1.5', '-0.5'), data, { BTC: 0.0000125 }, 5_000);
    expect(more).toEqual([]);
    expect(c).toMatchObject({ kind: 'hedge', coin: 'BTC' });
    expect(c!.netSize).toBeCloseTo(0.0002, 12);
    expect(c!.totals.unrealized).toBeCloseTo(1, 9);
    expect(c!.totals.fees).toBeCloseTo(0.03, 9);
    expect(c!.totals.funding).toBeCloseTo(-0.01, 9);
    expect(c!.totals.activationFee).toBe(2);
    expect(c!.totals.pnl).toBeCloseTo(1 - 0.03 - 0.01 - 2, 9);
    // closing both legs at 100000: (0.0004 + 0.0002) x 100000 x 0.00045 = 0.027
    expect(c!.totals.closeFeesEst).toBeCloseTo(0.027, 9);
    expect(c!.totals.netIfClosed).toBeCloseTo(c!.totals.pnl - 0.027, 9);
    // a long pays a positive rate and a short receives it: the hedge nets to about 0 when the legs match, here 0.0002 net long pays
    expect(c!.totals.nextFundingEstimate).toBeCloseTo(-(0.0004 - 0.0002) * 100000 * 0.0000125, 9);
    expect(c!.nextFundingAt).toBe(nextFundingAt(5_000));
    expect(c!.nextFundingAt % 3_600_000).toBe(0);
  });

  it('a lone position is one-sided; a second cycle on the same leg carries no setup fee', () => {
    const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch());
    const first = [fill({ side: 'B', sz: '0.0004', start: '0' }), fill({ side: 'A', sz: '0.0004', start: '0.0004', pnl: '0.5', dir: 'Close Long' })];
    const second = fill({ side: 'B', sz: '0.0004', start: '0' });
    const [c] = openComposites(s, [legData(0, { fills: [...first, second] })], {}, 9_000);
    expect(c).toMatchObject({ kind: 'one-sided', legs: [{ leg: 0, activationFee: 0, realized: 0 }] });
    const [only] = openComposites(s, [legData(0, { fills: [second] })], {}, 9_000);
    expect(only!.totals.activationFee).toBe(1);
  });

  describe('hedges on any two legs, several coins at once', () => {
    const P = (coin: string, szi: string) => ({ coin, szi });
    /** legs by number, each with its positions; ETH next to BTC */
    const many = (legsSpec: Record<number, { coin: string; szi: string }[]>) => {
      const base = snap(ch(), ch());
      return {
        ...base,
        legs: Object.entries(legsSpec).map(([leg, positions]) => ({ ...base.legs[0]!, leg: Number(leg), address: `0x${'0'.repeat(39)}${leg}` as `0x${string}`, clearinghouse: ch({ positions }) })),
        market: { assets: [...base.market.assets, { name: 'ETH', asset: 4, szDecimals: 4, maxLeverage: 25 }], mids: { BTC: '100000', ETH: '3000' } },
      };
    };
    const shape = (s: ReturnType<typeof many>, data: LegHistory[] = []) => openComposites(s, data).map((c) => [c.coin, c.kind, c.legs.map((l) => l.leg), c.hedge]);

    it('a long on leg 0 and a short on leg 2 are a hedge (not only legs 0 and 1)', () => {
      expect(shape(many({ 0: [P('BTC', '0.0004')], 1: [], 2: [P('BTC', '-0.0003')] }))).toEqual([['BTC', 'hedge', [0, 2], { longLeg: 0, shortLeg: 2 }]]);
    });

    it('two coins: each coin pairs its own legs, so a header "Hedge" is never shared across markets', () => {
      const s = many({ 0: [P('BTC', '0.0004'), P('ETH', '-0.1')], 1: [P('BTC', '-0.0004')], 2: [P('ETH', '0.1')] });
      expect(shape(s)).toEqual([['BTC', 'hedge', [0, 1], { longLeg: 0, shortLeg: 1 }], ['ETH', 'hedge', [0, 2], { longLeg: 2, shortLeg: 0 }]]);
    });

    it('long, short, short: one hedge and the extra short stays one-sided', () => {
      expect(shape(many({ 0: [P('BTC', '0.0004')], 1: [P('BTC', '-0.0002')], 2: [P('BTC', '-0.0002')] })).map((x) => [x[1], x[2]])).toEqual([['hedge', [0, 1]], ['one-sided', [2]]]);
    });

    it('legs opened by one action (same cloid group) pair first, even when a lower leg is free', () => {
      const g = 'aabbccddee';
      const open = (leg: number, side: 'B' | 'A', start: string) => legData(leg, { fills: [fill({ side, sz: '0.0004', start, cloid: makeCloid('hedgeOpen', g) })] });
      const s = many({ 0: [P('BTC', '0.0004')], 1: [P('BTC', '-0.0004')], 2: [P('BTC', '0.0004')] });
      // legs 1 and 2 were opened together (leg 0's long is unrelated): they pair, leg 0 stays one-sided
      const data = [legData(0, { fills: [fill({ side: 'B', sz: '0.0004', start: '0' })] }), open(1, 'A', '0'), open(2, 'B', '0')];
      expect(shape(s, data).map((x) => [x[1], x[2]])).toEqual([['one-sided', [0]], ['hedge', [1, 2]]]);
    });

    it('a strategy leg (3 and up) never pairs with the owners legs', () => {
      expect(shape(many({ 0: [P('BTC', '0.0004')], 3: [P('BTC', '-0.0004')] })).map((x) => [x[1], x[2]])).toEqual([['one-sided', [0]], ['strategy', [3]]]);
    });
  });

  it('the same side on both legs is not a hedge', () => {
    const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '0.0002' }] }));
    expect(openComposites(s, []).map((c) => c.kind)).toEqual(['one-sided', 'one-sided']);
  });

  it('works with no fills known: PnL is the exchange unrealized figure only', () => {
    const [c] = openComposites(hedged('1', '1'), []);
    expect(c!.totals).toMatchObject({ realized: 0, fees: 0, funding: 0, unrealized: 2 });
  });
});

describe('historyRows', () => {
  it('collapses a hedge action across both legs, labels by cloid, and keeps outside trades honest', () => {
    const g = 'aabbccddee';
    const hc = makeCloid('hedgeClose', g);
    const rows = historyRows([
      legData(0, {
        fills: [
          fill({ side: 'B', sz: '0.0004', start: '0', cloid: makeCloid('open') }),
          fill({ side: 'A', sz: '0.0004', start: '0.0004', pnl: '1.2', fee: '0.02', dir: 'Close Long', cloid: hc }),
          fill({ side: 'B', sz: '0.001', start: '0', oid: 77, dir: 'Open Long' }),
        ],
        funding: [fund(3_600_000 * 5 + 10, '0.01'), fund(3_600_000 * 5 + 20, '0.02')],
      }),
      legData(1, { fills: [fill({ side: 'B', sz: '0.0002', start: '-0.0002', pnl: '-0.4', fee: '0.01', dir: 'Close Short', cloid: hc })] }),
    ]);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'hedge-close')).toHaveLength(1);
    const close = rows.find((r) => r.kind === 'hedge-close')!;
    expect(close).toMatchObject({ legs: [0, 1], group: g, closedPnl: expect.closeTo(0.8, 9), fee: expect.closeTo(0.03, 9) });
    expect(close.label).toMatch(/Hedge closed: BTC on both legs/);
    expect(rows.find((r) => r.kind === 'open')!.label).toMatch(/One-sided: opened long on leg 0/);
    expect(rows.find((r) => r.kind === 'external')!.label).toMatch(/Outside HyperNear/);
    const funding = rows.filter((r) => r.kind === 'funding');
    expect(funding).toHaveLength(1); // one row per hour and coin
    expect(funding[0]!.amount).toBeCloseTo(0.03, 9);
    expect(rows.map((r) => r.time)).toEqual([...rows.map((r) => r.time)].sort((a, b) => b - a));
  });

  it('TWAP slices merge into one row, and transfers come from the ledger', () => {
    const rows = historyRows([
      legData(0, {
        fills: [fill({ side: 'B', sz: '0.001', start: '0', twapId: 5 }), fill({ side: 'B', sz: '0.001', start: '0.001', twapId: 5 })],
        ledger: [
          { time: 10, hash: `0x${'0'.repeat(64)}`, delta: { type: 'deposit', usdc: '24.0' } },
          { time: 20, hash: `0x${'0'.repeat(64)}`, delta: { type: 'withdraw', usdc: '3.0', fee: '1.0' } },
        ],
      }),
    ]);
    const twap = rows.filter((r) => r.kind === 'twap');
    expect(twap).toHaveLength(1);
    expect(twap[0]).toMatchObject({ size: 0.002 });
    expect(rows.filter((r) => r.kind === 'transfer').map((r) => r.amount)).toEqual([-3, 24]);
  });
});

describe('setupFeePaid', () => {
  const leg = '0x61ad9ffd844dda0bc5eb3c6c8bd32d5243b92930';
  const row = (time: number, delta: Record<string, unknown>) => ({ time, hash: `0x${'0'.repeat(64)}` as `0x${string}`, delta: delta as never });
  const credit = row(1, { type: 'internalTransfer', usdc: '25.0', user: '0xaaaa', destination: leg, fee: '1.0' });
  it('a fee-carrying HyperCore credit was paid out of the amount on testnet, by the sender on mainnet', () => {
    expect(setupFeePaid([credit], leg, 'testnet')).toBe(1);
    expect(setupFeePaid([credit], leg, 'mainnet')).toBe(0);
  });
  it('a leg credited without a fee pays on its first outgoing transfer; a withdrawal fee is not the activation', () => {
    const free = row(1, { type: 'send', usdc: '5.0', user: '0xbbbb', destination: leg, fee: '0.0' });
    const withdraw = row(2, { type: 'withdraw', usdc: '3.0', fee: '1.0' });
    expect(setupFeePaid([free], leg, 'mainnet')).toBe(0);
    expect(setupFeePaid([free, withdraw], leg, 'mainnet')).toBe(0);
    expect(setupFeePaid([free, row(3, { type: 'send', usdc: '1.0', user: leg, destination: '0xcccc', fee: '1.0' })], leg, 'mainnet')).toBe(1);
    expect(setupFeePaid([], leg, 'testnet')).toBe(0);
  });
});

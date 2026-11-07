import { describe, expect, it } from 'vitest';
import type { HlUserFill, HlUserFunding } from '@perps-platform/core';
import { computePnl, strategyPnl, type PnlSource } from '../src/strategy/pnl';

const SINCE = 1_000_000;
const fill = (time: number, closedPnl: string, fee = '0.01'): HlUserFill => ({ time, closedPnl, fee, coin: 'BTC', oid: time, px: '75000', sz: '0.00015', side: 'B', startPosition: '0', dir: 'Open Long', crossed: true, hash: '0x00', tid: time, feeToken: 'USDC', twapId: null }) as HlUserFill;
const funding = (time: number, usdc: string): HlUserFunding => ({ time, hash: '0x00', delta: { type: 'funding', coin: 'BTC', usdc, szi: '0.0001', fundingRate: '0.0001', nSamples: null } }) as HlUserFunding;
const positions = (unrealizedPnl: string) => ({ assetPositions: [{ position: { unrealizedPnl } }] }) as unknown as { assetPositions: never };

/** The leg as HL reports it. accountValue / withdrawable change with deposits and transfers, the history does not. */
function leg(o: { accountValue: number; fills?: HlUserFill[]; funding?: HlUserFunding[]; unrealized?: string }): PnlSource {
  return {
    userFills: async () => o.fills ?? [],
    userFunding: async () => o.funding ?? [],
    clearinghouseState: async () => ({ ...positions(o.unrealized ?? '0'), accountValue: o.accountValue, withdrawable: o.accountValue }) as never,
  };
}
const history = { fills: [fill(SINCE + 10, '0'), fill(SINCE + 20, '-0.30')], funding: [funding(SINCE + 30, '-0.02')], unrealized: '-0.10' };

describe('strategy PnL (fills + positions at mark + funding since the start; never equity)', () => {
  it('adds realized, unrealized and funding and subtracts fees', async () => {
    expect(await strategyPnl(leg({ accountValue: 25, ...history }), '0x01', SINCE)).toMatchObject({ realized: -0.3, fees: 0.02, unrealized: -0.1, funding: -0.02, fills: 2 });
    expect((await strategyPnl(leg({ accountValue: 25, ...history }), '0x01', SINCE)).total).toBeCloseTo(-0.44, 10);
  });

  it('a guard top-up in the middle of the run leaves the PnL unchanged', async () => {
    const before = await strategyPnl(leg({ accountValue: 9.5, ...history }), '0x01', SINCE);
    const afterTopUp = await strategyPnl(leg({ accountValue: 14.5, ...history }), '0x01', SINCE); // +$5 from the reserve leg
    expect(afterTopUp).toEqual(before);
  });

  it('an owner transfer out leaves the PnL unchanged', async () => {
    const before = await strategyPnl(leg({ accountValue: 25, ...history }), '0x01', SINCE);
    const afterTransfer = await strategyPnl(leg({ accountValue: 10, ...history }), '0x01', SINCE); // $15 moved to spot
    expect(afterTransfer).toEqual(before);
  });

  it('a losing fill moves it by its loss and its fee', async () => {
    const base = await strategyPnl(leg({ accountValue: 25, ...history }), '0x01', SINCE);
    const worse = await strategyPnl(leg({ accountValue: 25, ...history, fills: [...history.fills, fill(SINCE + 40, '-1.50', '0.02')] }), '0x01', SINCE);
    expect(worse.total - base.total).toBeCloseTo(-1.52, 10);
  });

  it('fills and funding from before the strategy started are ignored', () => {
    const p = computePnl(SINCE, [fill(SINCE - 1, '-5'), fill(SINCE, '1', '0')], positions('0'), [funding(SINCE - 1, '-2')]);
    expect(p).toMatchObject({ realized: 1, fees: 0, funding: 0, total: 1, fills: 1 });
  });
});

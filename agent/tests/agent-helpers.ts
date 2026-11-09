import type { HlClearinghouseState } from '@perps-platform/core';
import type { OrderPolicy } from '../src/config.ts';
import type { OwnerSnapshot } from '../src/legs.ts';

export const POLICY: OrderPolicy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
export const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as const;

export function ch(o: { accountValue?: number; maint?: number; withdrawable?: number; positions?: { coin: string; szi: string; lev?: number; type?: 'cross' | 'isolated'; liq?: string | null }[] } = {}): HlClearinghouseState {
  const summary = { accountValue: String(o.accountValue ?? 20), totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' };
  return {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: String(o.maint ?? 0),
    withdrawable: String(o.withdrawable ?? 20),
    time: 0,
    assetPositions: (o.positions ?? []).map((p) => ({
      type: 'oneWay' as const,
      position: {
        coin: p.coin,
        szi: p.szi,
        leverage: p.type === 'isolated' ? { type: 'isolated' as const, value: p.lev ?? 3, rawUsd: '0' } : { type: 'cross' as const, value: p.lev ?? 3 },
        entryPx: '100000',
        positionValue: '0',
        unrealizedPnl: '0',
        returnOnEquity: '0',
        liquidationPx: p.liq === undefined ? '70000' : p.liq,
        marginUsed: '0',
        maxLeverage: 40,
        cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
      },
    })),
  } as HlClearinghouseState;
}

export function snap(leg0: HlClearinghouseState, leg1: HlClearinghouseState = ch(), mid = '100000'): OwnerSnapshot {
  return {
    owner: OWNER,
    at: 0,
    legs: [
      { leg: 0, address: '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac', agent: null, clearinghouse: leg0, spotUsdc: 0, activation: 'paid' },
      { leg: 1, address: '0x8056c4fa3aad69cf04c2ade906c58489e76c9986', agent: null, clearinghouse: leg1, spotUsdc: 0, activation: 'paid' },
    ],
    market: { assets: [{ name: 'BTC', asset: 3, szDecimals: 5, maxLeverage: 40 }], mids: { BTC: mid } },
  };
}

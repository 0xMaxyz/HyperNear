// Per-coin combined break-even of the owner's legs (ts-dev's breakeven.ts), with fees from HL fills and net funding
// from HL userFunding, both counted since each leg's current position opened.
import type { HlClient, HlUserFill, HlUserFunding } from '@perps-platform/core';
import { breakeven, type HedgeLeg } from './breakeven.ts';
import type { OwnerSnapshot } from './legs.ts';
import { position } from './market.ts';

/** HL base taker rate (fallback when userFees is not read, e.g. --dry-run). */
export const DEFAULT_TAKER_RATE = 0.00045;

export interface LegPnlData {
  leg: number;
  fills: HlUserFill[];
  funding: HlUserFunding[];
  takerRate: number;
}

export interface CoinBreakeven {
  coin: string;
  netSize: number;
  breakEvenPx: number | null;
  lockedPnl: number | null;
  /** price | locked | always_profitable | never_profitable */
  kind: string;
  feesPaid: number;
  netFunding: number;
  estCloseFees: number;
}

/** Time the current position in `coin` opened: the last fill that started from a flat position. */
export function openTime(fills: HlUserFill[], coin: string): number {
  const opens = fills.filter((f) => f.coin === coin && Number(f.startPosition) === 0).map((f) => f.time);
  return opens.length ? Math.max(...opens) : 0;
}

/** Pure: fees and funding of the current position of `coin` on one leg. */
export function legCosts(d: LegPnlData | undefined, coin: string) {
  if (!d) return { feesPaid: 0, netFunding: 0 };
  const since = openTime(d.fills, coin);
  const feesPaid = d.fills.filter((f) => f.coin === coin && f.time >= since).reduce((t, f) => t + Number(f.fee) + Number(f.builderFee ?? 0), 0);
  // userFunding usdc is signed from the user's side: positive = received
  const netFunding = d.funding.filter((f) => f.delta.coin === coin && f.time >= since).reduce((t, f) => t + Number(f.delta.usdc), 0);
  return { feesPaid, netFunding };
}

/** Pure: break-even per coin held on any leg. */
export function breakevens(s: OwnerSnapshot, data: LegPnlData[]): CoinBreakeven[] {
  const coins = [...new Set(s.legs.flatMap((l) => l.clearinghouse.assetPositions.filter((p) => Number(p.position.szi) !== 0).map((p) => p.position.coin)))];
  return coins.map((coin) => {
    const legs: HedgeLeg[] = [];
    let rate = 0;
    for (const l of s.legs) {
      const p = position(l.clearinghouse, coin);
      const szi = Number(p?.szi ?? 0);
      if (!p || szi === 0) continue;
      const d = data.find((x) => x.leg === l.leg);
      rate = Math.max(rate, d?.takerRate ?? DEFAULT_TAKER_RATE);
      legs.push({ side: szi > 0 ? 'long' : 'short', size: Math.abs(szi), entryPx: Number(p.entryPx), ...legCosts(d, coin) });
    }
    const mark = Number(s.market.mids[coin] ?? legs[0]!.entryPx);
    const netSize = legs.reduce((t, l) => t + (l.side === 'long' ? l.size : -l.size), 0);
    const be = breakeven({ legs, closeFeeRate: rate, markPx: mark });
    return {
      coin,
      netSize,
      breakEvenPx: be.kind === 'price' ? be.price : null,
      lockedPnl: be.kind === 'locked' ? be.lockedPnl : null,
      kind: be.kind,
      feesPaid: legs.reduce((t, l) => t + l.feesPaid, 0),
      netFunding: legs.reduce((t, l) => t + l.netFunding, 0),
      estCloseFees: rate * mark * legs.reduce((t, l) => t + l.size, 0),
    };
  });
}

/** Reads fills, fee rate and funding for every leg holding a position. */
export async function readPnlData(hl: HlClient, s: OwnerSnapshot): Promise<LegPnlData[]> {
  const held = s.legs.filter((l) => l.clearinghouse.assetPositions.some((p) => Number(p.position.szi) !== 0));
  return Promise.all(
    held.map(async (l) => {
      const [fills, fees] = await Promise.all([hl.userFills({ user: l.address }), hl.userFees({ user: l.address })]);
      const since = Math.min(...l.clearinghouse.assetPositions.map((p) => openTime(fills, p.position.coin)).filter((t) => t > 0), Date.now());
      const funding = await hl.userFunding({ user: l.address, startTime: since });
      return { leg: l.leg, fills, funding, takerRate: Number(fees.userCrossRate) };
    })
  );
}

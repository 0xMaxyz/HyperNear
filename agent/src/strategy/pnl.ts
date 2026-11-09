// Strategy PnL from the leg's own history, never from equity: realized (closedPnl minus fees of the fills since the strategy
// started) + unrealized at mark (open positions) + funding since the start. A guard top-up or an owner transfer changes the
// account value but none of these, so neither counts as gain or loss.
// shortcut: the leg is dedicated to one strategy and starts flat, so unrealized needs no cost basis from before the start;
// userFills returns the latest 2000 fills, enough for a bot that trades once per interval.
import type { HlClearinghouseState, HlUserFill, HlUserFunding } from '@perps-platform/core';

export interface PnlBreakdown {
  /** closedPnl of the fills since `since`, USD (before fees) */
  realized: number;
  /** fees of those fills, USD (positive = paid) */
  fees: number;
  /** open positions at mark, USD */
  unrealized: number;
  /** funding received (+) or paid (-) since `since`, USD */
  funding: number;
  /** one-time 1 USDC HL activation fee taken from the first top-up of a fresh leg (set by the runner; absent when none) */
  activation?: number;
  /** realized - fees + unrealized + funding - activation */
  total: number;
  fills: number;
}

export function computePnl(since: number, fills: HlUserFill[], ch: Pick<HlClearinghouseState, 'assetPositions'>, funding: HlUserFunding[]): PnlBreakdown {
  const mine = fills.filter((f) => f.time >= since);
  const realized = mine.reduce((a, f) => a + Number(f.closedPnl), 0);
  const fees = mine.reduce((a, f) => a + Number(f.fee), 0);
  const unrealized = ch.assetPositions.reduce((a, p) => a + Number(p.position.unrealizedPnl), 0);
  const fund = funding.filter((x) => x.time >= since).reduce((a, x) => a + Number(x.delta.usdc), 0);
  return { realized, fees, unrealized, funding: fund, total: realized - fees + unrealized + fund, fills: mine.length };
}

/** The three HL reads it needs (HlClient has them; tests pass a fake). */
export interface PnlSource {
  userFills(p: { user: `0x${string}` }): Promise<HlUserFill[]>;
  userFunding(p: { user: `0x${string}`; startTime?: number }): Promise<HlUserFunding[]>;
  clearinghouseState(p: { user: `0x${string}` }): Promise<Pick<HlClearinghouseState, 'assetPositions'>>;
}

export async function strategyPnl(hl: PnlSource, user: `0x${string}`, since: number): Promise<PnlBreakdown> {
  const [fills, ch, funding] = await Promise.all([hl.userFills({ user }), hl.clearinghouseState({ user }), hl.userFunding({ user, startTime: since })]);
  return computePnl(since, fills, ch, funding);
}

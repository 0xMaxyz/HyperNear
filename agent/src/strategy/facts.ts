// Bucketed facts about one running strategy for the decision layer (strategy/decide.ts). Strings only, no raw numbers: Jev
// trusts its state. The buckets are the strategy's own (loss limit, top-up budget, fill rate, slices left, distance to
// liquidation), not the hedge's margin buckets: a 20x bot is "far" from liquidation by the hedge's scale and still close.
import type { Hex } from 'viem';
import type { Facts } from '../decide.ts';
import type { LegState } from '../legs.ts';
import { position } from '../market.ts';
import type { StrategyInput } from './decide.ts';
import type { PnlBreakdown } from './pnl.ts';
import type { StrategySpec } from './spec.ts';

export interface StrategyFactsInput {
  owner: Hex;
  spec: StrategySpec;
  /** The runner's last PnL (pnl.ts); undefined before its first tick. */
  pnl: PnlBreakdown | undefined;
  leg: Pick<LegState, 'clearinghouse'>;
  /** USD of the strategy's daily top-up budget left. */
  topUpLeft: number;
  mid: number;
  annualVol: number;
  /** Orders (grid) or slices (twap) tried, and how many filled. */
  attempts: number;
  fills: number;
  /** TWAP: slices not yet tried. Grid: undefined. */
  slicesLeft?: number;
}

/** PnL against the strategy's loss limit (limits.maxDailyLoss). */
export function pnlBucket(total: number, limit: number): string {
  const loss = -total;
  return loss >= limit ? 'at the loss limit'
    : loss >= limit / 2 ? 'large loss: over half the loss limit'
    : loss > 0.05 * limit ? 'small loss: under half the loss limit'
    : total > 0.05 * limit ? 'profit'
    : 'about flat';
}

export function budgetBucket(left: number, cap: number): string {
  return cap <= 0 ? 'none allowed' : left >= cap ? 'unused' : left <= 0.05 * cap || left < 1 ? 'used up' : left > cap / 2 ? 'partly used' : 'almost used up';
}

export function fillRateBucket(attempts: number, fills: number): string {
  if (attempts === 0) return 'no attempts yet';
  const r = fills / attempts;
  return r < 1 / 3 ? 'low: under a third fill' : r < 0.8 ? 'normal' : 'high: most fill';
}

/** Distance from the mark to the liquidation price of the strategy's position. */
export function liquidationBucket(distance: number | null): string {
  return distance === null ? 'no position' : distance > 0.3 ? 'far: over 30%' : distance > 0.1 ? 'moderate: 10% to 30%' : distance > 0.03 ? 'near: 3% to 10%' : 'very near: under 3%';
}

export function strategyInput(i: StrategyFactsInput): StrategyInput {
  const { spec } = i;
  const p = position(i.leg.clearinghouse as never, spec.coin);
  const liq = p?.liquidationPx == null ? null : Math.abs(i.mid - Number(p.liquidationPx)) / i.mid;
  const outside =
    spec.type === 'grid'
      ? i.mid < spec.params.lower || i.mid > spec.params.upper
      : spec.params.side === 'buy'
        ? i.mid > spec.params.limitPx
        : i.mid < spec.params.limitPx;
  const facts: Facts = {
    strategy: spec.type,
    pnl: i.pnl ? pnlBucket(i.pnl.total, spec.limits.maxDailyLoss) : 'unknown',
    budget: budgetBucket(i.topUpLeft, spec.limits.topUpCapPerDay),
    fillRate: fillRateBucket(i.attempts, i.fills),
    slicesLeft: i.slicesLeft === undefined ? 'not applicable: runs until stopped' : i.slicesLeft === 0 ? 'none left' : i.slicesLeft <= 2 ? 'few left' : 'many left',
    liqDistance: liquidationBucket(Number.isFinite(liq as number) ? liq : null),
    price: spec.type === 'grid' ? (outside ? 'outside the grid range' : 'inside the grid range') : outside ? 'beyond the limit price' : 'inside the limit price',
    vol: i.annualVol < 0.4 ? 'calm' : i.annualVol < 0.8 ? 'normal' : i.annualVol < 1.2 ? 'elevated' : 'extreme',
  };
  return { owner: i.owner, strategyId: spec.id, coin: spec.coin, leg: spec.leg, facts };
}

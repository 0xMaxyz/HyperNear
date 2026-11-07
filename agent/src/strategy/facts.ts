// Bucketed facts about one running strategy for the decision layer (strategy/decide.ts). Strings only, never raw numbers:
// Jev trusts its state, and the buckets are the ones the hedge facts use (facts.ts marginBucket).
import type { Hex } from 'viem';
import type { Facts } from '../decide.ts';
import { marginBucket, marginRatio } from '../facts.ts';
import type { LegState } from '../legs.ts';
import type { StrategyInput } from './decide.ts';
import type { StrategySpec } from './spec.ts';

export interface StrategyFactsInput {
  owner: Hex;
  spec: StrategySpec;
  /** Account value at the start of the day and now (USD), from the runner and the leg snapshot. */
  dayStartEquity: number | undefined;
  leg: Pick<LegState, 'clearinghouse'>;
  /** USD of the strategy's daily top-up budget left. */
  topUpLeft: number;
  mid: number;
  annualVol: number;
  /** TWAP progress, or the number of grid levels holding inventory. */
  progress: { done: number; of: number } | { held: number };
}

export function strategyInput(i: StrategyFactsInput): StrategyInput {
  const { spec } = i;
  const equity = Number(i.leg.clearinghouse.marginSummary.accountValue);
  const delta = i.dayStartEquity === undefined ? 0 : equity - i.dayStartEquity;
  const cap = spec.limits.topUpCapPerDay;
  const outside =
    spec.type === 'grid'
      ? i.mid < spec.params.lower || i.mid > spec.params.upper
      : spec.params.side === 'buy'
        ? i.mid > spec.params.limitPx
        : i.mid < spec.params.limitPx;
  const facts: Facts = {
    strategy: spec.type === 'grid' ? 'grid' : 'twap',
    margin: marginBucket(marginRatio(i.leg.clearinghouse)),
    dayPnl:
      Math.abs(delta) < 0.005 * Math.max(equity, 1) ? 'about flat'
      : delta > 0 ? 'profit'
      : -delta < spec.limits.maxDailyLoss / 2 ? 'small loss: under half the daily loss limit'
      : 'large loss: over half the daily loss limit',
    topUpBudget:
      cap <= 0 ? 'none allowed'
      : i.topUpLeft >= cap ? 'unused'
      : i.topUpLeft > cap / 2 ? 'partly used'
      : 'almost used up',
    price: spec.type === 'grid' ? (outside ? 'outside the grid range' : 'inside the grid range') : outside ? 'beyond the limit price' : 'inside the limit price',
    vol: i.annualVol < 0.4 ? 'calm' : i.annualVol < 0.8 ? 'normal' : i.annualVol < 1.2 ? 'elevated' : 'extreme',
    progress: 'done' in i.progress ? `${i.progress.done} of ${i.progress.of} slices` : i.progress.held ? 'holding inventory' : 'no inventory',
  };
  return { owner: i.owner, strategyId: spec.id, coin: spec.coin, leg: spec.leg, facts };
}

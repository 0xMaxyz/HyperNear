// Grid built-in (pure planner): a long-only ladder of post-only limit orders between `lower` and `upper`.
//   level i holds NO inventory -> a resting buy at price[i] (only while price[i] is below the market)
//   level i holds inventory    -> a resting reduce-only sell at price[i+1] (the next level up; one step above upper for the last)
// Fills move a level between the two states. Exposure is bounded by levels x size x upper, and a sell can never open
// a short (reduce-only), so the worst case is a full ladder of inventory in a falling market, capped by limits.maxNotional.
import type { GridParams } from './spec.ts';
import { roundPx } from '../market.ts';

export interface RestingOrder {
  level: number;
  side: 'buy' | 'sell';
  px: number;
  sz: number;
}

export interface GridState {
  /** Levels that currently hold inventory (bought, not yet sold). */
  held: number[];
  /** Our resting orders by exchange order id. */
  orders: Record<string, RestingOrder>;
}

export const emptyGrid = (): GridState => ({ held: [], orders: {} });

export interface WantedOrder extends RestingOrder {
  reduceOnly: boolean;
}

/** `levels` evenly spaced prices from lower to upper, rounded to the coin's price rule. */
export function gridPrices(p: GridParams, szDecimals: number): number[] {
  const step = (p.upper - p.lower) / (p.levels - 1);
  return Array.from({ length: p.levels }, (_, i) => Number(roundPx(p.lower + i * step, szDecimals)));
}

export interface FillEvent {
  oid: string;
  order: RestingOrder;
}

/** Orders that left the book: filled (seen in the fills) move their level; the rest were cancelled and are forgotten. */
export function reconcile(state: GridState, openOids: Set<string>, filledOids: Set<string>): { state: GridState; filled: FillEvent[]; lost: FillEvent[] } {
  const held = new Set(state.held);
  const orders: Record<string, RestingOrder> = {};
  const filled: FillEvent[] = [];
  const lost: FillEvent[] = [];
  for (const [oid, order] of Object.entries(state.orders)) {
    if (openOids.has(oid)) {
      orders[oid] = order;
    } else if (filledOids.has(oid)) {
      filled.push({ oid, order });
      if (order.side === 'buy') held.add(order.level);
      else held.delete(order.level);
    } else {
      lost.push({ oid, order });
    }
  }
  return { state: { held: [...held].sort((a, b) => a - b), orders }, filled, lost };
}

/** The ladder the strategy wants right now, given the market and which levels hold inventory. */
export function wantedOrders(prices: number[], sz: number, mid: number, held: number[]): WantedOrder[] {
  const step = prices[1]! - prices[0]!;
  const out: WantedOrder[] = [];
  prices.forEach((px, level) => {
    if (held.includes(level)) {
      const sellPx = prices[level + 1] ?? px + step;
      if (sellPx > mid) out.push({ level, side: 'sell', px: sellPx, sz, reduceOnly: true });
    } else if (px < mid) {
      out.push({ level, side: 'buy', px, sz, reduceOnly: false });
    }
  });
  return out;
}

/** Wanted orders that have no resting order yet (same level and side). */
export function missingOrders(wanted: WantedOrder[], orders: Record<string, RestingOrder>): WantedOrder[] {
  const have = new Set(Object.values(orders).map((o) => `${o.level}:${o.side}`));
  return wanted.filter((w) => !have.has(`${w.level}:${w.side}`));
}

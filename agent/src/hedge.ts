// Hedge across two legs: leg0 holds the position, leg1 takes the opposite side for ratio x size.
// plan* functions are pure (used by the live path and by --dry-run on fixtures); Hedger executes them.
import type { Hex } from 'viem';
import type { HlOrderResult } from '@perps-platform/core';
import type { OrderPolicy } from './config.ts';
import type { EventBus } from './events.ts';
import type { Legs, OwnerSnapshot } from './legs.ts';
import { floorSize, position, roundPx } from './market.ts';

/** Hyperliquid's minimum order value. */
export const HL_MIN_NOTIONAL_USD = 10;

export interface PlannedOrder {
  leg: number;
  coin: string;
  asset: number;
  isBuy: boolean;
  size: string;
  /** IOC limit price (mid +- slippage). */
  price: string;
  reduceOnly: boolean;
  notionalUsd: number;
}

export type OpenPlan =
  | { ok: true; leverage: { value: number; isCross: boolean }; order: PlannedOrder }
  | { ok: false; reason: string };

export type ClosePlan = { ok: true; orders: PlannedOrder[] } | { ok: false; reason: string };

function marketOf(s: OwnerSnapshot, coin: string) {
  const a = s.market.assets.find((x) => x.name === coin);
  const mid = Number(s.market.mids[coin]);
  return a && mid > 0 ? { ...a, mid } : undefined;
}

const legOf = (s: OwnerSnapshot, i: number) => s.legs.find((l) => l.leg === i);
const ioc = (mid: number, isBuy: boolean, slippage: number, szDecimals: number) =>
  roundPx(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);

/** Same leverage as leg0, opposite side, ratio x leg0's size, on leg1. Order policy is checked here, before any signing. */
export function planOpenHedge(s: OwnerSnapshot, coin: string, ratio: number, policy: OrderPolicy): OpenPlan {
  if (!policy.allowedCoins.includes(coin)) return { ok: false, reason: `coin ${coin} not allowed (${policy.allowedCoins.join(',')})` };
  if (!(ratio > 0 && ratio <= 1)) return { ok: false, reason: `ratio must be in (0, 1]: ${ratio}` };
  const m = marketOf(s, coin);
  if (!m) return { ok: false, reason: `no market data for ${coin}` };
  const l0 = legOf(s, 0);
  const l1 = legOf(s, 1);
  if (!l0 || !l1) return { ok: false, reason: 'legs 0 and 1 must both be registered' };
  const p0 = position(l0.clearinghouse, coin);
  const szi = Number(p0?.szi ?? 0);
  if (!p0 || szi === 0) return { ok: false, reason: `leg0 has no ${coin} position to hedge` };
  if (Number(position(l1.clearinghouse, coin)?.szi ?? 0) !== 0) return { ok: false, reason: `leg1 already holds ${coin}; close it first` };
  const leverage = p0.leverage.value;
  if (leverage > policy.maxLeverage) return { ok: false, reason: `leverage ${leverage}x above policy max ${policy.maxLeverage}x` };
  if (leverage > m.maxLeverage) return { ok: false, reason: `leverage ${leverage}x above ${coin} max ${m.maxLeverage}x` };
  const size = floorSize(Math.abs(szi) * ratio, m.szDecimals);
  const notionalUsd = Number(size) * m.mid;
  if (Number(size) <= 0 || notionalUsd < HL_MIN_NOTIONAL_USD) {
    return { ok: false, reason: `hedge notional $${notionalUsd.toFixed(2)} below HL minimum $${HL_MIN_NOTIONAL_USD}` };
  }
  if (notionalUsd > policy.maxNotionalUsd) return { ok: false, reason: `hedge notional $${notionalUsd.toFixed(2)} above policy max $${policy.maxNotionalUsd}` };
  const isBuy = szi < 0;
  return {
    ok: true,
    leverage: { value: leverage, isCross: p0.leverage.type === 'cross' },
    order: { leg: 1, coin, asset: m.asset, isBuy, size, price: ioc(m.mid, isBuy, policy.slippage, m.szDecimals), reduceOnly: false, notionalUsd },
  };
}

/** Reduce-only IOC that flattens `coin` on legs 0 and 1. */
export function planCloseHedge(s: OwnerSnapshot, coin: string, policy: OrderPolicy): ClosePlan {
  const m = marketOf(s, coin);
  if (!m) return { ok: false, reason: `no market data for ${coin}` };
  const orders: PlannedOrder[] = [];
  for (const l of s.legs.filter((x) => x.leg === 0 || x.leg === 1)) {
    const szi = Number(position(l.clearinghouse, coin)?.szi ?? 0);
    if (szi === 0) continue;
    const isBuy = szi < 0;
    const size = Math.abs(szi).toFixed(m.szDecimals);
    orders.push({ leg: l.leg, coin, asset: m.asset, isBuy, size, price: ioc(m.mid, isBuy, policy.slippage, m.szDecimals), reduceOnly: true, notionalUsd: Number(size) * m.mid });
  }
  return orders.length ? { ok: true, orders } : { ok: false, reason: `no ${coin} position on legs 0/1` };
}

export class HedgeRefused extends Error {}

/** First order status of an HL order response: the fill, or the error HL returned. */
export function fillOf(r: HlOrderResult) {
  const st = r.response.data.statuses[0] as Record<string, any> | undefined;
  if (!st || 'error' in st) throw new Error(`order rejected: ${st ? st.error : 'no status'}`);
  return (st.filled ?? st.resting) as { oid: number; totalSz?: string; avgPx?: string };
}

export class Hedger {
  readonly legs: Legs;
  readonly policy: OrderPolicy;
  readonly bus?: EventBus;
  constructor(legs: Legs, policy: OrderPolicy, bus?: EventBus) {
    this.legs = legs;
    this.policy = policy;
    this.bus = bus;
  }

  async openHedge(owner: Hex, coin: string, ratio: number) {
    const snap = await this.legs.snapshot(owner);
    const plan = planOpenHedge(snap, coin, ratio, this.policy);
    if (!plan.ok) {
      this.bus?.emit('hedge', { owner, op: 'open', coin, ratio, refused: plan.reason });
      throw new HedgeRefused(plan.reason);
    }
    const o = plan.order;
    const hl = this.legs.tradingClient(owner, o.leg);
    const leverage = await hl.updateLeverage({ asset: o.asset, isCross: plan.leverage.isCross, leverage: plan.leverage.value });
    const res = await hl.limitOrderOpen({ asset: o.asset, isBuy: o.isBuy, price: o.price, size: o.size, tif: 'Ioc' });
    const fill = fillOf(res);
    this.bus?.emit('hedge', { owner, op: 'open', coin, ratio, order: o, leverage: plan.leverage, fill });
    return { plan, leverage, order: res, fill };
  }

  async closeHedge(owner: Hex, coin: string) {
    const snap = await this.legs.snapshot(owner);
    const plan = planCloseHedge(snap, coin, this.policy);
    if (!plan.ok) {
      this.bus?.emit('hedge', { owner, op: 'close', coin, refused: plan.reason });
      throw new HedgeRefused(plan.reason);
    }
    const results = [];
    for (const o of plan.orders) {
      const res = await this.legs
        .tradingClient(owner, o.leg)
        .limitOrderOpen({ asset: o.asset, isBuy: o.isBuy, price: o.price, size: o.size, tif: 'Ioc', reduceOnly: true });
      const fill = fillOf(res);
      this.bus?.emit('hedge', { owner, op: 'close', coin, order: o, fill });
      results.push({ order: o, result: res, fill });
    }
    return { plan, results };
  }
}

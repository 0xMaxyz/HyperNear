// Hedge across two legs: leg0 holds the position, leg1 takes the opposite side for ratio x size.
// plan* functions are pure (used by the live path and by --dry-run on fixtures); Hedger executes them.
import type { Hex } from 'viem';
import type { HlOrderResult } from '@perps-platform/core';
import { makeCloid, newGroup } from './cloid.ts';
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

const cents = (x: number) => Math.round(x * 100) / 100;
const legOf = (s: OwnerSnapshot, i: number) => s.legs.find((l) => l.leg === i);
const ioc = (mid: number, isBuy: boolean, slippage: number, szDecimals: number) =>
  roundPx(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);

/** What the owner may choose for the second leg when opening a hedge; both default to leg 0's setting. Signed with the command (HedgeSpec hash). */
export interface HedgeSpec {
  leg1Leverage?: number;
  leg1IsCross?: boolean;
}

/** Exact-shape check of the optional hedge spec the owner signed: no unknown keys, whole-number leverage. */
export function parseHedgeSpec(v: unknown): HedgeSpec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HedgeRefused('hedge spec must be a JSON object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'leg1Leverage' && k !== 'leg1IsCross') throw new HedgeRefused(`${k} is not a hedge spec field`);
  if (o.leg1Leverage !== undefined && !(Number.isInteger(o.leg1Leverage) && (o.leg1Leverage as number) >= 1)) throw new HedgeRefused('leg1Leverage must be a whole number of at least 1');
  if (o.leg1IsCross !== undefined && typeof o.leg1IsCross !== 'boolean') throw new HedgeRefused('leg1IsCross must be true or false');
  return o as HedgeSpec;
}

/** Opposite side, ratio x leg0's size, on leg1, at leg0's leverage unless the hedge spec says otherwise. Order policy is checked here, before any signing. */
export function planOpenHedge(s: OwnerSnapshot, coin: string, ratio: number, policy: OrderPolicy, spec: HedgeSpec = {}): OpenPlan {
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
  const leverage = spec.leg1Leverage ?? p0.leverage.value;
  if (leverage > policy.maxLeverage) return { ok: false, reason: `leverage ${leverage}x above policy max ${policy.maxLeverage}x` };
  if (leverage > m.maxLeverage) return { ok: false, reason: `leverage ${leverage}x above ${coin} max ${m.maxLeverage}x` };
  const size = floorSize(Math.abs(szi) * ratio, m.szDecimals);
  const notionalUsd = cents(Number(size) * m.mid);
  if (Number(size) <= 0 || notionalUsd < HL_MIN_NOTIONAL_USD) {
    return { ok: false, reason: `hedge notional $${notionalUsd.toFixed(2)} below HL minimum $${HL_MIN_NOTIONAL_USD}` };
  }
  if (notionalUsd > policy.maxNotionalUsd) return { ok: false, reason: `hedge notional $${notionalUsd.toFixed(2)} above policy max $${policy.maxNotionalUsd}` };
  const isBuy = szi < 0;
  return {
    ok: true,
    leverage: { value: leverage, isCross: spec.leg1IsCross ?? p0.leverage.type === 'cross' },
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
    orders.push({ leg: l.leg, coin, asset: m.asset, isBuy, size, price: ioc(m.mid, isBuy, policy.slippage, m.szDecimals), reduceOnly: true, notionalUsd: cents(Number(size) * m.mid) });
  }
  return orders.length ? { ok: true, orders } : { ok: false, reason: `no ${coin} position on legs 0/1` };
}

export type DecisionPlan = { ok: true; orders: PlannedOrder[] } | { ok: false; reason: string };

/**
 * Orders for an accepted decision (decide.ts Action), checked against the same order policy as the hedge routes.
 * leg0 holds the long, leg1 the short (facts.ts only proposes for that layout). One add/reduce step is
 * `step` x the larger leg's size (decide.ts stepFraction, default 0.25).
 */
export function planDecision(s: OwnerSnapshot, action: string, coin: string, policy: OrderPolicy, step = 0.25): DecisionPlan {
  if (action === 'hold') return { ok: true, orders: [] };
  if (action === 'close_both') return planCloseHedge(s, coin, policy);
  if (!policy.allowedCoins.includes(coin)) return { ok: false, reason: `coin ${coin} not allowed (${policy.allowedCoins.join(',')})` };
  const m = marketOf(s, coin);
  if (!m) return { ok: false, reason: `no market data for ${coin}` };
  const l0 = legOf(s, 0);
  const l1 = legOf(s, 1);
  const p0 = l0 && position(l0.clearinghouse, coin);
  const p1 = l1 && position(l1.clearinghouse, coin);
  const s0 = Number(p0?.szi ?? 0);
  const s1 = Number(p1?.szi ?? 0);
  if (!p0 || !p1 || !(s0 > 0 && s1 < 0)) return { ok: false, reason: `no open ${coin} hedge (leg0 long, leg1 short)` };
  const order = (leg: number, isBuy: boolean, sz: number, reduceOnly: boolean, wholeLeg = false): DecisionPlan => {
    const size = floorSize(sz, m.szDecimals);
    const notionalUsd = cents(Number(size) * m.mid);
    // closing a whole leg is not held to the minimum (as in planCloseHedge)
    if (Number(size) <= 0 || (!wholeLeg && notionalUsd < HL_MIN_NOTIONAL_USD)) return { ok: false, reason: `order notional $${notionalUsd.toFixed(2)} below HL minimum $${HL_MIN_NOTIONAL_USD}` };
    if (!reduceOnly && notionalUsd > policy.maxNotionalUsd) return { ok: false, reason: `order notional $${notionalUsd.toFixed(2)} above policy max $${policy.maxNotionalUsd}` };
    return { ok: true, orders: [{ leg, coin, asset: m.asset, isBuy, size, price: ioc(m.mid, isBuy, policy.slippage, m.szDecimals), reduceOnly, notionalUsd }] };
  };
  const stepSz = step * Math.max(s0, -s1);
  switch (action) {
    case 'reduce_hedge':
      return order(1, true, Math.min(stepSz, -s1), true);
    case 'add_hedge':
      if (p1.leverage.value > policy.maxLeverage) return { ok: false, reason: `leg1 leverage ${p1.leverage.value}x above policy max ${policy.maxLeverage}x` };
      return order(1, false, stepSz, false);
    case 'take_profit': {
      const u0 = Number(p0.unrealizedPnl);
      const u1 = Number(p1.unrealizedPnl);
      if (u0 <= 0 && u1 <= 0) return { ok: false, reason: 'neither leg is in profit' };
      return u0 >= u1 ? order(0, false, s0, true, true) : order(1, true, -s1, true, true);
    }
    default:
      return { ok: false, reason: `unknown action ${action}` };
  }
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

  async openHedge(owner: Hex, coin: string, ratio: number, spec: HedgeSpec = {}) {
    const snap = await this.legs.snapshot(owner);
    const plan = planOpenHedge(snap, coin, ratio, this.policy, spec);
    if (!plan.ok) {
      this.bus?.emit('hedge', { owner, op: 'open', coin, ratio, refused: plan.reason });
      throw new HedgeRefused(plan.reason);
    }
    const o = plan.order;
    const hl = this.legs.tradingClient(owner, o.leg);
    const leverage = await hl.updateLeverage({ asset: o.asset, isCross: plan.leverage.isCross, leverage: plan.leverage.value });
    const res = await hl.limitOrderOpen({ asset: o.asset, isBuy: o.isBuy, price: o.price, size: o.size, tif: 'Ioc', c: makeCloid('hedgeOpen', newGroup()) });
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
    return { plan, results: await this.runOrders(owner, 'close', coin, plan.orders) };
  }

  /** IOC orders in sequence with each leg's agent key; stops at the first rejected order. */
  async runOrders(owner: Hex, op: string, coin: string, orders: PlannedOrder[]) {
    const results = [];
    const group = newGroup();
    for (const o of orders) {
      const res = await this.legs
        .tradingClient(owner, o.leg)
        .limitOrderOpen({ asset: o.asset, isBuy: o.isBuy, price: o.price, size: o.size, tif: 'Ioc', reduceOnly: o.reduceOnly, c: makeCloid(o.reduceOnly ? 'hedgeClose' : 'hedgeOpen', group) });
      const fill = fillOf(res);
      this.bus?.emit('hedge', { owner, op, coin, order: o, fill });
      results.push({ order: o, result: res, fill });
    }
    return results;
  }
}

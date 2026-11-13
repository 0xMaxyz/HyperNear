// Open a hedged position in one action: leg 0 takes `side`, leg 1 the opposite side at `ratio` x leg 0's size, both at market (IOC at the touch).
// Two accounts cannot share an exchange request, so this is not atomic on Hyperliquid: both orders are sent at the same moment off ONE order-book
// read, and if the pair does not both fill the surplus side is reduced again (reconcile). The owner signs specHash(HedgePairSpec) like any order.
import type { Hex } from 'viem';
import { RelayRejectionError, type HlOrderResult } from '@perps-platform/core';
import { makeCloid, newGroup } from './cloid.ts';
import type { OrderPolicy } from './config.ts';
import type { EventBus } from './events.ts';
import { HL_MIN_NOTIONAL_USD } from './hedge.ts';
import type { Legs } from './legs.ts';
import { floorSize, position, roundPx } from './market.ts';
import { legAndMarket, type OrderContext } from './order.ts';
import { OrderRefused, statusesOf } from './orders.ts';

export interface HedgePairSpec {
  coin: string;
  /** leg 0's side; leg 1 takes the other */
  side: 'long' | 'short';
  /** leg 0's size in base units */
  size: string;
  /** leg 1's size as a share of leg 0's, decimal string in [0.1, 1] */
  ratio: string;
  leverageA: number;
  /** default: leverageA */
  leverageB?: number;
  /** default: true (cross) */
  isCrossA?: boolean;
  /** default: isCrossA */
  isCrossB?: boolean;
  /** refuse up front when the book's bid-ask spread is wider than this (default 15) */
  maxSpreadBps?: number;
}

export interface HedgePairPlan {
  asset: number;
  szDecimals: number;
  mid: number;
  /** the two legs' trading addresses (to look up fills by cloid if a reply is lost) */
  addresses: [Hex, Hex];
  isBuyA: boolean;
  sizeA: string;
  sizeB: string;
  notionalA: number;
  notionalB: number;
  leverageA: { value: number; isCross: boolean };
  leverageB: { value: number; isCross: boolean };
  maxSpreadBps: number;
}
export type HedgePairCheck = { ok: true; spec: HedgePairSpec; plan: HedgePairPlan } | { ok: false; errors: string[] };

export const DEFAULT_MAX_SPREAD_BPS = 15;
/** extra room beyond the touch for the IOC prices; capped by the policy slippage */
export const ENTRY_BUFFER = 0.0015;
const KEYS = ['coin', 'side', 'size', 'ratio', 'leverageA', 'leverageB', 'isCrossA', 'isCrossB', 'maxSpreadBps'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDec = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * Accepts the spec exactly as sent or lists every reason it cannot run. Pure.
 * `combinedCap`: a 1-click session signed it, so both legs together count against the notional cap (an owner signature allows the cap per leg).
 */
export function validateHedgePairSpec(input: unknown, ctx: OrderContext, opts: { combinedCap?: boolean } = {}): HedgePairCheck {
  if (!isObj(input)) return { ok: false, errors: ['hedge spec must be a JSON object'] };
  const errors: string[] = [];
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push(`${k} is not a field of a hedge pair spec`);
  if (input.side !== 'long' && input.side !== 'short') errors.push('side must be "long" or "short"');
  const a0 = legAndMarket(ctx, 0, input.coin, errors);
  const a1 = legAndMarket(ctx, 1, input.coin, errors);
  if (!a0 || !a1 || errors.length) return { ok: false, errors };
  const { a, mid } = a0;
  const spec = input as unknown as HedgePairSpec;
  const coin = spec.coin;

  let sizeA = 0;
  if (!isDec(spec.size)) errors.push('size must be a positive decimal string');
  else if (Number(floorSize(Number(spec.size), a.szDecimals)) !== Number(spec.size)) errors.push(`size ${spec.size} has more than ${a.szDecimals} decimals`);
  else sizeA = Number(spec.size);
  const ratio = isDec(spec.ratio) ? Number(spec.ratio) : NaN;
  if (!(ratio >= 0.1 && ratio <= 1)) errors.push('ratio must be a decimal string from 0.1 to 1');
  const sizeB = Number.isFinite(ratio) ? Number(floorSize(sizeA * ratio, a.szDecimals)) : 0;

  const lev = (name: 'leverageA' | 'leverageB', v: unknown): number => {
    if (!Number.isInteger(v) || (v as number) < 1) {
      errors.push(`${name} must be a whole number of at least 1`);
      return 0;
    }
    const limit = Math.min(ctx.policy.maxLeverage, a.maxLeverage);
    if ((v as number) > limit) errors.push(`${name} ${v}x is above the ${(v as number) > ctx.policy.maxLeverage ? 'policy' : coin} maximum ${limit}x`);
    return v as number;
  };
  const levA = lev('leverageA', spec.leverageA);
  const levB = spec.leverageB === undefined ? levA : lev('leverageB', spec.leverageB);
  for (const k of ['isCrossA', 'isCrossB'] as const) if (spec[k] !== undefined && typeof spec[k] !== 'boolean') errors.push(`${k} must be true or false`);
  if (spec.maxSpreadBps !== undefined && !(Number.isFinite(spec.maxSpreadBps) && spec.maxSpreadBps > 0 && spec.maxSpreadBps <= 500)) errors.push('maxSpreadBps must be a number above 0 and at most 500');

  // both legs must be flat in the coin: this opens a NEW hedge (an existing position is hedged with openHedge)
  for (const [n, l] of [[0, a0.l], [1, a1.l]] as const) {
    if (Number(position(l.clearinghouse, coin)?.szi ?? 0) !== 0) errors.push(`leg ${n} already holds ${coin}: close it first, or hedge the existing position instead`);
  }

  const notionalA = cents(sizeA * mid);
  const notionalB = cents(sizeB * mid);
  const cap = ctx.policy.maxNotionalUsd;
  if (sizeA > 0) {
    if (notionalA < HL_MIN_NOTIONAL_USD) errors.push(`leg 0 notional $${notionalA} is below the Hyperliquid minimum $${HL_MIN_NOTIONAL_USD}`);
    if (sizeB <= 0 || notionalB < HL_MIN_NOTIONAL_USD) errors.push(`leg 1 notional $${notionalB} is below the Hyperliquid minimum $${HL_MIN_NOTIONAL_USD}: raise the size or the ratio`);
    if (opts.combinedCap ? notionalA + notionalB > cap : Math.max(notionalA, notionalB) > cap) {
      errors.push(opts.combinedCap ? `both legs together ($${cents(notionalA + notionalB)}) are above the session's notional cap $${cap}` : `leg notional $${Math.max(notionalA, notionalB)} is above the policy maximum $${cap}`);
    }
  }
  // margin each leg needs, with a small cushion for fees and the price moving: refused before anything is sent
  const crossA = spec.isCrossA ?? true;
  const crossB = spec.isCrossB ?? crossA;
  for (const [n, l, notional, lv] of [[0, a0.l, notionalA, levA], [1, a1.l, notionalB, levB]] as const) {
    const need = lv > 0 ? (notional / lv) * 1.05 : 0;
    if (need > Number(l.clearinghouse.withdrawable) + 1e-9) errors.push(`leg ${n} has $${Number(l.clearinghouse.withdrawable).toFixed(2)} available but needs about $${need.toFixed(2)} margin`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    spec,
    plan: {
      asset: a.asset,
      szDecimals: a.szDecimals,
      mid,
      addresses: [a0.l.address, a1.l.address],
      isBuyA: spec.side === 'long',
      sizeA: floorSize(sizeA, a.szDecimals),
      sizeB: floorSize(sizeB, a.szDecimals),
      notionalA,
      notionalB,
      leverageA: { value: levA, isCross: crossA },
      leverageB: { value: levB, isCross: crossB },
      maxSpreadBps: spec.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS,
    },
  };
}

export interface LegOutcome {
  leg: number;
  isBuy: boolean;
  requested: string;
  filled: number;
  avgPx: number | null;
  /** the exchange's verdict or the failure, when nothing (or not everything) filled */
  error?: string;
}
export type PairStatus = 'filled' | 'trimmed' | 'unwound' | 'unbalanced' | 'failed';
export interface HedgePairResult {
  status: PairStatus;
  legs: [LegOutcome, LegOutcome];
  /** reduce-only orders sent to bring the pair back to the ratio */
  unwind: LegOutcome[];
  /** |avg fill A - avg fill B| as bps of the mid, when both filled */
  spreadBps: number | null;
  /** the book the prices came from */
  book: { bid: number; ask: number; spreadBps: number };
  /** size still open per leg after everything (what the owner must look at when status is unbalanced) */
  open: [number, number];
  notes: string[];
}

interface Fill {
  sz: number;
  px: number;
  error?: string;
  /** neither a fill nor an exchange verdict (network error, timeout): look the order up by its cloid */
  unknown?: boolean;
}

function outcomeOf(r: PromiseSettledResult<HlOrderResult>): Fill {
  if (r.status === 'rejected') {
    const e = r.reason;
    const verdict = e instanceof OrderRefused || e instanceof RelayRejectionError;
    return { sz: 0, px: 0, error: e instanceof RelayRejectionError ? e.reason : (e as Error).message, unknown: !verdict };
  }
  try {
    const st = statusesOf(r.value)[0];
    return st?.filled ? { sz: Number(st.filled.sz), px: Number(st.filled.px) } : { sz: 0, px: 0, error: 'not filled' };
  } catch (e) {
    return { sz: 0, px: 0, error: (e as Error).message };
  }
}

const bps = (x: number) => Math.round(x * 100) / 100;

export class HedgePairExecutor {
  readonly legs: Legs;
  readonly policy: OrderPolicy;
  readonly bus?: EventBus;
  constructor(legs: Legs, policy: OrderPolicy, bus?: EventBus) {
    this.legs = legs;
    this.policy = policy;
    this.bus = bus;
  }

  /** `spec` and `plan` come from validateHedgePairSpec on a fresh snapshot of `owner`. */
  async open(owner: Hex, spec: HedgePairSpec, plan: HedgePairPlan): Promise<HedgePairResult> {
    const { coin } = spec;
    const { asset, szDecimals, isBuyA } = plan;
    const book = await this.legs.hl.l2Book({ coin });
    const bid = Number(book?.levels[0][0]?.px);
    const ask = Number(book?.levels[1][0]?.px);
    if (!book || !(bid > 0) || !(ask > 0)) throw new OrderRefused(`no order book for ${coin}`);
    if (Math.abs(Date.now() - book.time) > 10_000) throw new OrderRefused(`the ${coin} order book is stale; try again`);
    const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 1e4;
    if (spreadBps > plan.maxSpreadBps) throw new OrderRefused(`the ${coin} book spread is ${bps(spreadBps)} bps, wider than the ${plan.maxSpreadBps} bps limit; nothing was sent`);

    const buf = Math.min(ENTRY_BUFFER, this.policy.slippage);
    // the same book for both legs: a buy crosses at the ask, a sell at the bid, plus the buffer
    const px = (isBuy: boolean) => roundPx(isBuy ? ask * (1 + buf) : bid * (1 - buf), szDecimals);
    const group = newGroup();
    await Promise.all([
      this.legs.tradingClient(owner, 0).updateLeverage({ asset, isCross: plan.leverageA.isCross, leverage: plan.leverageA.value }),
      this.legs.tradingClient(owner, 1).updateLeverage({ asset, isCross: plan.leverageB.isCross, leverage: plan.leverageB.value }),
    ]).catch((e) => {
      throw new OrderRefused(`could not set the leverage: ${e instanceof RelayRejectionError ? e.reason : (e as Error).message}; nothing was sent`);
    });

    const cloids = [makeCloid('hedgeOpen', group), makeCloid('hedgeOpen', group)] as const;
    const sides = [isBuyA, !isBuyA] as const;
    const sizes = [plan.sizeA, plan.sizeB] as const;
    const t0 = Date.now();
    const sent = await Promise.allSettled(
      ([0, 1] as const).map((i) => this.legs.tradingClient(owner, i).limitOrderOpen({ asset, isBuy: sides[i], price: px(sides[i]), size: sizes[i], tif: 'Ioc', c: cloids[i] })),
    );
    const fills = await Promise.all(
      sent.map(async (r, i) => {
        const o = outcomeOf(r);
        // a lost reply may still have filled: the fills know. Nothing found keeps the original error.
        const found = o.unknown ? await this.fillByCloid(plan.addresses[i], cloids[i]!, t0) : undefined;
        return found && found.sz > 0 ? found : o;
      }),
    );
    const outcome = (i: 0 | 1, f: Fill): LegOutcome => ({ leg: i, isBuy: sides[i], requested: sizes[i], filled: f.sz, avgPx: f.sz > 0 ? f.px : null, ...(f.error && f.sz < Number(sizes[i]) ? { error: f.error } : {}) });
    const legsOut: [LegOutcome, LegOutcome] = [outcome(0, fills[0]!), outcome(1, fills[1]!)];

    const result = await this.reconcile(owner, spec, plan, legsOut, { bid, ask });
    this.bus?.emit('hedge', { owner, op: 'pair', coin, status: result.status, legs: result.legs, unwind: result.unwind, spreadBps: result.spreadBps, open: result.open });
    return { ...result, book: { bid, ask, spreadBps: bps(spreadBps) } };
  }

  /** What an order filled, by its cloid, when the reply was lost. Undefined if the fills cannot be read. */
  private async fillByCloid(address: Hex, cloid: Hex, since: number): Promise<Fill | undefined> {
    try {
      const mine = (await this.legs.hl.userFills({ user: address })).filter((f) => f.cloid?.toLowerCase() === cloid.toLowerCase() && f.time >= since - 5_000);
      const sz = mine.reduce((s, f) => s + Number(f.sz), 0);
      return sz > 0 ? { sz, px: mine.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0) / sz } : { sz: 0, px: 0, error: 'no fill found for the order' };
    } catch {
      return undefined;
    }
  }

  /**
   * One rule: leg 1 should hold ratio x what leg 0 filled. The side that holds more than that is reduced with reduce-only IOC orders
   * (a new cloid group, kind hedgeClose, so history does not fold them into the open). A surplus under 1% of the position is left;
   * a surplus that cannot be closed (below the exchange minimum, or the order failed) is reported as `unbalanced`, never hidden.
   */
  private async reconcile(owner: Hex, spec: HedgePairSpec, plan: HedgePairPlan, legs: [LegOutcome, LegOutcome], touch: { bid: number; ask: number }): Promise<Omit<HedgePairResult, 'book'>> {
    const { asset, szDecimals } = plan;
    const ratio = Number(spec.ratio);
    const [a, b] = [legs[0].filled, legs[1].filled];
    const notes: string[] = [];
    const dp = (x: number) => Number(floorSize(Math.max(0, x), szDecimals));
    const spreadBps = a > 0 && b > 0 ? bps((Math.abs(legs[0].avgPx! - legs[1].avgPx!) / plan.mid) * 1e4) : null;
    const open: [number, number] = [a, b];
    const unwind: LegOutcome[] = [];

    if (a === 0 && b === 0) return { status: 'failed', legs, unwind, spreadBps, open, notes: [`nothing filled: ${legs[0].error ?? 'leg 0 not filled'}; ${legs[1].error ?? 'leg 1 not filled'}`] };

    const bTarget = dp(a * ratio);
    // which leg is too big, and by how much
    const surplus = b > bTarget + 1e-12 ? { leg: 1 as const, size: dp(b - bTarget), whole: bTarget === 0 } : b < bTarget - 1e-12 ? { leg: 0 as const, size: dp(a - b / ratio), whole: b === 0 } : undefined;
    // 1% of the larger leg, and never less than a lot and a half (the sizes are rounded down to a lot)
    const tolerance = Math.max(Math.max(a, b) * 0.01, 1.5 * 10 ** -szDecimals);
    if (!surplus || surplus.size <= tolerance) {
      const full = a >= Number(legs[0].requested) - 1e-12 && b >= Number(legs[1].requested) - 1e-12;
      return { status: full ? 'filled' : 'trimmed', legs, unwind, spreadBps, open, notes: full ? [] : ['partially filled, but in the requested ratio'] };
    }

    const l = surplus.leg;
    const wasBuy = legs[l].isBuy;
    const notional = surplus.size * plan.mid;
    if (!surplus.whole && notional < HL_MIN_NOTIONAL_USD) {
      notes.push(`leg ${l} holds ${surplus.size} ${spec.coin} more than the ratio, worth $${notional.toFixed(2)}: below the exchange minimum, so it was left open`);
      return { status: 'unbalanced', legs, unwind, spreadBps, open, notes };
    }
    // reduce: a long is reduced by a sell at the bid, a short by a buy at the ask, with the policy slippage as room
    const price = roundPx(wasBuy ? touch.bid * (1 - this.policy.slippage) : touch.ask * (1 + this.policy.slippage), szDecimals);
    const size = surplus.whole ? (l === 0 ? a : b).toFixed(szDecimals) : surplus.size.toFixed(szDecimals);
    const group = newGroup();
    const r = await Promise.allSettled([this.legs.tradingClient(owner, l).limitOrderOpen({ asset, isBuy: !wasBuy, price, size, tif: 'Ioc', reduceOnly: true, c: makeCloid('hedgeClose', group) })]);
    const f = outcomeOf(r[0]!);
    unwind.push({ leg: l, isBuy: !wasBuy, requested: size, filled: f.sz, avgPx: f.sz > 0 ? f.px : null, ...(f.error && f.sz < Number(size) ? { error: f.error } : {}) });
    open[l] = Math.max(0, open[l] - f.sz);
    const remaining = l === 0 ? open[0] - dp(open[1] / ratio) : open[1] - dp(open[0] * ratio);
    if (remaining > tolerance) {
      notes.push(`could not bring leg ${l} back to the ratio (${f.error ?? 'partly filled'}); ${remaining.toFixed(szDecimals)} ${spec.coin} is still open on it`);
      return { status: 'unbalanced', legs, unwind, spreadBps, open, notes };
    }
    notes.push(`leg ${l} filled ${l === 0 ? a : b} against ${l === 0 ? b : a} on the other leg; the surplus ${size} ${spec.coin} was closed again`);
    return { status: open[0] === 0 || open[1] === 0 ? 'unwound' : 'trimmed', legs, unwind, spreadBps, open, notes };
  }
}

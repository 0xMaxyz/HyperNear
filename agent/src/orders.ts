// Runs a validated order or cancel on the leg's own agent key. Every order carries a cloid (cloid.ts) so history can say what it was for.
import type { Hex } from 'viem';
import { RelayRejectionError, type HlOrderInput, type HlOrderResult } from '@perps-platform/core';
import { makeCloid, newGroup } from './cloid.ts';
import type { OrderPolicy } from './config.ts';
import type { EventBus } from './events.ts';
import type { Legs } from './legs.ts';
import { roundPx } from './market.ts';
import type { CancelSpec, ModifyCheck, OrderPlan, OrderSpec, ProtectLegPlan, ProtectSpec } from './order.ts';

export class OrderRefused extends Error {}

export interface ProtectLegResult {
  leg: number;
  ok: boolean;
  /** triggers placed on the leg */
  placed: number;
  /** old triggers cancelled */
  cancelled: number[];
  error?: string;
}
export interface ProtectResult {
  spec: ProtectSpec;
  status: 'ok' | 'partial' | 'failed';
  legs: ProtectLegResult[];
}

export interface PlacedStatus {
  oid?: number;
  /** present when the order filled at once */
  filled?: { sz: string; px: string };
  resting?: boolean;
}

/** HL answers an `order` action with one status per order; an error status means that order was refused. */
export function statusesOf(r: HlOrderResult): PlacedStatus[] {
  return r.response.data.statuses.map((raw) => {
    // a trigger order answers with the bare string "waitingForTrigger" (seen on testnet): it rests until the price is reached
    if (typeof raw === 'string') return { resting: true };
    const st = raw as Record<string, any>;
    if ('error' in st) throw new OrderRefused(String(st.error));
    const f = st.filled as { oid: number; totalSz: string; avgPx: string } | undefined;
    const rest = st.resting as { oid: number } | undefined;
    return f ? { oid: f.oid, filled: { sz: f.totalSz, px: f.avgPx } } : { oid: rest?.oid, resting: Boolean(rest) };
  });
}

/** An exchange verdict (rejected order, bad nonce window...) is an outcome for the owner, not a server fault. */
async function verdict<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RelayRejectionError) throw new OrderRefused(e.reason);
    throw e;
  }
}

export class OrderExecutor {
  readonly legs: Legs;
  readonly policy: OrderPolicy;
  readonly bus?: EventBus;
  constructor(legs: Legs, policy: OrderPolicy, bus?: EventBus) {
    this.legs = legs;
    this.policy = policy;
    this.bus = bus;
  }

  /** `spec` and `plan` come from validateOrderSpec on a fresh snapshot. */
  async place(owner: Hex, spec: OrderSpec, plan: OrderPlan) {
    const hl = this.legs.tradingClient(owner, spec.leg);
    const { asset, isBuy, szDecimals, mid } = plan;
    const c = makeCloid(plan.kind, newGroup());
    const reduceOnly = spec.type === 'trailing' || spec.reduceOnly === true;
    // the price an IOC "market" order crosses at: mid (or the trigger) moved by the policy slippage
    const cross = (ref: number) => roundPx(ref * (isBuy ? 1 + this.policy.slippage : 1 - this.policy.slippage), szDecimals);
    const run = async () => {
      if (plan.leverage) await hl.updateLeverage({ asset, isCross: plan.leverage.isCross, leverage: plan.leverage.value });
      // an opening market / limit with TP/SL: one normalTpsl group, entry first, then the reduce-only triggers for the same size
      if ((spec.type === 'market' || spec.type === 'limit') && (spec.tpPx || spec.slPx)) {
        const tif = spec.type === 'market' ? 'Ioc' : (spec.tif ?? 'Gtc');
        const entry: HlOrderInput = { a: asset, b: isBuy, p: spec.type === 'market' ? cross(mid) : spec.limitPx!, s: spec.size!, r: reduceOnly, t: { limit: { tif } }, c };
        // the children close the position: they cross on the other side
        const away = (px: string) => roundPx(Number(px) * (isBuy ? 1 - this.policy.slippage : 1 + this.policy.slippage), szDecimals);
        const child = (px: string, tpsl: 'tp' | 'sl'): HlOrderInput => ({ a: asset, b: !isBuy, p: away(px), s: spec.size!, r: true, t: { trigger: { isMarket: true, triggerPx: px, tpsl } }, c: makeCloid('protect', newGroup()) });
        const orders = [entry, ...(spec.tpPx ? [child(spec.tpPx, 'tp')] : []), ...(spec.slPx ? [child(spec.slPx, 'sl')] : [])];
        return { statuses: statusesOf(await hl.order({ orders, grouping: 'normalTpsl' })) };
      }
      switch (spec.type) {
        case 'market':
          return { statuses: statusesOf(await hl.limitOrderOpen({ asset, isBuy, price: cross(mid), size: spec.size!, tif: 'Ioc', reduceOnly, c })) };
        case 'limit':
          return { statuses: statusesOf(await hl.limitOrderOpen({ asset, isBuy, price: spec.limitPx!, size: spec.size!, tif: spec.tif ?? 'Gtc', reduceOnly, c })) };
        case 'stopMarket':
        case 'stopLimit':
        case 'takeMarket':
        case 'takeLimit': {
          const isMarket = spec.type.endsWith('Market');
          return {
            statuses: statusesOf(
              await hl.triggerOrderOpen({
                asset,
                isBuy,
                price: isMarket ? cross(Number(spec.triggerPx)) : spec.limitPx!,
                size: spec.size!,
                triggerPx: spec.triggerPx!,
                tpsl: spec.type.startsWith('stop') ? 'sl' : 'tp',
                isMarket,
                reduceOnly,
                c,
              })
            ),
          };
        }
        case 'bracket': {
          // positionTpsl with size "0": the triggers follow the position's size as it changes (verified on testnet)
          const child = (px: string, tpsl: 'tp' | 'sl'): HlOrderInput => ({ a: asset, b: isBuy, p: cross(Number(px)), s: '0', r: true, t: { trigger: { isMarket: true, triggerPx: px, tpsl } }, c: makeCloid('protect', newGroup()) });
          const orders = [...(spec.tpPx ? [child(spec.tpPx, 'tp')] : []), ...(spec.slPx ? [child(spec.slPx, 'sl')] : [])];
          return { statuses: statusesOf(await hl.order({ orders, grouping: 'positionTpsl' })) };
        }
        case 'twap': {
          const r = await hl.twapOrderOpen({ asset, isBuy, size: spec.size!, reduceOnly, durationMinutes: spec.minutes!, randomize: spec.randomize ?? true });
          const st = r.response.data.status as { running?: { twapId: number }; error?: string };
          if (st.error || !st.running) throw new OrderRefused(st.error ?? 'twap refused');
          return { twapId: st.running.twapId };
        }
        case 'trailing': {
          const r = await hl.trailingStopOpen({
            asset,
            isBuy,
            size: spec.size!,
            reduceOnly: true,
            retracement: spec.trailPct !== undefined ? { pct: `${spec.trailPct}%` } : { px: spec.trailPx! },
            activationPx: spec.activationPx ?? null,
          });
          return { statuses: [{ oid: r.response.data.oid, resting: true }] };
        }
      }
    };
    const out = await verdict(run);
    this.bus?.emit('order', { owner, op: 'place', leg: spec.leg, spec, ...out });
    return { spec, plan, ...out };
  }

  /** One Hyperliquid `modify`: the order keeps its size, side, reduce-only flag, time in force and cloid and only the price moves, but the exchange gives it a NEW oid (seen on testnet 2026-11-11): callers must re-read the open orders. */
  async modify(owner: Hex, check: Extract<ModifyCheck, { ok: true }>) {
    const { spec, asset, order: o } = check;
    const hl = this.legs.tradingClient(owner, spec.leg);
    const order: HlOrderInput = { a: asset, b: o.side === 'buy', p: spec.limitPx, s: o.size, r: o.reduceOnly, t: { limit: { tif: o.tif ?? 'Gtc' } }, ...(o.cloid ? { c: o.cloid as Hex } : {}) };
    await verdict(() => hl.modifyOrder({ oid: spec.oid, order }));
    this.bus?.emit('order', { owner, op: 'modify', leg: spec.leg, spec, from: o.limitPx });
    return { spec, modified: spec.oid, from: o.limitPx };
  }

  /**
   * Replace the position take-profit / stop-loss triggers of each named leg. Per leg, concurrently: place the new position-sized bracket first
   * (if that is refused the old protection stays), then cancel the old triggers. One leg failing never undoes the other; the result says which
   * legs ended up how. A leg's new triggers are `positionTpsl` size 0: they follow the position as it is resized.
   */
  async protect(owner: Hex, spec: ProtectSpec, plans: ProtectLegPlan[]): Promise<ProtectResult> {
    const slip = this.policy.slippage;
    const one = async (p: ProtectLegPlan): Promise<ProtectLegResult> => {
      const hl = this.legs.tradingClient(owner, p.leg);
      const user = await this.legs.client.getLeg(owner, p.leg);
      if (!user) throw new OrderRefused(`leg ${p.leg} is not registered`);
      const old = (await this.legs.hl.frontendOpenOrders({ user })).filter((o) => o.coin === spec.coin && o.isPositionTpsl && o.isTrigger).map((o) => o.oid);
      // closing orders: a long is closed by sells, a short by buys; the market trigger's limit price leaves room for slippage
      const child = (px: string, tpsl: 'tp' | 'sl'): HlOrderInput => ({ a: p.asset, b: !p.long, p: roundPx(Number(px) * (p.long ? 1 - slip : 1 + slip), p.szDecimals), s: '0', r: true, t: { trigger: { isMarket: true, triggerPx: px, tpsl } }, c: makeCloid('protect', newGroup()) });
      const orders = [...(p.tpPx ? [child(p.tpPx, 'tp')] : []), ...(p.slPx ? [child(p.slPx, 'sl')] : [])];
      const placed = orders.length ? statusesOf(await verdict(() => hl.order({ orders, grouping: 'positionTpsl' }))).length : 0;
      const cancelled: number[] = [];
      let cancelError: string | undefined;
      for (const oid of old) {
        try {
          await verdict(() => hl.cancelOrder({ asset: p.asset, oid }));
          cancelled.push(oid);
        } catch (e) {
          cancelError = (e as Error).message;
        }
      }
      return { leg: p.leg, ok: !cancelError, placed, cancelled, ...(cancelError ? { error: `the new triggers are set but an old one could not be cancelled: ${cancelError}` } : {}) };
    };
    const settled = await Promise.allSettled(plans.map(one));
    const legs = settled.map((r, i): ProtectLegResult => (r.status === 'fulfilled' ? r.value : { leg: plans[i]!.leg, ok: false, placed: 0, cancelled: [], error: r.reason instanceof OrderRefused ? r.reason.message : String((r.reason as Error)?.message ?? r.reason) }));
    const status = legs.every((l) => l.ok) ? 'ok' : legs.some((l) => l.ok) ? 'partial' : 'failed';
    this.bus?.emit('order', { owner, op: 'protect', spec, status, legs });
    return { spec, status, legs };
  }

  async cancel(owner: Hex, spec: CancelSpec, asset: number) {
    const hl = this.legs.tradingClient(owner, spec.leg);
    const user = await this.legs.client.getLeg(owner, spec.leg);
    if (!user) throw new OrderRefused(`leg ${spec.leg} is not registered`);
    const cancelled: number[] = [];
    await verdict(async () => {
      if (spec.twapId !== undefined) {
        await hl.twapOrderCancel({ asset, twapId: spec.twapId });
        return;
      }
      const oids = spec.oid !== undefined ? [spec.oid] : (await hl.openOrders({ user })).filter((o) => o.coin === spec.coin).map((o) => o.oid);
      for (const oid of oids) {
        await hl.cancelOrder({ asset, oid });
        cancelled.push(oid);
      }
    });
    this.bus?.emit('order', { owner, op: 'cancel', leg: spec.leg, spec, cancelled });
    return { spec, cancelled, ...(spec.twapId !== undefined && { twapId: spec.twapId }) };
  }
}

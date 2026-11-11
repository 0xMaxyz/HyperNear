// The dry run's simulated book: positions, resting orders and TWAPs that signed commands change, laid over the fixture so the pages react to a click.
// Nothing here talks to Hyperliquid; fills happen at the fixture's mid. The rules mirror the live executor closely enough for the UI, not for PnL.
import type { HlClearinghouseState, HlUserFill, HlUserFunding } from '@perps-platform/core';
import type { Hex } from 'viem';
import { makeCloid, newGroup, type CloidKind } from './cloid.ts';
import type { LegState, OwnerSnapshot } from './legs.ts';
import type { CancelSpec, OrderPlan, OrderSpec } from './order.ts';
import { DEFAULT_TAKER_RATE, type LegHistory } from './positions.ts';
import { roundPx } from './market.ts';

type PositionRow = HlClearinghouseState['assetPositions'][number];
interface Pos {
  szi: number;
  entryPx: number;
  leverage: { type: 'cross' | 'isolated'; value: number };
}
interface Resting {
  oid: number;
  leg: number;
  coin: string;
  spec: OrderSpec;
  placedAt: number;
}
interface Twap {
  twapId: number;
  leg: number;
  coin: string;
  side: 'buy' | 'sell';
  size: string;
  minutes: number;
  startedAt: number;
}

export function createDryBook(snap: OwnerSnapshot) {
  const mid = (coin: string) => Number(snap.market.mids[coin]);
  const asset = (coin: string) => snap.market.assets.find((a) => a.name === coin);
  const positions = new Map<string, Pos>();
  const orders: Resting[] = [];
  const twaps: Twap[] = [];
  let nextOid = 9_000_000;
  const key = (leg: number, coin: string) => `${leg}:${coin}`;
  const fills: HlUserFill[] = [];
  const legOfFill = new Map<HlUserFill, number>();
  const record = (leg: number, coin: string, isBuy: boolean, size: number, px: number, startPosition: number, closedPnl: number, kind: CloidKind, group: string, time = Date.now()) => {
    const after = startPosition + (isBuy ? size : -size);
    const dir = startPosition === 0 ? (isBuy ? 'Open Long' : 'Open Short') : Math.sign(after) === Math.sign(startPosition) || after === 0 ? (startPosition > 0 ? 'Close Long' : 'Close Short') : startPosition > 0 ? 'Long > Short' : 'Short > Long';
    const f: HlUserFill = {
      coin, px: String(px), sz: String(size), side: isBuy ? 'B' : 'A', time, startPosition: String(startPosition), dir, closedPnl: closedPnl.toFixed(6),
      hash: `0x${'0'.repeat(64)}`, oid: nextOid++, crossed: true, fee: (size * px * DEFAULT_TAKER_RATE).toFixed(6), tid: nextOid++, feeToken: 'USDC', twapId: null, cloid: makeCloid(kind, group),
    };
    fills.push(f);
    legOfFill.set(f, leg);
  };

  /** the fixture's own position, until the book overrides it */
  const current = (leg: number, coin: string): Pos | undefined => {
    const b = positions.get(key(leg, coin));
    if (b) return b;
    const p = snap.legs.find((l) => l.leg === leg)?.clearinghouse.assetPositions.find((x) => x.position.coin === coin)?.position;
    return p && Number(p.szi) !== 0 ? { szi: Number(p.szi), entryPx: Number(p.entryPx), leverage: p.leverage } : undefined;
  };

  function fill(leg: number, coin: string, isBuy: boolean, size: number, lev: { value: number; isCross: boolean } | undefined, kind: CloidKind, group = newGroup()) {
    const px = mid(coin);
    const have = current(leg, coin);
    const signed = isBuy ? size : -size;
    const reduced = have && Math.sign(have.szi) !== Math.sign(signed) ? Math.min(size, Math.abs(have.szi)) : 0;
    record(leg, coin, isBuy, size, px, have?.szi ?? 0, have ? reduced * (px - have.entryPx) * Math.sign(have.szi) : 0, kind, group);
    const leverage = lev ? { type: lev.isCross ? ('cross' as const) : ('isolated' as const), value: lev.value } : (have?.leverage ?? { type: 'cross' as const, value: 3 });
    if (!have || have.szi === 0) return void positions.set(key(leg, coin), { szi: signed, entryPx: px, leverage });
    const szi = have.szi + signed;
    // adding keeps a weighted entry; reducing keeps the entry; flipping re-enters at the fill
    const entryPx = Math.sign(have.szi) === Math.sign(signed) ? (have.entryPx * Math.abs(have.szi) + px * size) / Math.abs(szi) : Math.sign(szi) === Math.sign(have.szi) ? have.entryPx : px;
    positions.set(key(leg, coin), { szi: Math.abs(szi) < 1e-12 ? 0 : szi, entryPx, leverage: lev ? leverage : have.leverage });
  }

  const row = (coin: string, p: Pos): PositionRow => {
    const m = mid(coin);
    const value = Math.abs(p.szi) * m;
    const upnl = p.szi * (m - p.entryPx);
    const margin = value / p.leverage.value;
    const liq = p.szi > 0 ? p.entryPx * (1 - 0.9 / p.leverage.value) : p.entryPx * (1 + 0.9 / p.leverage.value);
    return {
      type: 'oneWay',
      position: {
        coin,
        szi: String(p.szi),
        leverage: p.leverage,
        entryPx: String(p.entryPx),
        positionValue: value.toFixed(4),
        unrealizedPnl: upnl.toFixed(4),
        returnOnEquity: margin > 0 ? (upnl / margin).toFixed(4) : '0.0',
        liquidationPx: liq.toFixed(1),
        marginUsed: margin.toFixed(4),
        maxLeverage: asset(coin)?.maxLeverage ?? 40,
        cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
      },
    } as PositionRow;
  };

  function overlay(l: LegState): LegState {
    const coins = new Set<string>(l.clearinghouse.assetPositions.map((p) => p.position.coin));
    for (const k of positions.keys()) if (k.startsWith(`${l.leg}:`)) coins.add(k.slice(k.indexOf(':') + 1));
    const rows = [...coins].flatMap((coin) => {
      const p = current(l.leg, coin);
      return p && p.szi !== 0 ? [row(coin, p)] : [];
    });
    const ntl = rows.reduce((s, r) => s + Number(r.position.positionValue), 0);
    const used = rows.reduce((s, r) => s + Number(r.position.marginUsed), 0);
    const ms = { ...l.clearinghouse.marginSummary, totalNtlPos: ntl.toFixed(4), totalMarginUsed: used.toFixed(4) };
    const free = Math.max(0, Number(l.clearinghouse.marginSummary.accountValue) - used);
    return { ...l, clearinghouse: { ...l.clearinghouse, assetPositions: rows, marginSummary: ms, crossMarginSummary: ms, withdrawable: free.toFixed(6) } };
  }

  /** Same shape as the live `statuses` of a placed order. */
  const rest = (leg: number, spec: OrderSpec) => {
    const oid = nextOid++;
    orders.push({ oid, leg, coin: spec.coin, spec, placedAt: Date.now() });
    return { oid, resting: true };
  };

  const api = {
    overlay,
    hedge(action: 'openHedge' | 'closeHedge', plan: { leverage?: { value: number; isCross: boolean }; orders: { leg: number; coin: string; isBuy: boolean; size: string; reduceOnly: boolean }[] }) {
      const group = newGroup();
      for (const o of plan.orders) fill(o.leg, o.coin, o.isBuy, Number(o.size), action === 'openHedge' ? plan.leverage : undefined, action === 'openHedge' ? 'hedgeOpen' : 'hedgeClose', group);
    },
    order(spec: OrderSpec, plan: OrderPlan) {
      const leverage = plan.leverage;
      const m = mid(spec.coin);
      const isBuy = spec.side === 'buy';
      const size = Number(spec.size ?? 0);
      const crosses = spec.type === 'limit' && (spec.tif === 'Ioc' || (isBuy ? Number(spec.limitPx) >= m : Number(spec.limitPx) <= m)) && spec.tif !== 'Alo';
      // TP/SL attached to an opening market / limit: reduce-only triggers on the other side, resting beside the entry
      const attached = () => {
        if (spec.type !== 'market' && spec.type !== 'limit') return [];
        const close: OrderSpec = { leg: spec.leg, coin: spec.coin, side: isBuy ? 'sell' : 'buy', type: 'bracket' };
        return [spec.tpPx && rest(spec.leg, { ...close, tpPx: spec.tpPx }), spec.slPx && rest(spec.leg, { ...close, slPx: spec.slPx })].filter(Boolean);
      };
      if (spec.type === 'market' || crosses) {
        fill(spec.leg, spec.coin, isBuy, size, spec.reduceOnly ? undefined : leverage, plan.kind === 'reduce' ? 'reduce' : 'open');
        return { simulated: true, spec, statuses: [{ oid: nextOid++, filled: { sz: String(size), px: roundPx(m, asset(spec.coin)?.szDecimals ?? 5) } }, ...attached()] };
      }
      if (spec.type === 'twap') {
        const twapId = nextOid++;
        twaps.push({ twapId, leg: spec.leg, coin: spec.coin, side: spec.side, size: String(size), minutes: spec.minutes!, startedAt: Date.now() });
        return { simulated: true, spec, twapId };
      }
      // bracket: one resting trigger per leg of the bracket
      if (spec.type === 'bracket') {
        const statuses = [spec.tpPx && rest(spec.leg, { ...spec, slPx: undefined }), spec.slPx && rest(spec.leg, { ...spec, tpPx: undefined })].filter(Boolean);
        return { simulated: true, spec, statuses };
      }
      return { simulated: true, spec, statuses: [rest(spec.leg, spec), ...attached()] };
    },
    cancel(spec: CancelSpec) {
      const cancelled: number[] = [];
      if (spec.twapId !== undefined) {
        const i = twaps.findIndex((t) => t.twapId === spec.twapId && t.leg === spec.leg);
        if (i >= 0) twaps.splice(i, 1);
        return { simulated: true, spec, cancelled, twapId: spec.twapId };
      }
      for (let i = orders.length - 1; i >= 0; i--) {
        const o = orders[i]!;
        if (o.leg === spec.leg && o.coin === spec.coin && (spec.all || o.oid === spec.oid)) {
          cancelled.push(o.oid);
          orders.splice(i, 1);
        }
      }
      return { simulated: true, spec, cancelled };
    },
    /** GET /orders in the dry run */
    open(_owner: Hex) {
      const typeName = (s: OrderSpec) => ({ market: 'Market', limit: 'Limit', stopMarket: 'Stop Market', stopLimit: 'Stop Limit', takeMarket: 'Take Profit Market', takeLimit: 'Take Profit Limit', bracket: s.tpPx ? 'Take Profit Market' : 'Stop Market', twap: 'TWAP', trailing: 'Trailing Stop' })[s.type];
      return {
        orders: orders.map(({ oid, leg, coin, spec, placedAt }) => {
          const trigger = spec.type === 'bracket' ? (spec.tpPx ?? spec.slPx)! : (spec.triggerPx ?? '0.0');
          return {
            leg, coin, oid, side: spec.side, size: spec.size ?? '0', limitPx: spec.limitPx ?? trigger, orderType: typeName(spec), isTrigger: spec.type !== 'limit',
            triggerPx: spec.type === 'trailing' ? (spec.activationPx ?? '0.0') : trigger, triggerCondition: spec.type === 'trailing' ? 'Trailing' : spec.type === 'limit' ? 'N/A' : `Price ${spec.type.startsWith('take') || spec.tpPx ? (spec.side === 'sell' ? 'above' : 'below') : spec.side === 'sell' ? 'below' : 'above'} ${trigger}`,
            isPositionTpsl: spec.type === 'bracket', reduceOnly: spec.type !== 'limit' && spec.type !== 'market' ? true : spec.reduceOnly === true, placedAt, cloid: null, label: spec.type === 'limit' ? (spec.reduceOnly ? 'reduce' : 'open') : 'protect',
          };
        }),
        twaps: twaps.map((t) => ({ ...t, executedSize: '0.0' })),
      };
    },
    /** fills, funding and fee rate in the shape the live reader returns, so positions.ts computes PnL and history the same way */
    history(): LegHistory[] {
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      return snap.legs.map((l) => ({
        leg: l.leg,
        address: l.address,
        fills: fills.filter((f) => legOfFill.get(f) === l.leg).reverse(),
        funding: l.clearinghouse.assetPositions.flatMap(({ position: p }): HlUserFunding[] => {
          const now = current(l.leg, p.coin);
          return now && now.szi !== 0 ? [1, 2].map((h) => ({ time: hour - h * 3_600_000, hash: `0x${'0'.repeat(64)}` as `0x${string}`, delta: { type: 'funding' as const, coin: p.coin, usdc: (-now.szi * mid(p.coin) * 0.0000125).toFixed(6), szi: String(now.szi), fundingRate: '0.0000125', nSamples: null } })) : [];
        }),
        ledger: [],
        takerRate: DEFAULT_TAKER_RATE,
        activation: l.activation,
      }));
    },
  };
  // the fixture's positions opened two hours ago: leg 1's as a hedge (its cloid says so), the others one-sided
  const hedgeGroup = newGroup();
  for (const l of snap.legs) {
    for (const { position: p } of l.clearinghouse.assetPositions) {
      const szi = Number(p.szi);
      if (szi !== 0) record(l.leg, p.coin, szi > 0, Math.abs(szi), Number(p.entryPx), 0, 0, l.leg === 1 ? 'hedgeOpen' : 'open', l.leg === 1 ? hedgeGroup : newGroup(), Date.now() - 2 * 3_600_000);
    }
  }
  return api;
}

export type DryBook = ReturnType<typeof createDryBook>;

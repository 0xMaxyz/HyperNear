// What an owner may ask one leg to do with one signed command: place or cancel a single order (market, limit, stop/take, bracket, TWAP, trailing).
// The owner signs specHash(spec) of the exact JSON they send (hypernear-client specHash.ts), so validation never rewrites the spec: it accepts it as
// sent or refuses it with every reason. The order policy (coins, leverage, notional) is the same one the hedge routes use; reduce-only orders
// may exceed the notional cap because they can only shrink risk.
import type { OrderPolicy } from './config.ts';
import type { CloidKind } from './cloid.ts';
import type { OwnerSnapshot } from './legs.ts';
import { floorSize, position, roundPx } from './market.ts';
import { HL_MIN_NOTIONAL_USD } from './hedge.ts';

export const ORDER_TYPES = ['market', 'limit', 'stopMarket', 'stopLimit', 'takeMarket', 'takeLimit', 'bracket', 'twap', 'trailing'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const TIFS = ['Gtc', 'Ioc', 'Alo'] as const;
/** HL rejects a TWAP below this notional on testnet (verified in agent/scripts/orders-spike.ts). */
export const HL_MIN_TWAP_USD = 100;
export const TWAP_MINUTES = { min: 5, max: 1440 } as const;

export interface OrderSpec {
  leg: number;
  coin: string;
  side: 'buy' | 'sell';
  type: OrderType;
  /** base units; absent for a bracket (it covers the whole position) */
  size?: string;
  reduceOnly?: boolean;
  /** applied (with isCross) before an order that can open or grow a position */
  leverage?: number;
  isCross?: boolean;
  limitPx?: string;
  triggerPx?: string;
  tif?: (typeof TIFS)[number];
  /** bracket: position take-profit / stop-loss trigger prices. market / limit: TP/SL attached to the opening order
   * (Hyperliquid normalTpsl: reduce-only market triggers for the same size, live once the entry fills) */
  tpPx?: string;
  slPx?: string;
  minutes?: number;
  randomize?: boolean;
  /** trailing: retracement as a percentage ("5" = 5%) or as a price distance, plus the optional mark price where trailing starts */
  trailPct?: string;
  trailPx?: string;
  activationPx?: string;
}

export interface CancelSpec {
  leg: number;
  coin: string;
  /** exactly one of the three */
  oid?: number;
  twapId?: number;
  all?: boolean;
}

/** Moves one resting limit order to a new price (Hyperliquid `modify`: same size, side, time in force and cloid; the exchange assigns a new oid, seen on testnet). */
export interface ModifySpec {
  leg: number;
  coin: string;
  oid: number;
  limitPx: string;
}
/** A resting order as the exchange lists it (frontendOpenOrders, or the dry-run book). */
export interface RestingOrder {
  oid: number;
  coin: string;
  side: 'buy' | 'sell';
  size: string;
  limitPx: string;
  orderType: string;
  isTrigger: boolean;
  reduceOnly: boolean;
  tif?: (typeof TIFS)[number] | null;
  cloid?: string | null;
}
export type ModifyCheck = { ok: true; spec: ModifySpec; asset: number; order: RestingOrder } | { ok: false; errors: string[] };

export interface OrderContext {
  snapshot: OwnerSnapshot;
  policy: OrderPolicy;
  /** legs a running strategy owns: no manual orders there */
  busyLegs?: number[];
}

/** Everything the executor needs, resolved once so the checks and the order use the same numbers. */
export interface OrderPlan {
  asset: number;
  szDecimals: number;
  mid: number;
  isBuy: boolean;
  /** the leg's signed position in the coin now (0 if flat) */
  szi: number;
  notionalUsd: number;
  /** what the cloid will say this order was for */
  kind: CloidKind;
  /** set only when the order may open or grow a position */
  leverage?: { value: number; isCross: boolean };
}

export type OrderCheck = { ok: true; spec: OrderSpec; plan: OrderPlan } | { ok: false; errors: string[] };
export type CancelCheck = { ok: true; spec: CancelSpec; asset: number } | { ok: false; errors: string[] };

const COMMON = ['leg', 'coin', 'side', 'type'];
const FIELDS: Record<OrderType, string[]> = {
  market: ['size', 'reduceOnly', 'leverage', 'isCross', 'tpPx', 'slPx'],
  limit: ['size', 'limitPx', 'tif', 'reduceOnly', 'leverage', 'isCross', 'tpPx', 'slPx'],
  stopMarket: ['size', 'triggerPx', 'reduceOnly', 'leverage', 'isCross'],
  takeMarket: ['size', 'triggerPx', 'reduceOnly', 'leverage', 'isCross'],
  stopLimit: ['size', 'triggerPx', 'limitPx', 'reduceOnly', 'leverage', 'isCross'],
  takeLimit: ['size', 'triggerPx', 'limitPx', 'reduceOnly', 'leverage', 'isCross'],
  bracket: ['tpPx', 'slPx'],
  twap: ['size', 'minutes', 'randomize', 'reduceOnly', 'leverage', 'isCross'],
  trailing: ['size', 'trailPct', 'trailPx', 'activationPx'],
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDec = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
const cents = (x: number) => Math.round(x * 100) / 100;

function legAndMarket(ctx: OrderContext, leg: unknown, coin: unknown, errors: string[]) {
  const { snapshot, policy } = ctx;
  if (!Number.isInteger(leg) || (leg as number) < 0) return void errors.push('leg must be a non-negative integer');
  const l = snapshot.legs.find((x) => x.leg === leg);
  if (!l) return void errors.push(`leg ${leg} is not registered`);
  if (!l.agent?.approvedAt) errors.push(`leg ${leg} has no approved agent key yet (Home: prepare and approve)`);
  if (ctx.busyLegs?.includes(leg as number)) errors.push(`leg ${leg} is running a strategy; stop it first`);
  if (typeof coin !== 'string' || !policy.allowedCoins.includes(coin)) return void errors.push(`coin must be one of ${policy.allowedCoins.join(', ')}`);
  const a = snapshot.market.assets.find((x) => x.name === coin);
  const mid = Number(snapshot.market.mids[coin]);
  if (!a || !(mid > 0)) return void errors.push(`no market data for ${coin}`);
  return { l, a, mid };
}

/** Accepts the spec exactly as sent or lists every reason it cannot run. Pure: reads the snapshot, changes nothing. */
export function validateOrderSpec(input: unknown, ctx: OrderContext): OrderCheck {
  if (!isObj(input)) return { ok: false, errors: ['order spec must be a JSON object'] };
  const errors: string[] = [];
  const type = input.type as OrderType;
  if (!ORDER_TYPES.includes(type)) return { ok: false, errors: [`type must be one of ${ORDER_TYPES.join(', ')}`] };
  const allowed = new Set([...COMMON, ...FIELDS[type]]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) errors.push(`${k} is not a field of a ${type} order`);
  if (input.side !== 'buy' && input.side !== 'sell') errors.push('side must be "buy" or "sell"');
  const found = legAndMarket(ctx, input.leg, input.coin, errors);
  if (!found || errors.length) return { ok: false, errors };
  const { l, a, mid } = found;
  const { policy } = ctx;
  const spec = input as unknown as OrderSpec;
  const isBuy = spec.side === 'buy';
  const coin = spec.coin;
  const pos = position(l.clearinghouse, coin);
  const szi = Number(pos?.szi ?? 0);
  const closingSide = szi > 0 ? 'sell' : 'buy';

  /** a price must already be what HL accepts: the owner signed these exact digits */
  const price = (name: 'limitPx' | 'triggerPx' | 'tpPx' | 'slPx' | 'activationPx' | 'trailPx') => {
    const v = input[name];
    if (!isDec(v)) return void errors.push(`${name} must be a positive decimal string`);
    if (Number(roundPx(Number(v), a.szDecimals)) !== Number(v)) {
      errors.push(`${name} ${v} is not a valid ${coin} price (at most 5 significant figures and ${Math.max(0, 6 - a.szDecimals)} decimals): ${roundPx(Number(v), a.szDecimals)}`);
      return;
    }
    return Number(v);
  };

  let size = 0;
  if (type !== 'bracket') {
    if (!isDec(spec.size)) errors.push('size must be a positive decimal string');
    else if (Number(floorSize(Number(spec.size), a.szDecimals)) !== Number(spec.size)) errors.push(`size ${spec.size} has more than ${a.szDecimals} decimals`);
    else size = Number(spec.size);
  }
  if (spec.reduceOnly !== undefined && typeof spec.reduceOnly !== 'boolean') errors.push('reduceOnly must be true or false');
  const reduce = type === 'trailing' || type === 'bracket' || spec.reduceOnly === true;
  if (reduce) {
    if (szi === 0) errors.push(`leg ${spec.leg} has no ${coin} position to reduce`);
    else if (spec.side !== closingSide) errors.push(`a ${szi > 0 ? 'long' : 'short'} is reduced by a ${closingSide}, not a ${spec.side}`);
    else if (size > Math.abs(szi) + 1e-9) errors.push(`size ${size} is more than the ${Math.abs(szi)} ${coin} position`);
  }
  if (reduce && (spec.leverage !== undefined || spec.isCross !== undefined)) errors.push('leverage and isCross apply to orders that open or grow a position, not to reduce-only ones');

  // reference price of the order for the notional checks
  let ref = mid;
  const limitPx = type === 'limit' || type === 'stopLimit' || type === 'takeLimit' ? price('limitPx') : undefined;
  if (type === 'limit' && limitPx !== undefined) ref = limitPx;

  if (type === 'limit' && spec.tif !== undefined && !TIFS.includes(spec.tif)) errors.push(`tif must be one of ${TIFS.join(', ')}`);

  if (type === 'stopMarket' || type === 'stopLimit' || type === 'takeMarket' || type === 'takeLimit') {
    const trig = price('triggerPx');
    if (trig !== undefined) {
      ref = type.endsWith('Limit') && limitPx !== undefined ? limitPx : trig;
      const stop = type.startsWith('stop');
      // a sell stop sits below the market and a buy stop above it; a take-profit is the mirror
      const below = stop === !isBuy;
      if (below ? trig >= mid : trig <= mid) errors.push(`${stop ? 'stop' : 'take-profit'} ${spec.side} triggers ${below ? 'below' : 'above'} the market (${mid}); triggerPx ${trig} is on the wrong side`);
    }
  }

  if (type === 'bracket') {
    if (spec.tpPx === undefined && spec.slPx === undefined) errors.push('a bracket needs tpPx, slPx or both');
    if (szi === 0) errors.push(`leg ${spec.leg} has no ${coin} position to protect`);
    else if (spec.side !== closingSide) errors.push(`a bracket on a ${szi > 0 ? 'long' : 'short'} is a ${closingSide}`);
    const tp = spec.tpPx === undefined ? undefined : price('tpPx');
    const sl = spec.slPx === undefined ? undefined : price('slPx');
    // closing a long (sell): profit is above the market, loss below; closing a short is the mirror
    if (tp !== undefined && (isBuy ? tp >= mid : tp <= mid)) errors.push(`take-profit must be ${isBuy ? 'below' : 'above'} the market (${mid}) to close a ${szi > 0 ? 'long' : 'short'}`);
    if (sl !== undefined && (isBuy ? sl <= mid : sl >= mid)) errors.push(`stop-loss must be ${isBuy ? 'above' : 'below'} the market (${mid}) to close a ${szi > 0 ? 'long' : 'short'}`);
    if (tp !== undefined && sl !== undefined && (isBuy ? tp >= sl : tp <= sl)) errors.push('take-profit and stop-loss are on the wrong sides of each other');
  }

  // TP/SL attached to an opening market or limit order: profit beyond the entry, loss before it
  if ((type === 'market' || type === 'limit') && (spec.tpPx !== undefined || spec.slPx !== undefined)) {
    if (reduce) errors.push('TP/SL attach to an order that opens or grows a position; protect an existing one with a bracket');
    const tp = spec.tpPx === undefined ? undefined : price('tpPx');
    const sl = spec.slPx === undefined ? undefined : price('slPx');
    const entry = type === 'limit' && limitPx !== undefined ? limitPx : mid;
    const dir = isBuy ? 'long' : 'short';
    if (tp !== undefined && (isBuy ? tp <= entry : tp >= entry)) errors.push(`take-profit of a ${dir} must be ${isBuy ? 'above' : 'below'} the entry (${entry})`);
    if (sl !== undefined && (isBuy ? sl >= entry : sl <= entry)) errors.push(`stop-loss of a ${dir} must be ${isBuy ? 'below' : 'above'} the entry (${entry})`);
  }

  if (type === 'twap') {
    if (!Number.isInteger(spec.minutes) || spec.minutes! < TWAP_MINUTES.min || spec.minutes! > TWAP_MINUTES.max) errors.push(`minutes must be an integer from ${TWAP_MINUTES.min} to ${TWAP_MINUTES.max}`);
    if (spec.randomize !== undefined && typeof spec.randomize !== 'boolean') errors.push('randomize must be true or false');
    if (size > 0 && size * mid < HL_MIN_TWAP_USD) errors.push(`TWAP notional $${cents(size * mid)} is below the $${HL_MIN_TWAP_USD} Hyperliquid minimum`);
  }

  if (type === 'trailing') {
    if ((spec.trailPct === undefined) === (spec.trailPx === undefined)) errors.push('give exactly one of trailPct and trailPx');
    if (spec.trailPct !== undefined && !(isDec(spec.trailPct) && Number(spec.trailPct) < 100)) errors.push('trailPct must be a decimal string above 0 and below 100');
    if (spec.trailPx !== undefined) {
      const d = price('trailPx');
      if (d !== undefined && d >= mid) errors.push('trailPx must be smaller than the market price');
    }
    if (spec.activationPx !== undefined) {
      const act = price('activationPx');
      // trailing starts once the position is in profit: above the market for a long's sell, below it for a short's buy
      if (act !== undefined && (isBuy ? act >= mid : act <= mid)) errors.push(`activationPx must be ${isBuy ? 'below' : 'above'} the market (${mid})`);
    }
  }

  // notional: the cap and the exchange minimum (a reduce-only order that closes the whole position may be below the minimum)
  const notionalUsd = cents(size * ref);
  const wholePosition = reduce && size > 0 && Math.abs(size - Math.abs(szi)) < 1e-9;
  if (type !== 'bracket' && size > 0) {
    if (notionalUsd < HL_MIN_NOTIONAL_USD && !wholePosition) errors.push(`order notional $${notionalUsd} is below the Hyperliquid minimum $${HL_MIN_NOTIONAL_USD}`);
    if (!reduce && notionalUsd > policy.maxNotionalUsd) errors.push(`order notional $${notionalUsd} is above the policy maximum $${policy.maxNotionalUsd}`);
  }

  // leverage for orders that can open or grow a position
  let leverage: OrderPlan['leverage'];
  if (!reduce) {
    const have = pos?.leverage;
    const value = spec.leverage ?? have?.value;
    const isCross = spec.isCross ?? (have ? have.type === 'cross' : true);
    if (spec.leverage !== undefined && !(Number.isInteger(spec.leverage) && spec.leverage >= 1)) errors.push('leverage must be a whole number of at least 1');
    else if (value === undefined) errors.push(`leverage is required: leg ${spec.leg} holds no ${coin} position to take it from`);
    else if (value > policy.maxLeverage) errors.push(`leverage ${value}x is above the policy maximum ${policy.maxLeverage}x`);
    else if (value > a.maxLeverage) errors.push(`leverage ${value}x is above the ${coin} maximum ${a.maxLeverage}x`);
    if (spec.isCross !== undefined && typeof spec.isCross !== 'boolean') errors.push('isCross must be true or false');
    else if (have && spec.isCross !== undefined && spec.isCross !== (have.type === 'cross')) errors.push(`the leg already holds ${coin} in ${have.type} margin; close it before changing the margin mode`);
    if (value !== undefined && errors.length === 0) leverage = { value, isCross };
  }

  if (errors.length) return { ok: false, errors };
  const kind: CloidKind = type === 'bracket' || type === 'trailing' || type.startsWith('stop') || type.startsWith('take') ? 'protect' : reduce ? 'reduce' : 'open';
  return { ok: true, spec, plan: { asset: a.asset, szDecimals: a.szDecimals, mid, isBuy, szi, notionalUsd, kind, leverage } };
}

/** Cancel one open order, one TWAP, or everything on the leg for the coin. */
export function validateCancelSpec(input: unknown, ctx: OrderContext): CancelCheck {
  if (!isObj(input)) return { ok: false, errors: ['cancel spec must be a JSON object'] };
  const errors: string[] = [];
  for (const k of Object.keys(input)) if (!['leg', 'coin', 'oid', 'twapId', 'all'].includes(k)) errors.push(`${k} is not a field of a cancel spec`);
  const found = legAndMarket(ctx, input.leg, input.coin, errors);
  const given = ['oid', 'twapId', 'all'].filter((k) => input[k] !== undefined);
  if (given.length !== 1) errors.push('give exactly one of oid, twapId and all');
  else if (given[0] === 'all' ? input.all !== true : !Number.isSafeInteger(input[given[0]!]) || (input[given[0]!] as number) < 0) errors.push(`${given[0]} must be ${given[0] === 'all' ? 'true' : 'a non-negative integer'}`);
  if (!found || errors.length) return { ok: false, errors };
  return { ok: true, spec: input as unknown as CancelSpec, asset: found.a.asset };
}

/** Accepts a modify as sent or lists why not: the order must be a plain resting limit order of that leg and coin, the price one
 * Hyperliquid accepts, and (unless it only reduces) the new notional inside the policy cap, exactly as a new order would be. */
export function validateModifySpec(input: unknown, ctx: OrderContext, resting: RestingOrder[]): ModifyCheck {
  if (!isObj(input)) return { ok: false, errors: ['modify spec must be a JSON object'] };
  const errors: string[] = [];
  for (const k of Object.keys(input)) if (!['leg', 'coin', 'oid', 'limitPx'].includes(k)) errors.push(`${k} is not a field of a modify`);
  const found = legAndMarket(ctx, input.leg, input.coin, errors);
  if (!Number.isSafeInteger(input.oid) || (input.oid as number) < 0) errors.push('oid must be an order id');
  if (!found || errors.length) return { ok: false, errors };
  const spec = input as unknown as ModifySpec;
  const order = resting.find((o) => o.oid === spec.oid);
  if (!order) return { ok: false, errors: [`order ${spec.oid} is not resting on leg ${spec.leg}`] };
  if (order.coin !== spec.coin) errors.push(`order ${spec.oid} is on ${order.coin}, not ${spec.coin}`);
  if (order.isTrigger || order.orderType !== 'Limit') errors.push(`only resting limit orders can be moved; ${spec.oid} is a ${order.orderType}`);
  const { a } = found;
  if (!isDec(spec.limitPx)) errors.push('limitPx must be a positive decimal string');
  else if (Number(roundPx(Number(spec.limitPx), a.szDecimals)) !== Number(spec.limitPx)) errors.push(`limitPx ${spec.limitPx} is not a valid ${spec.coin} price: ${roundPx(Number(spec.limitPx), a.szDecimals)}`);
  else if (!order.reduceOnly) {
    const notional = cents(Number(order.size) * Number(spec.limitPx));
    if (notional > ctx.policy.maxNotionalUsd) errors.push(`order notional $${notional} at the new price is above the policy maximum $${ctx.policy.maxNotionalUsd}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec, asset: a.asset, order };
}

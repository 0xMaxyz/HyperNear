// Strategy spec (Phase 2): declarative, validated, checked against the order policy and the contract policy.
// Each strategy runs on its own leg, so its losses stay on that leg and the contract's cap and cooldown bound how much
// the margin guard may top it up. Hand-rolled validation, like parseRelayBody: no dependency, every error listed.
import { createHash } from 'node:crypto';
import type { OwnerState } from '@hypernear/client';
import type { OrderPolicy } from '../config.ts';

/** Hyperliquid's minimum order value (USD). */
export const HL_MIN_NOTIONAL_USD = 10;
const MAX_LEVELS = 20;
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

export const STRATEGY_TYPES = ['grid'] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export interface GridParams {
  lower: number;
  upper: number;
  /** price points between lower and upper (inclusive), so levels - 1 intervals */
  levels: number;
  /** base-coin size of one level, decimal string */
  sizePerLevel: string;
}

export interface StrategyLimits {
  /** Largest exposure in USD: position plus resting opening orders. */
  maxNotional: number;
  maxLeverage: number;
  /** Pause and cancel when equity falls this far below the day's start (USD). */
  maxDailyLoss: number;
  /** Budget (USD/day) of guard top-ups this strategy may use; the sum over strategies must fit the contract's cap. */
  topUpCapPerDay: number;
}

export interface StrategySpec {
  id: string;
  type: StrategyType;
  leg: number;
  coin: string;
  params: GridParams;
  limits: StrategyLimits;
  /** What a stop does with resting orders / the position. Default cancel. */
  onStop: 'cancel' | 'flatten';
}

/** What validation needs to know about the owner's policy and legs. */
export interface SpecContext {
  orderPolicy: OrderPolicy;
  registeredLegs: number[];
  /** Legs that belong to the hedge pair and the guard's reserve; strategies may not use them. */
  reservedLegs: number[];
  /** Legs already running a strategy. */
  busyLegs: number[];
  /** Contract policy of the owner (null: owner unknown to the contract). */
  owner: OwnerState | null;
  /** Our NEAR agent account, when known: the contract policy must name it. */
  agentId?: string;
  /** topUpCapPerDay already promised to the owner's other strategies. */
  otherTopUpBudget: number;
}

export type SpecResult = { ok: true; spec: StrategySpec } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function unknownKeys(o: Record<string, unknown>, allowed: string[], where: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
}

export function validateSpec(input: unknown, ctx: SpecContext): SpecResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['spec must be a JSON object'] };
  unknownKeys(input, ['id', 'type', 'leg', 'coin', 'params', 'limits', 'onStop'], 'spec', errors);

  const id = input.id;
  if (typeof id !== 'string' || !ID.test(id)) errors.push('id must match [a-z0-9][a-z0-9_-]{0,31}');
  if (!STRATEGY_TYPES.includes(input.type as StrategyType)) errors.push(`type must be one of ${STRATEGY_TYPES.join(', ')}`);

  const leg = input.leg;
  if (!Number.isInteger(leg) || (leg as number) < 0) errors.push('leg must be a non-negative integer');
  else {
    if (!ctx.registeredLegs.includes(leg as number)) errors.push(`leg ${leg} is not registered for this owner`);
    if (ctx.reservedLegs.includes(leg as number)) errors.push(`leg ${leg} is reserved (hedge pair or guard reserve)`);
    if (ctx.busyLegs.includes(leg as number)) errors.push(`leg ${leg} already runs a strategy`);
  }

  const coin = input.coin;
  if (typeof coin !== 'string' || !ctx.orderPolicy.allowedCoins.includes(coin)) errors.push(`coin must be one of ${ctx.orderPolicy.allowedCoins.join(', ')}`);

  const onStop = input.onStop ?? 'cancel';
  if (onStop !== 'cancel' && onStop !== 'flatten') errors.push('onStop must be "cancel" or "flatten"');

  const p = input.params;
  let gridOk = false;
  if (!isObj(p)) errors.push('params must be an object');
  else {
    unknownKeys(p, ['lower', 'upper', 'levels', 'sizePerLevel'], 'params', errors);
    const { lower, upper, levels, sizePerLevel } = p;
    if (!isNum(lower) || lower <= 0) errors.push('params.lower must be a positive number');
    if (!isNum(upper) || upper <= 0) errors.push('params.upper must be a positive number');
    if (isNum(lower) && isNum(upper) && upper <= lower) errors.push('params.upper must be above params.lower');
    if (!Number.isInteger(levels) || (levels as number) < 2 || (levels as number) > MAX_LEVELS) errors.push(`params.levels must be an integer from 2 to ${MAX_LEVELS}`);
    if (typeof sizePerLevel !== 'string' || !DECIMAL.test(sizePerLevel) || Number(sizePerLevel) <= 0) errors.push('params.sizePerLevel must be a positive decimal string');
    gridOk = isNum(lower) && isNum(upper) && upper > lower && lower > 0 && Number.isInteger(levels) && typeof sizePerLevel === 'string' && DECIMAL.test(sizePerLevel) && Number(sizePerLevel) > 0;
    if (gridOk) {
      const sz = Number(sizePerLevel);
      const lowNotional = sz * (lower as number);
      const highNotional = sz * (upper as number);
      if (lowNotional < HL_MIN_NOTIONAL_USD) errors.push(`order at the lowest level is $${lowNotional.toFixed(2)}, below the Hyperliquid minimum $${HL_MIN_NOTIONAL_USD}`);
      if (highNotional > ctx.orderPolicy.maxNotionalUsd) errors.push(`order at the highest level is $${highNotional.toFixed(2)}, above the order policy max $${ctx.orderPolicy.maxNotionalUsd}`);
    }
  }

  const l = input.limits;
  if (!isObj(l)) errors.push('limits must be an object');
  else {
    unknownKeys(l, ['maxNotional', 'maxLeverage', 'maxDailyLoss', 'topUpCapPerDay'], 'limits', errors);
    if (!isNum(l.maxNotional) || l.maxNotional <= 0) errors.push('limits.maxNotional must be a positive number');
    if (!isNum(l.maxLeverage) || l.maxLeverage < 1) errors.push('limits.maxLeverage must be at least 1');
    else if (l.maxLeverage > ctx.orderPolicy.maxLeverage) errors.push(`limits.maxLeverage ${l.maxLeverage} is above the order policy max ${ctx.orderPolicy.maxLeverage} (a spec can only tighten the policy)`);
    if (!isNum(l.maxDailyLoss) || l.maxDailyLoss <= 0) errors.push('limits.maxDailyLoss must be a positive number');
    if (!isNum(l.topUpCapPerDay) || l.topUpCapPerDay < 0) errors.push('limits.topUpCapPerDay must be zero or more');
    if (gridOk && isNum(l.maxNotional) && isObj(p)) {
      const worst = (p.levels as number) * Number(p.sizePerLevel) * (p.upper as number);
      if (worst > l.maxNotional) errors.push(`worst-case exposure $${worst.toFixed(2)} (levels x size x upper) is above limits.maxNotional $${l.maxNotional}`);
    }
  }

  // contract policy
  if (!ctx.owner) errors.push('owner is unknown to the contract');
  else {
    if (ctx.owner.frozen) errors.push('owner is frozen');
    if (!ctx.owner.agent) errors.push('owner has not named an agent (setPolicy)');
    else if (ctx.agentId && ctx.owner.agent !== ctx.agentId) errors.push(`contract policy names agent ${ctx.owner.agent}, not this service (${ctx.agentId})`);
    if (isObj(l) && isNum(l.topUpCapPerDay)) {
      const capUsd = ctx.owner.daily_cap / 1e6;
      if (ctx.otherTopUpBudget + l.topUpCapPerDay > capUsd) {
        errors.push(`top-up budgets ${ctx.otherTopUpBudget} + ${l.topUpCapPerDay} exceed the contract's daily cap $${capUsd}`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  const g = p as Record<string, unknown>;
  const lim = l as Record<string, number>;
  return {
    ok: true,
    spec: {
      id: id as string,
      type: input.type as StrategyType,
      leg: leg as number,
      coin: coin as string,
      params: { lower: g.lower as number, upper: g.upper as number, levels: g.levels as number, sizePerLevel: g.sizePerLevel as string },
      limits: { maxNotional: lim.maxNotional!, maxLeverage: lim.maxLeverage!, maxDailyLoss: lim.maxDailyLoss!, topUpCapPerDay: lim.topUpCapPerDay! },
      onStop: onStop as 'cancel' | 'flatten',
    },
  };
}

/** Canonical JSON (keys sorted) so a hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The owner signs a Command whose `coin` field carries this hash (stub until the Command gets a specHash field). */
export function specHash(spec: StrategySpec): string {
  return `0x${createHash('sha256').update(canonicalJson(spec)).digest('hex')}`;
}

// ---------------------------------------------------------------- order gate

export interface OrderView {
  /** Signed position size of the coin on the leg (base units). */
  position: number;
  /** USD notional of resting orders that would open or grow exposure. */
  restingOpeningNotional: number;
}

export interface OrderRequest {
  coin: string;
  isBuy: boolean;
  px: number;
  sz: number;
  reduceOnly: boolean;
}

export type OrderCheck = { ok: true } | { ok: false; reason: string };

/** Every order of a runner passes here: the order policy first, then the spec's limits. A refusal is never sent. */
export function checkOrder(spec: StrategySpec, policy: OrderPolicy, view: OrderView, o: OrderRequest): OrderCheck {
  if (o.coin !== spec.coin) return { ok: false, reason: `coin ${o.coin} is not the strategy's coin ${spec.coin}` };
  if (!policy.allowedCoins.includes(o.coin)) return { ok: false, reason: `coin ${o.coin} not allowed by the order policy` };
  if (!(o.px > 0 && o.sz > 0)) return { ok: false, reason: 'price and size must be positive' };
  const notional = o.px * o.sz;
  if (notional > policy.maxNotionalUsd) return { ok: false, reason: `order $${notional.toFixed(2)} above the order policy max $${policy.maxNotionalUsd}` };
  if (!o.reduceOnly) {
    if (notional < HL_MIN_NOTIONAL_USD) return { ok: false, reason: `order $${notional.toFixed(2)} below the Hyperliquid minimum $${HL_MIN_NOTIONAL_USD}` };
    const after = Math.abs(view.position) * o.px + view.restingOpeningNotional + notional;
    if (after > spec.limits.maxNotional) return { ok: false, reason: `exposure after this order $${after.toFixed(2)} would exceed maxNotional $${spec.limits.maxNotional}` };
  }
  const step = (spec.params.upper - spec.params.lower) / (spec.params.levels - 1);
  if (o.px < spec.params.lower * 0.999 || o.px > spec.params.upper + step) return { ok: false, reason: `price ${o.px} outside the strategy range` };
  return { ok: true };
}

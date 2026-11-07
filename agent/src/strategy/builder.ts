// Strategy builder: plain language -> a spec, by Claude with structured output, then validated by spec.ts like any other
// spec. The model is never trusted: it only drafts; validateSpec (order policy, contract policy, limits) decides, and nothing
// starts without the owner's signed start Command over the returned specHash.
import Anthropic from '@anthropic-ai/sdk';
import type { Hex } from 'viem';
import { SONNET_MODEL } from '../decide.ts';
import { canonicalJson, specHash, strategyRoomUsd, validateSpec, STRATEGY_TYPES, type SpecContext, type StrategySpec } from './spec.ts';

export const MAX_DRAFT_TEXT = 600;

export interface Change {
  path: string;
  from: unknown;
  to: unknown;
}

export type Draft =
  | { ok: true; spec: StrategySpec; specHash: string; diff: { against: 'new' | string; changes: Change[] }; warnings: string[] }
  | { ok: false; errors: string[]; /** what the model proposed (unvalidated), when it proposed anything */ draft?: unknown };

/** One structured-output call: system + user text in, parsed JSON out. */
export type Ask = (system: string, user: string) => Promise<unknown>;

export interface DrafterDeps {
  ask: Ask;
  /** Contract and order-policy context for validateSpec; `selfId` is a strategy being replaced. */
  context: (owner: Hex, selfId?: string) => Promise<SpecContext>;
  /** The owner's current strategy with this id. */
  current: (owner: Hex, id: string) => StrategySpec | undefined;
  /** The owner's strategies (shown to the model so "widen my grid" works). */
  strategies: (owner: Hex) => StrategySpec[];
  mids: () => Promise<Record<string, string>>;
  /** Has this leg an owner-approved agent key yet? */
  keyReady: (owner: Hex, leg: number) => boolean;
}

const SYSTEM = [
  'You turn a trading-strategy request into ONE JSON strategy spec for a Hyperliquid perpetuals account. You only draft: a validator checks every number afterwards.',
  'Types:',
  '- grid {lower, upper, levels (2-20), sizePerLevel}: a long-only ladder of post-only buys below the price with reduce-only sells one level above.',
  '- twap {side "buy"|"sell", sizePerSlice, slices (2-50), intervalSec (10-86400), limitPx}: one immediate order per interval; DCA is a twap with a long interval. A buy never pays more than limitPx, a sell never receives less.',
  'Sizes (sizePerLevel, sizePerSlice) are base-coin amounts as decimal strings (BTC "0.00015"). One order must be worth at least 10.5 USD at its lowest price. Compute sizes from the mids given.',
  'limits: maxNotional (USD, the worst-case exposure: levels x size x upper, or slices x size x limitPx, rounded up), maxLeverage (2 unless told), maxDailyLoss (USD; 10% of maxNotional unless told), topUpCapPerDay (USD; 0 unless told).',
  'onStop: a grid defaults to "flatten" (stopping closes its inventory); a twap defaults to "cancel" (it keeps what it bought); do what the user says if they say. leg: the lowest free leg given. id: a short lowercase slug (letters, digits, - and _), or the id of the existing strategy the user wants changed.',
  'Copy the numbers the user gives faithfully. If one breaks a limit, still output it: the validator refuses it and tells the user why. Never clamp or invent numbers to make a request fit.',
  'If the text is not a strategy request, or no listed coin or type fits it, set "cannot" to one sentence and "spec" to null. Otherwise "cannot" is "".',
].join('\n');

const NUM = { type: 'number' };
const STR = { type: 'string' };
const INT = { type: 'integer' };
/** Structured-output schema; the validator, not this schema, is the authority. */
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    cannot: STR,
    spec: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            id: STR,
            type: { type: 'string', enum: [...STRATEGY_TYPES] },
            leg: INT,
            coin: STR,
            params: {
              anyOf: [
                { type: 'object', properties: { lower: NUM, upper: NUM, levels: INT, sizePerLevel: STR }, required: ['lower', 'upper', 'levels', 'sizePerLevel'], additionalProperties: false },
                { type: 'object', properties: { side: { type: 'string', enum: ['buy', 'sell'] }, sizePerSlice: STR, slices: INT, intervalSec: INT, limitPx: NUM }, required: ['side', 'sizePerSlice', 'slices', 'intervalSec', 'limitPx'], additionalProperties: false },
              ],
            },
            limits: { type: 'object', properties: { maxNotional: NUM, maxLeverage: NUM, maxDailyLoss: NUM, topUpCapPerDay: NUM }, required: ['maxNotional', 'maxLeverage', 'maxDailyLoss', 'topUpCapPerDay'], additionalProperties: false },
            onStop: { type: 'string', enum: ['cancel', 'flatten'] },
          },
          required: ['id', 'type', 'leg', 'coin', 'params', 'limits', 'onStop'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['cannot', 'spec'],
  additionalProperties: false,
} as const;

/** Claude Sonnet 5.5 with structured output (one client). */
export function claudeAsk(client = new Anthropic(), model = SONNET_MODEL): Ask {
  return async (system, user) => {
    const res = await client.messages.create({
      model,
      max_tokens: 1500,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA as unknown as Record<string, unknown> } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new Error(`model stopped: ${res.stop_reason}`);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return JSON.parse(text);
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function flatten(v: unknown, path = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isObj(v)) for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  else out[path] = v;
  return out;
}

/** Field-by-field changes from `a` to `b` (both specs). */
export function diffSpecs(a: StrategySpec, b: StrategySpec): Change[] {
  const fa = flatten(a);
  const fb = flatten(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
    .filter((p) => canonicalJson(fa[p]) !== canonicalJson(fb[p]))
    .map((path) => ({ path, from: fa[path], to: fb[path] }));
}

/** Things that are allowed but worth the owner's attention before signing. */
export function warningsFor(spec: StrategySpec, ctx: SpecContext, mid: number | undefined, keyReady: boolean): string[] {
  const w: string[] = [];
  const exposureText = spec.type === 'grid' ? 'levels x size x upper' : 'slices x size x limitPx';
  const worst = spec.type === 'grid' ? spec.params.levels * Number(spec.params.sizePerLevel) * spec.params.upper : spec.params.slices * Number(spec.params.sizePerSlice) * spec.params.limitPx;
  if (worst > 0.8 * spec.limits.maxNotional) w.push(`worst-case exposure $${worst.toFixed(0)} (${exposureText}) is above 80% of maxNotional $${spec.limits.maxNotional}`);
  if (ctx.owner && spec.limits.topUpCapPerDay > ctx.owner.daily_cap / 2e6) w.push(`top-up budget $${spec.limits.topUpCapPerDay}/day is more than half of your contract cap $${ctx.owner.daily_cap / 1e6}/day`);
  const cap = (ctx.owner?.daily_cap ?? 0) / 1e6;
  if (ctx.owner && cap - strategyRoomUsd(ctx) > 0 && spec.limits.topUpCapPerDay > 0) {
    w.push(`the hedge guard keeps $${cap - strategyRoomUsd(ctx)} of your $${cap}/day contract cap; strategies share the other $${strategyRoomUsd(ctx)} (other budgets: $${ctx.otherTopUpBudget})`);
  }
  if (spec.limits.maxLeverage >= 3) w.push(`leverage up to ${spec.limits.maxLeverage}x: a ${(100 / spec.limits.maxLeverage).toFixed(0)}% move against the position can liquidate it`);
  if (spec.type === 'grid') {
    const step = (spec.params.upper - spec.params.lower) / (spec.params.levels - 1);
    if (step / spec.params.upper < 0.001) w.push(`grid step is ${((100 * step) / spec.params.upper).toFixed(3)}% of the price: trading fees will likely exceed the profit per round trip`);
    if (mid !== undefined && (mid < spec.params.lower || mid > spec.params.upper)) w.push(`the current price ${mid} is outside the grid range ${spec.params.lower}-${spec.params.upper}: it will not trade until the price comes back`);
  } else {
    const hours = (spec.params.slices * spec.params.intervalSec) / 3600;
    if (hours > 24) w.push(`runs for about ${hours.toFixed(0)} hours; the service keeps it only while it stays up (a restart pauses it)`);
    if (spec.onStop === 'cancel') w.push('stopping keeps the position that was bought or sold; set onStop "flatten" to close it');
  }
  if (!keyReady) w.push(`leg ${spec.leg} has no approved agent key yet (prepareAgents, then approveAgent) - the strategy cannot start until it has one`);
  return w;
}

export function drafter(d: DrafterDeps) {
  return async (owner: Hex, text: string): Promise<Draft> => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['text is empty'] };
    if (text.length > MAX_DRAFT_TEXT) return { ok: false, errors: [`text is longer than ${MAX_DRAFT_TEXT} characters`] };
    const base = await d.context(owner);
    const user = JSON.stringify({
      request: text,
      mids: await d.mids(),
      policy: { allowedCoins: base.orderPolicy.allowedCoins, maxLeverage: base.orderPolicy.maxLeverage, maxOrderNotionalUsd: base.orderPolicy.maxNotionalUsd },
      freeLegs: base.registeredLegs.filter((l) => !base.reservedLegs.includes(l) && !base.busyLegs.includes(l)),
      contractDailyCapUsd: base.owner ? base.owner.daily_cap / 1e6 : null,
      topUpBudgetUsedUsd: base.otherTopUpBudget,
      existingStrategies: d.strategies(owner),
    });
    let out: unknown;
    try {
      out = await d.ask(SYSTEM, user);
    } catch (e) {
      return { ok: false, errors: [`the model call failed: ${(e as Error).message}`] };
    }
    if (!isObj(out)) return { ok: false, errors: ['the model returned something that is not a JSON object'] };
    if (out.spec === null || out.spec === undefined) return { ok: false, errors: [typeof out.cannot === 'string' && out.cannot ? out.cannot : 'the model proposed no strategy'] };
    const id = isObj(out.spec) && typeof out.spec.id === 'string' ? out.spec.id : undefined;
    const ctx = id ? await d.context(owner, id) : base;
    const v = validateSpec(out.spec, ctx);
    if (!v.ok) return { ok: false, errors: v.errors, draft: out.spec };
    const current = d.current(owner, v.spec.id);
    const mid = Number((await d.mids())[v.spec.coin]);
    const warnings = warningsFor(v.spec, ctx, Number.isFinite(mid) ? mid : undefined, d.keyReady(owner, v.spec.leg));
    if (current) warnings.push(`replaces your running strategy ${v.spec.id}: stop it first, or send the identical spec to resume it`);
    return {
      ok: true,
      spec: v.spec,
      specHash: specHash(v.spec),
      diff: { against: current ? v.spec.id : 'new', changes: current ? diffSpecs(current, v.spec) : [] },
      warnings,
    };
  };
}

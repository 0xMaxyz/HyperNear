import { describe, expect, it } from 'vitest';
import { makeCloid, newGroup, parseCloid } from '../src/cloid.ts';
import { parseHedgeSpec, planOpenHedge } from '../src/hedge.ts';
import { OrderRefused, statusesOf } from '../src/orders.ts';
import { validateCancelSpec, validateModifySpec, validateOrderSpec, validateProtectSpec, type OrderContext, type OrderSpec, type RestingOrder } from '../src/order.ts';
import { ch, POLICY, snap } from './agent-helpers.ts';

// mid 100000, BTC szDecimals 5, policy: 5x, $100 per order
const approved = (s: ReturnType<typeof snap>) => ({ ...s, legs: s.legs.map((l) => ({ ...l, agent: { address: l.address, name: `leg${l.leg}`, approvedAt: 1 } })) });
const flat = (extra: Partial<OrderContext> = {}): OrderContext => ({ snapshot: approved(snap(ch(), ch())), policy: POLICY, ...extra });
const long = (extra: Partial<OrderContext> = {}): OrderContext => ({ snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004', lev: 3 }] }), ch())), policy: POLICY, ...extra });
const o = (spec: Partial<OrderSpec>): OrderSpec => ({ leg: 0, coin: 'BTC', side: 'buy', type: 'market', size: '0.0002', leverage: 3, ...spec });
const errs = (spec: unknown, ctx = flat()) => {
  const r = validateOrderSpec(spec, ctx);
  return r.ok ? '' : r.errors.join(' | ');
};

describe('validateOrderSpec', () => {
  it('accepts a market open and resolves what the executor needs', () => {
    const r = validateOrderSpec(o({}), flat());
    expect(r).toMatchObject({ ok: true, plan: { asset: 3, isBuy: true, szi: 0, notionalUsd: 20, kind: 'open', leverage: { value: 3, isCross: true } } });
  });

  it('keeps the spec exactly as sent (the owner signed those bytes)', () => {
    const spec = o({ type: 'limit', limitPx: '99000', tif: 'Gtc' });
    const r = validateOrderSpec(spec, flat());
    expect(r.ok && r.spec).toBe(spec);
  });

  it.each([
    ['not an object', 'x', /JSON object/],
    ['unknown type', o({ type: 'iceberg' as never }), /type must be one of/],
    ['field of another type', o({ triggerPx: '90000' }), /triggerPx is not a field of a market order/],
    ['side', o({ side: 'long' as never }), /side must be/],
    ['unregistered leg', o({ leg: 7 }), /leg 7 is not registered/],
    ['coin outside the allow-list', o({ coin: 'DOGE' }), /coin must be one of BTC, ETH/],
    ['too many size decimals', o({ size: '0.000123456' }), /more than 5 decimals/],
    ['bad size', o({ size: '-1' }), /size must be a positive decimal/],
    ['no leverage on a flat leg', o({ leverage: undefined }), /leverage is required/],
    ['leverage above policy', o({ leverage: 10 }), /above the policy maximum 5x/],
    ['notional above the cap', o({ size: '0.002' }), /above the policy maximum \$100/],
    ['below the exchange minimum', o({ size: '0.00005' }), /below the Hyperliquid minimum \$10/],
  ])('refuses: %s', (_n, spec, re) => {
    expect(errs(spec)).toMatch(re as RegExp);
  });

  it('refuses a leg that is not approved or that a strategy runs', () => {
    const unapproved = { ...flat(), snapshot: snap(ch(), ch()) };
    expect(errs(o({}), unapproved)).toMatch(/no approved agent key/);
    expect(errs(o({}), flat({ busyLegs: [0] }))).toMatch(/running a strategy/);
  });

  it('prices must be what Hyperliquid accepts, not rounded for the owner', () => {
    expect(errs(o({ type: 'limit', limitPx: '99999.5' }))).toMatch(/not a valid BTC price/);
    expect(errs(o({ type: 'limit', limitPx: '99000' }))).toBe('');
    expect(errs(o({ type: 'limit' }))).toMatch(/limitPx must be a positive decimal/);
    expect(errs(o({ type: 'limit', limitPx: '99000', tif: 'Fok' as never }))).toMatch(/tif must be/);
  });

  it('reduce-only needs a position on the other side, and may exceed the cap or the minimum when it closes everything', () => {
    expect(errs(o({ reduceOnly: true, leverage: undefined }), flat())).toMatch(/no BTC position to reduce/);
    expect(errs(o({ reduceOnly: true, leverage: undefined }), long())).toMatch(/a long is reduced by a sell/);
    expect(errs(o({ side: 'sell', size: '0.0005', reduceOnly: true, leverage: undefined }), long())).toMatch(/more than the 0.0004 BTC position/);
    expect(errs(o({ side: 'sell', size: '0.0004', reduceOnly: true, leverage: undefined }), long())).toBe('');
    expect(errs(o({ side: 'sell', size: '0.0002', reduceOnly: true }), long())).toMatch(/leverage and isCross apply to orders that open/);
    // 0.00005 BTC is $5: under the minimum, fine only as the whole position
    const tiny: OrderContext = { snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '0.00005', lev: 3 }] }), ch())), policy: POLICY };
    expect(errs(o({ side: 'sell', size: '0.00005', reduceOnly: true, leverage: undefined }), tiny)).toBe('');
  });

  it('adding to a position reuses its leverage and refuses a margin mode change', () => {
    const r = validateOrderSpec(o({ leverage: undefined }), long());
    expect(r.ok && r.plan.leverage).toEqual({ value: 3, isCross: true });
    expect(errs(o({ isCross: false }), long())).toMatch(/already holds BTC in cross margin/);
  });

  it('stop and take-profit triggers sit on the correct side of the market', () => {
    const stop = (side: 'buy' | 'sell', px: string) => o({ type: 'stopMarket', side, triggerPx: px, reduceOnly: true, leverage: undefined, size: '0.0002' });
    expect(errs(stop('sell', '95000'), long())).toBe('');
    expect(errs(stop('sell', '105000'), long())).toMatch(/stop sell triggers below the market/);
    expect(errs(o({ type: 'takeMarket', side: 'sell', triggerPx: '105000', reduceOnly: true, leverage: undefined }), long())).toBe('');
    expect(errs(o({ type: 'takeMarket', side: 'sell', triggerPx: '95000', reduceOnly: true, leverage: undefined }), long())).toMatch(/take-profit sell triggers above/);
    expect(errs(o({ type: 'stopLimit', side: 'sell', triggerPx: '95000', limitPx: '94900', reduceOnly: true, leverage: undefined }), long())).toBe('');
    expect(errs(o({ type: 'stopLimit', side: 'sell', triggerPx: '95000', reduceOnly: true, leverage: undefined }), long())).toMatch(/limitPx must be/);
  });

  it('a bracket protects an existing position with take-profit and stop-loss on the right sides', () => {
    const b = (x: Partial<OrderSpec>): OrderSpec => ({ leg: 0, coin: 'BTC', side: 'sell', type: 'bracket', ...x });
    const r = validateOrderSpec(b({ tpPx: '105000', slPx: '95000' }), long());
    expect(r).toMatchObject({ ok: true, plan: { kind: 'protect', szi: 0.0004 } });
    expect(errs(b({ tpPx: '105000' }), flat())).toMatch(/no BTC position to protect/);
    expect(errs(b({}), long())).toMatch(/tpPx, slPx or both/);
    expect(errs(b({ tpPx: '95000' }), long())).toMatch(/take-profit must be above/);
    expect(errs(b({ slPx: '105000' }), long())).toMatch(/stop-loss must be below/);
    expect(errs(b({ tpPx: '105000', size: '0.0004' } as never), long())).toMatch(/size is not a field of a bracket/);
    // the short side mirrors it
    const short: OrderContext = { snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '-0.0004', lev: 3 }] }), ch())), policy: POLICY };
    expect(errs(b({ side: 'buy', tpPx: '95000', slPx: '105000' }), short)).toBe('');
  });

  it('TWAP: 5-1440 minutes and at least $100 notional', () => {
    const t = (x: Partial<OrderSpec>) => o({ type: 'twap', size: '0.001', minutes: 30, ...x });
    expect(errs(t({}))).toBe('');
    expect(errs(t({ minutes: 4 }))).toMatch(/minutes must be an integer from 5 to 1440/);
    expect(errs(t({ size: '0.0005' }))).toMatch(/TWAP notional \$50 is below the \$100/);
  });

  it('trailing stop: one distance, an activation price on the profit side, long positions only reduce', () => {
    const tr = (x: Partial<OrderSpec>): OrderSpec => ({ leg: 0, coin: 'BTC', side: 'sell', type: 'trailing', size: '0.0004', trailPct: '5', ...x });
    expect(validateOrderSpec(tr({ activationPx: '102000' }), long())).toMatchObject({ ok: true, plan: { kind: 'protect' } });
    expect(errs(tr({ activationPx: '98000' }), long())).toMatch(/activationPx must be above the market/);
    expect(errs(tr({ trailPx: '3000' }), long())).toMatch(/exactly one of trailPct and trailPx/);
    expect(errs(tr({ trailPct: '100' }), long())).toMatch(/trailPct must be/);
    expect(errs(tr({}), flat())).toMatch(/no BTC position to reduce/);
  });
});

describe('validateCancelSpec', () => {
  it('exactly one of oid, twapId, all', () => {
    expect(validateCancelSpec({ leg: 0, coin: 'BTC', oid: 5 }, flat())).toMatchObject({ ok: true, asset: 3 });
    expect(validateCancelSpec({ leg: 0, coin: 'BTC', all: true }, flat()).ok).toBe(true);
    expect(validateCancelSpec({ leg: 0, coin: 'BTC' }, flat())).toMatchObject({ ok: false });
    expect(validateCancelSpec({ leg: 0, coin: 'BTC', oid: 5, all: true }, flat())).toMatchObject({ ok: false });
    expect(validateCancelSpec({ leg: 0, coin: 'BTC', all: false }, flat())).toMatchObject({ ok: false });
    expect(validateCancelSpec({ leg: 0, coin: 'BTC', oid: 5, extra: 1 }, flat())).toMatchObject({ ok: false });
    expect(validateCancelSpec({ leg: 4, coin: 'BTC', oid: 5 }, flat())).toMatchObject({ ok: false });
  });
});

describe('cloid', () => {
  it('round-trips kind and group, and ignores ids it did not make', () => {
    const g = newGroup();
    const c = makeCloid('hedgeClose', g);
    expect(c).toMatch(/^0x4c48[0-9a-f]{2}[0-9a-f]{10}[0-9a-f]{16}$/);
    expect(parseCloid(c)).toEqual({ kind: 'hedgeClose', group: g });
    expect(makeCloid('open', g)).not.toBe(makeCloid('open', g));
    expect(parseCloid(`0x${'ab'.repeat(16)}`)).toBeUndefined();
    expect(parseCloid(undefined)).toBeUndefined();
    expect(() => makeCloid('open', 'xyz')).toThrow();
  });
});

describe('hedge spec (leg 1 leverage and margin mode)', () => {
  const s = snap(ch({ positions: [{ coin: 'BTC', szi: '0.0003', lev: 3 }] }));
  it('overrides leg 0 only when asked', () => {
    expect(planOpenHedge(s, 'BTC', 0.5, POLICY)).toMatchObject({ ok: true, leverage: { value: 3, isCross: true } });
    expect(planOpenHedge(s, 'BTC', 0.5, POLICY, { leg1Leverage: 5, leg1IsCross: false })).toMatchObject({ ok: true, leverage: { value: 5, isCross: false } });
    expect(planOpenHedge(s, 'BTC', 0.5, POLICY, { leg1Leverage: 6 })).toMatchObject({ ok: false, reason: /above policy max 5x/ });
  });
  it('parseHedgeSpec is strict', () => {
    expect(parseHedgeSpec({ leg1Leverage: 4, leg1IsCross: true })).toEqual({ leg1Leverage: 4, leg1IsCross: true });
    expect(() => parseHedgeSpec({ leg1Leverage: 2.5 })).toThrow(/whole number/);
    expect(() => parseHedgeSpec({ ratio: 1 })).toThrow(/not a hedge spec field/);
    expect(() => parseHedgeSpec(null)).toThrow(/JSON object/);
  });
});

describe('statusesOf', () => {
  const res = (statuses: unknown[]) => ({ status: 'ok', response: { type: 'order', data: { statuses } } }) as never;
  it('reads fills, resting orders and the bare "waitingForTrigger" a bracket returns; an error status refuses', () => {
    expect(statusesOf(res([{ filled: { oid: 1, totalSz: '0.1', avgPx: '100' } }, { resting: { oid: 2 } }, 'waitingForTrigger']))).toEqual([
      { oid: 1, filled: { sz: '0.1', px: '100' } },
      { oid: 2, resting: true },
      { resting: true },
    ]);
    expect(() => statusesOf(res([{ error: 'Order has invalid size.' }]))).toThrow(OrderRefused);
  });
});

describe('TP/SL attached to an opening order', () => {
  it('accepts profit beyond and loss before the entry, for a long and a short, market or limit', () => {
    expect(errs(o({ tpPx: '105000', slPx: '95000' }))).toBe('');
    expect(errs(o({ side: 'sell', tpPx: '95000', slPx: '105000' }))).toBe('');
    expect(errs(o({ type: 'limit', limitPx: '99000', tpPx: '101000' }))).toBe('');
    expect(errs(o({ slPx: '95000' }))).toBe('');
  });
  it('refuses the wrong side of the entry, unaccepted prices, and TP/SL on a reduce-only order', () => {
    expect(errs(o({ tpPx: '95000' }))).toMatch(/take-profit of a long must be above the entry/);
    expect(errs(o({ slPx: '105000' }))).toMatch(/stop-loss of a long must be below the entry/);
    expect(errs(o({ side: 'sell', tpPx: '105000' }))).toMatch(/take-profit of a short must be below/);
    // the limit price is the entry, not the mid
    expect(errs(o({ type: 'limit', limitPx: '99000', slPx: '99500' }))).toMatch(/stop-loss of a long must be below the entry \(99000\)/);
    expect(errs(o({ tpPx: '105000.5' }))).toMatch(/not a valid BTC price/);
    expect(errs(o({ side: 'sell', reduceOnly: true, leverage: undefined, size: '0.0004', tpPx: '95000' }), long())).toMatch(/protect an existing one with a bracket/);
    expect(errs(o({ type: 'stopMarket', triggerPx: '105000', tpPx: '110000' }))).toMatch(/tpPx is not a field of a stopMarket order/);
  });
});

describe('validateModifySpec', () => {
  const rest = (o: Partial<RestingOrder> = {}): RestingOrder => ({ oid: 7, coin: 'BTC', side: 'buy', size: '0.0005', limitPx: '99000', orderType: 'Limit', isTrigger: false, reduceOnly: false, ...o });
  const m = (spec: Record<string, unknown>, resting = [rest()], ctx = flat()) => {
    const r = validateModifySpec({ leg: 0, coin: 'BTC', oid: 7, limitPx: '98000', ...spec }, ctx, resting);
    return r.ok ? '' : r.errors.join(' | ');
  };
  it('moves a resting limit to a valid price and keeps its order as listed', () => {
    const r = validateModifySpec({ leg: 0, coin: 'BTC', oid: 7, limitPx: '98000' }, flat(), [rest()]);
    expect(r).toMatchObject({ ok: true, asset: 3, order: { oid: 7, size: '0.0005' } });
  });
  it('refuses unknown or wrong orders, triggers, bad prices, extra fields, and a notional over the cap', () => {
    expect(m({ oid: 8 })).toMatch(/order 8 is not resting on leg 0/);
    expect(m({}, [rest({ coin: 'ETH' })])).toMatch(/is on ETH, not BTC/);
    expect(m({}, [rest({ orderType: 'Stop Market', isTrigger: true })])).toMatch(/only resting limit orders/);
    expect(m({ limitPx: '98000.5' })).toMatch(/not a valid BTC price/);
    expect(m({ size: '1' })).toMatch(/size is not a field of a modify/);
    expect(m({ limitPx: '250000' })).toMatch(/above the policy maximum \$100/);
    // a reduce-only order may sit above the cap: it can only shrink risk
    expect(m({ limitPx: '250000' }, [rest({ reduceOnly: true, side: 'sell' })])).toBe('');
  });
});

describe('validateProtectSpec (exit levels for one or more legs)', () => {
  // mid 100000; leg 0 long, leg 1 short, both approved
  const hedge = (): OrderContext => ({ snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }))), policy: POLICY });
  const errs = (spec: unknown, ctx = hedge()) => {
    const r = validateProtectSpec(spec, ctx);
    return r.ok ? '' : r.errors.join(' | ');
  };

  it('a hedge: the same two levels become take-profit above and stop-loss below on the long, and the reverse on the short', () => {
    const r = validateProtectSpec({ coin: 'BTC', legs: [0, 1], upPx: '110000', downPx: '90000' }, hedge());
    expect(r.ok && r.plans).toMatchObject([
      { leg: 0, long: true, tpPx: '110000', slPx: '90000' },
      { leg: 1, long: false, slPx: '110000', tpPx: '90000' },
    ]);
  });

  it('one level only, or none (which clears the protection)', () => {
    expect(validateProtectSpec({ coin: 'BTC', legs: [0], upPx: '110000' }, hedge())).toMatchObject({ ok: true, plans: [{ leg: 0, tpPx: '110000' }] });
    const none = validateProtectSpec({ coin: 'BTC', legs: [0, 1] }, hedge());
    expect(none.ok && none.plans.every((p) => p.tpPx === undefined && p.slPx === undefined)).toBe(true);
  });

  it.each([
    ['not an object', 'x', /JSON object/],
    ['extra field', { coin: 'BTC', legs: [0], tpPx: '1' }, /tpPx is not a field/],
    ['no legs', { coin: 'BTC', legs: [] }, /1 to 4 different leg numbers/],
    ['duplicate legs', { coin: 'BTC', legs: [0, 0] }, /different leg numbers/],
    ['upper level below the market', { coin: 'BTC', legs: [0], upPx: '99000' }, /upPx must be above the market/],
    ['lower level above the market', { coin: 'BTC', legs: [0], downPx: '101000' }, /downPx must be below the market/],
    ['not a price', { coin: 'BTC', legs: [0], upPx: 'abc' }, /positive decimal/],
    ['too many digits', { coin: 'BTC', legs: [0], upPx: '110000.123456' }, /not a valid BTC price/],
    ['a leg that is not registered', { coin: 'BTC', legs: [0, 2] }, /leg 2 is not registered/],
    ['coin outside the allow-list', { coin: 'DOGE', legs: [0] }, /coin must be one of/],
  ])('refuses %s', (_n, spec, re) => {
    expect(errs(spec)).toMatch(re);
  });

  it('refuses a leg with no position, a leg without a key, and a leg running a strategy', () => {
    const flatLeg: OrderContext = { snapshot: approved(snap(ch(), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }))), policy: POLICY };
    expect(errs({ coin: 'BTC', legs: [0, 1], upPx: '110000' }, flatLeg)).toMatch(/leg 0 holds no BTC to protect/);
    expect(errs({ coin: 'BTC', legs: [0] }, { snapshot: snap(ch({ positions: [{ coin: 'BTC', szi: '1' }] }), ch()), policy: POLICY })).toMatch(/no approved agent key/);
    expect(errs({ coin: 'BTC', legs: [1] }, { ...hedge(), busyLegs: [1] })).toMatch(/leg 1 is running a strategy/);
  });
});

import { describe, expect, it } from 'vitest';
import { RelayRejectionError, type HlOrderResult } from '@perps-platform/core';
import { parseCloid } from '../src/cloid.ts';
import { planCloseHedge, planDecision } from '../src/hedge.ts';
import { HedgePairExecutor, validateHedgePairSpec, type HedgePairSpec } from '../src/hedgePair.ts';
import type { OrderContext } from '../src/order.ts';
import { ch, OWNER, POLICY, snap } from './agent-helpers.ts';

// mid 100000, BTC szDecimals 5, policy: 5x, $100 per order, slippage 3%
const approved = (s: ReturnType<typeof snap>) => ({ ...s, legs: s.legs.map((l) => ({ ...l, agent: { address: l.address, name: `leg${l.leg}`, approvedAt: 1 } })) });
const flat = (extra: Partial<OrderContext> = {}): OrderContext => ({ snapshot: approved(snap(ch({ withdrawable: 50 }), ch({ withdrawable: 50 }))), policy: POLICY, ...extra });
const spec = (x: Partial<HedgePairSpec> = {}): HedgePairSpec => ({ coin: 'BTC', side: 'long', size: '0.0004', ratio: '0.5', leverageA: 4, ...x });
const errs = (s: unknown, ctx = flat(), opts?: { combinedCap?: boolean }) => {
  const r = validateHedgePairSpec(s, ctx, opts);
  return r.ok ? '' : r.errors.join(' | ');
};

describe('validateHedgePairSpec', () => {
  it('accepts a long hedge and resolves both legs (leg 1 takes leg 0 leverage and margin by default)', () => {
    const r = validateHedgePairSpec(spec({ size: '0.0006' }), flat());
    expect(r).toMatchObject({ ok: true, plan: { asset: 3, isBuyA: true, sizeA: '0.00060', sizeB: '0.00030', notionalA: 60, notionalB: 30, leverageA: { value: 4, isCross: true }, leverageB: { value: 4, isCross: true } } });
  });

  it('a short hedge sells on leg 0; leg 1 may have its own leverage and margin mode', () => {
    const r = validateHedgePairSpec(spec({ side: 'short', size: '0.0003', ratio: '1', leverageB: 2, isCrossB: false }), flat());
    expect(r).toMatchObject({ ok: true, plan: { isBuyA: false, leverageB: { value: 2, isCross: false } } });
  });

  it.each([
    ['not an object', 'x', /JSON object/],
    ['unknown field', spec({ foo: 1 } as never), /foo is not a field/],
    ['side', spec({ side: 'buy' as never }), /side must be/],
    ['coin outside the allow-list', spec({ coin: 'DOGE' }), /coin must be one of/],
    ['size decimals', spec({ size: '0.000123456' }), /more than 5 decimals/],
    ['ratio too small', spec({ ratio: '0.05' }), /ratio must be/],
    ['ratio above 1', spec({ ratio: '1.5' }), /ratio must be/],
    ['no leverage', spec({ leverageA: undefined as never }), /leverageA must be a whole number/],
    ['leverage above policy', spec({ leverageA: 9 }), /leverageA 9x is above the policy maximum 5x/],
    ['leverageB above policy', spec({ leverageB: 9 }), /leverageB 9x is above the policy maximum 5x/],
    ['leg 1 below the exchange minimum', spec({ size: '0.0002', ratio: '0.2' }), /leg 1 notional \$4 is below the Hyperliquid minimum/],
    ['above the per-leg cap', spec({ size: '0.0012', ratio: '1' }), /above the policy maximum \$100/],
    ['spread limit out of range', spec({ maxSpreadBps: 900 }), /maxSpreadBps/],
  ])('refuses %s', (_n, s, re) => {
    expect(errs(s)).toMatch(re);
  });

  it('refuses when a leg already holds the coin (that is hedging an existing position)', () => {
    const ctx: OrderContext = { snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch())), policy: POLICY };
    expect(errs(spec(), ctx)).toMatch(/leg 0 already holds BTC/);
  });

  it('refuses a leg without an approved key, a leg running a strategy, and a leg without enough margin', () => {
    expect(errs(spec(), { snapshot: snap(ch(), ch()), policy: POLICY })).toMatch(/no approved agent key/);
    expect(errs(spec(), flat({ busyLegs: [1] }))).toMatch(/leg 1 is running a strategy/);
    const poor: OrderContext = { snapshot: approved(snap(ch({ withdrawable: 50 }), ch({ withdrawable: 1 }))), policy: POLICY };
    expect(errs(spec({ size: '0.0008', ratio: '1' }), poor)).toMatch(/leg 1 has \$1.00 available but needs about \$21/);
  });

  it('a session counts both legs together against the notional cap', () => {
    const s = spec({ size: '0.0007', ratio: '1' }); // $70 per leg: fine for the owner, $140 together is not for a session
    expect(errs(s)).toBe('');
    expect(errs(s, flat(), { combinedCap: true })).toMatch(/both legs together \(\$140\) are above the session's notional cap \$100/);
  });
});

describe('a short hedge (leg 0 short, leg 1 long) against the rest of the hedge code', () => {
  const shortHedge = approved(snap(ch({ positions: [{ coin: 'BTC', szi: '-0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '0.0002' }] })));
  it('closing buys back leg 0 and sells leg 1, both reduce-only', () => {
    const p = planCloseHedge(shortHedge, 'BTC', POLICY);
    expect(p.ok && p.orders.map((o) => [o.leg, o.isBuy, o.size, o.reduceOnly])).toEqual([[0, true, '0.00040', true], [1, false, '0.00020', true]]);
  });
  it('the decision layer only works on leg 0 long / leg 1 short and says so for this layout', () => {
    expect(planDecision(shortHedge, 'reduce_hedge', 'BTC', POLICY)).toMatchObject({ ok: false, reason: expect.stringMatching(/no open BTC hedge \(leg0 long, leg1 short\)/) });
  });
});

// ---- the executor, against fake clients ----
type Sent = { leg: number; isBuy: boolean; size: string; price: string; reduceOnly?: boolean; tif?: string; c?: string };
const filled = (sz: string, px = '100010'): HlOrderResult => ({ response: { data: { statuses: [{ filled: { oid: 1, totalSz: sz, avgPx: px } }] } } }) as unknown as HlOrderResult;
const refused = (error: string): HlOrderResult => ({ response: { data: { statuses: [{ error }] } } }) as unknown as HlOrderResult;

function rig(replies: (s: Sent, n: number) => HlOrderResult | Error, book = { bid: '99995', ask: '100005', time: Date.now() }) {
  const sent: Sent[] = [];
  const leverage: { leg: number; leverage: number; isCross: boolean }[] = [];
  const client = (leg: number) => ({
    updateLeverage: async (p: { leverage: number; isCross: boolean }) => void leverage.push({ leg, leverage: p.leverage, isCross: p.isCross }),
    limitOrderOpen: async (p: Omit<Sent, 'leg'>) => {
      const s = { leg, ...p };
      sent.push(s);
      const r = replies(s, sent.length);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const legs = {
    hl: {
      l2Book: async () => ({ coin: 'BTC', time: book.time, levels: [[{ px: book.bid, sz: '1', n: 1 }], [{ px: book.ask, sz: '1', n: 1 }]] }),
      userFills: async () => [],
    },
    tradingClient: (_o: string, leg: number) => client(leg),
  };
  const events: Record<string, unknown>[] = [];
  const exec = new HedgePairExecutor(legs as never, POLICY, { emit: (_t: string, d: Record<string, unknown>) => void events.push(d) } as never);
  const run = (s: HedgePairSpec = spec({ size: '0.0010', ratio: '0.5' })) => {
    const v = validateHedgePairSpec(s, flat());
    if (!v.ok) throw new Error(v.errors.join('; '));
    return exec.open(OWNER, v.spec, v.plan);
  };
  return { sent, leverage, events, run };
}

describe('HedgePairExecutor.open', () => {
  it('sets leverage on both legs, then sends both IOC orders off one book: buy at the ask, sell at the bid, one cloid group', async () => {
    const r = rig((s) => filled(s.size, s.isBuy ? '100008' : '99992'));
    const out = await r.run();
    expect(r.leverage).toEqual([{ leg: 0, leverage: 4, isCross: true }, { leg: 1, leverage: 4, isCross: true }]);
    expect(r.sent).toHaveLength(2);
    const [a, b] = r.sent as [Sent, Sent];
    expect([a.leg, a.isBuy, a.size, a.tif, a.reduceOnly]).toEqual([0, true, '0.00100', 'Ioc', undefined]);
    expect([b.leg, b.isBuy, b.size]).toEqual([1, false, '0.00050']);
    expect(Number(a.price)).toBeGreaterThan(100005); // the ask plus the entry buffer
    expect(Number(b.price)).toBeLessThan(99995);
    const [ca, cb] = [parseCloid(a.c), parseCloid(b.c)];
    expect(ca).toMatchObject({ kind: 'hedgeOpen' });
    expect(cb?.group).toBe(ca?.group);
    expect(out).toMatchObject({ status: 'filled', unwind: [], open: [0.001, 0.0005], book: { bid: 99995, ask: 100005 } });
    expect(out.spreadBps).toBe(1.6); // (100008 - 99992) / mid 100000
  });

  it('refuses before sending anything when the book is wider than the limit or stale', async () => {
    await expect(rig(() => filled('0'), { bid: '99900', ask: '100100', time: Date.now() }).run()).rejects.toThrow(/spread is 20 bps/);
    const stale = rig(() => filled('0'), { bid: '99995', ask: '100005', time: Date.now() - 60_000 });
    await expect(stale.run()).rejects.toThrow(/stale/);
    expect(stale.sent).toHaveLength(0);
  });

  it('one leg refused: the other leg, which filled, is closed again (unwound), and leg 0 failing alone is reported too', async () => {
    const r = rig((s) => (s.leg === 1 && !s.reduceOnly ? refused('Order could not immediately match') : filled(s.size)));
    const out = await r.run();
    expect(out.status).toBe('unwound');
    expect(out.legs[1]).toMatchObject({ filled: 0, error: 'Order could not immediately match' });
    expect(r.sent[2]).toMatchObject({ leg: 0, isBuy: false, reduceOnly: true, size: '0.00100', tif: 'Ioc' });
    expect(parseCloid(r.sent[2]!.c)?.kind).toBe('hedgeClose');
    expect(parseCloid(r.sent[2]!.c)?.group).not.toBe(parseCloid(r.sent[0]!.c)?.group); // history must not fold the unwind into the open
    expect(out.open).toEqual([0, 0]);
  });

  it('a thrown network error on one leg counts as no fill and does not hide the other leg\'s fill', async () => {
    const r = rig((s) => (s.leg === 0 && !s.reduceOnly ? new Error('socket hang up') : filled(s.size)));
    const out = await r.run();
    expect(out.status).toBe('unwound');
    expect(out.legs[0]).toMatchObject({ filled: 0, error: 'socket hang up' });
    expect(r.sent[2]).toMatchObject({ leg: 1, isBuy: true, reduceOnly: true });
  });

  it('nothing filled: failed, no reduce orders', async () => {
    const r = rig(() => refused('Order could not immediately match'));
    const out = await r.run();
    expect(out.status).toBe('failed');
    expect(r.sent).toHaveLength(2);
  });

  it('partial fills out of ratio: the larger side is reduced to ratio x the other, in the requested ratio afterwards', async () => {
    // leg 0 fills 0.001, leg 1 only 0.0004 of its 0.0005: leg 0 should be 0.0008
    const r = rig((s) => (s.reduceOnly ? filled(s.size) : filled(s.leg === 0 ? s.size : '0.00040')));
    const out = await r.run();
    expect(out.status).toBe('trimmed');
    expect(r.sent[2]).toMatchObject({ leg: 0, isBuy: false, reduceOnly: true, size: '0.00020' });
    expect(out.open[0]).toBeCloseTo(0.0008, 9);
    expect(out.open[1]).toBeCloseTo(0.0004, 9);
  });

  it('a drift of one lot is left alone', async () => {
    const r = rig((s) => filled(s.leg === 0 ? '0.00099' : '0.00050'));
    const out = await r.run(spec({ size: '0.0010', ratio: '0.5' }));
    expect(out.status).toBe('trimmed');
    expect(r.sent).toHaveLength(2);
  });

  it('a surplus below the exchange minimum cannot be closed: reported as unbalanced, never hidden', async () => {
    // leg 1 over-filled by 0.00005 BTC = $5
    const r = rig((s) => filled(s.leg === 0 ? '0.00100' : '0.00055'));
    const out = await r.run();
    expect(out.status).toBe('unbalanced');
    expect(out.notes.join(' ')).toMatch(/below the exchange minimum/);
    expect(r.sent).toHaveLength(2);
  });

  it('an unwind that fails is reported as unbalanced with what is still open', async () => {
    const r = rig((s) => (s.reduceOnly ? refused('Reduce only order would increase position') : s.leg === 1 ? refused('no match') : filled(s.size)));
    const out = await r.run();
    expect(out.status).toBe('unbalanced');
    expect(out.open).toEqual([0.001, 0]);
    expect(out.notes.join(' ')).toMatch(/could not bring leg 0 back to the ratio/);
  });

  it('a leverage the exchange refuses sends no order', async () => {
    const r = rig(() => filled('0.001'));
    const exec = new HedgePairExecutor(
      { hl: { l2Book: async () => ({ coin: 'BTC', time: Date.now(), levels: [[{ px: '99995', sz: '1', n: 1 }], [{ px: '100005', sz: '1', n: 1 }]] }) }, tradingClient: () => ({ updateLeverage: async () => { throw new RelayRejectionError({ cause: new Error('Cannot switch leverage type with open position.') }); } }) } as never,
      POLICY,
    );
    const v = validateHedgePairSpec(spec(), flat());
    if (!v.ok) throw new Error('setup');
    await expect(exec.open(OWNER, v.spec, v.plan)).rejects.toThrow(/could not set the leverage.*nothing was sent/);
    expect(r.sent).toHaveLength(0);
  });
});

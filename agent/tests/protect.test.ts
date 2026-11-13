import { describe, expect, it } from 'vitest';
import { RelayRejectionError, type HlOrderResult } from '@perps-platform/core';
import { OrderExecutor } from '../src/orders.ts';
import { validateProtectSpec, type OrderContext } from '../src/order.ts';
import { parseCloid } from '../src/cloid.ts';
import { ch, OWNER, POLICY, snap } from './agent-helpers.ts';

const approved = (s: ReturnType<typeof snap>) => ({ ...s, legs: s.legs.map((l) => ({ ...l, agent: { address: l.address, name: `leg${l.leg}`, approvedAt: 1 } })) });
const ctx = (): OrderContext => ({ snapshot: approved(snap(ch({ positions: [{ coin: 'BTC', szi: '0.0004' }] }), ch({ positions: [{ coin: 'BTC', szi: '-0.0002' }] }))), policy: POLICY });
const ok = (n: number): HlOrderResult => ({ response: { data: { statuses: Array.from({ length: n }, (_, i) => ({ resting: { oid: 900 + i } })) } } }) as unknown as HlOrderResult;

/** each leg has two old position triggers (oids 1, 2 / 101, 102) and an unrelated limit order (3 / 103) that must survive */
function rig(opts: { failPlace?: number; failCancel?: number } = {}) {
  const sent: { leg: number; orders: any[]; grouping: string }[] = [];
  const cancelled: { leg: number; oid: number }[] = [];
  const addr = snap(ch()).legs.map((l) => l.address as string);
  const old = (leg: number) => [
    { coin: 'BTC', oid: leg * 100 + 1, isTrigger: true, isPositionTpsl: true },
    { coin: 'BTC', oid: leg * 100 + 2, isTrigger: true, isPositionTpsl: true },
    { coin: 'BTC', oid: leg * 100 + 3, isTrigger: false, isPositionTpsl: false },
  ];
  const legs = {
    hl: { frontendOpenOrders: async ({ user }: { user: string }) => old(addr.indexOf(user)) },
    client: { getLeg: async (_o: string, leg: number) => addr[leg] },
    tradingClient: (_o: string, leg: number) => ({
      order: async (p: { orders: any[]; grouping: string }) => {
        if (leg === opts.failPlace) throw new RelayRejectionError({ cause: new Error('Trigger price too close to market') });
        sent.push({ leg, ...p });
        return ok(p.orders.length);
      },
      cancelOrder: async ({ oid }: { oid: number }) => {
        if (leg === opts.failCancel) throw new RelayRejectionError({ cause: new Error('Order was never placed, already canceled, or filled') });
        cancelled.push({ leg, oid });
      },
    }),
  };
  return { exec: new OrderExecutor(legs as never, POLICY), sent, cancelled };
}
const plan = (spec: unknown) => {
  const v = validateProtectSpec(spec, ctx());
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v;
};

describe('OrderExecutor.protect', () => {
  it('a hedge: both legs get position-sized brackets at the same two prices, the old triggers go, other orders stay', async () => {
    const r = rig();
    const v = plan({ coin: 'BTC', legs: [0, 1], upPx: '110000', downPx: '90000' });
    const out = await r.exec.protect(OWNER, v.spec, v.plans);
    expect(out).toMatchObject({ status: 'ok', legs: [{ leg: 0, ok: true, placed: 2, cancelled: [1, 2] }, { leg: 1, ok: true, placed: 2, cancelled: [101, 102] }] });
    const [a, b] = [r.sent.find((s) => s.leg === 0)!, r.sent.find((s) => s.leg === 1)!];
    expect(a.grouping).toBe('positionTpsl');
    // leg 0 is long: sells that fire at 110000 (take profit) and 90000 (stop loss), size 0 = the whole position, reduce only
    expect(a.orders.map((o) => [o.b, o.s, o.r, o.t.trigger.triggerPx, o.t.trigger.tpsl])).toEqual([[false, '0', true, '110000', 'tp'], [false, '0', true, '90000', 'sl']]);
    // leg 1 is short: buys that fire at the same two prices, with the roles swapped
    expect(b.orders.map((o) => [o.b, o.t.trigger.triggerPx, o.t.trigger.tpsl])).toEqual([[true, '90000', 'tp'], [true, '110000', 'sl']]);
    expect(parseCloid(a.orders[0].c)?.kind).toBe('protect');
    expect(r.cancelled.map((c) => c.oid).sort((x, y) => x - y)).toEqual([1, 2, 101, 102]); // the limit orders 3 and 103 stay
  });

  it('clearing: nothing is placed, the old triggers are cancelled', async () => {
    const r = rig();
    const v = plan({ coin: 'BTC', legs: [0] });
    const out = await r.exec.protect(OWNER, v.spec, v.plans);
    expect(out).toMatchObject({ status: 'ok', legs: [{ placed: 0, cancelled: [1, 2] }] });
    expect(r.sent).toHaveLength(0);
  });

  it('one leg refused: the other leg is kept and the result says partial; the refused leg keeps its OLD triggers', async () => {
    const r = rig({ failPlace: 1 });
    const v = plan({ coin: 'BTC', legs: [0, 1], upPx: '110000', downPx: '90000' });
    const out = await r.exec.protect(OWNER, v.spec, v.plans);
    expect(out.status).toBe('partial');
    expect(out.legs[0]).toMatchObject({ leg: 0, ok: true });
    expect(out.legs[1]).toMatchObject({ leg: 1, ok: false, placed: 0, cancelled: [], error: expect.stringMatching(/too close/) });
    expect(r.cancelled.every((c) => c.leg === 0)).toBe(true);
  });

  it('an old trigger that cannot be cancelled is reported (the new ones are already set)', async () => {
    const r = rig({ failCancel: 0 });
    const v = plan({ coin: 'BTC', legs: [0], upPx: '110000' });
    const out = await r.exec.protect(OWNER, v.spec, v.plans);
    expect(out).toMatchObject({ status: 'failed', legs: [{ leg: 0, ok: false, placed: 1, error: expect.stringMatching(/new triggers are set but an old one could not be cancelled/) }] });
  });
});

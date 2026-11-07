import { describe, expect, it } from 'vitest';
import { gridPrices, missingOrders, reconcile, wantedOrders } from '../src/strategy/grid';
import type { PlaceRequest, TradingPort } from '../src/strategy/port';
import { StrategyRunner } from '../src/strategy/runner';
import { validateSpec, type GridSpec, type SpecContext, type StrategySpec } from '../src/strategy/spec';
import fx from './fixtures/strategy-spec.json';

const ctx = fx.context as unknown as SpecContext;
const v = validateSpec(fx.base, ctx);
if (!v.ok) throw new Error('fixture spec invalid');
const spec = v.spec as GridSpec;

/** In-memory exchange: resting orders by oid, fills the test adds by hand. */
class FakePort implements TradingPort {
  mid = 74000;
  pnlTotal = 0;
  pos = 0;
  frozen = false;
  deadmanRefuses = false;
  iocRefuses = false;
  cancelFailures = 0;
  open = new Map<string, PlaceRequest>();
  fills = new Set<string>();
  placed: PlaceRequest[] = [];
  cancelled: string[] = [];
  flattened = 0;
  deadman: (number | undefined)[] = [];
  #oid = 1;
  async info() {
    return { asset: 3, szDecimals: 5, mid: this.mid };
  }
  async openOids() {
    return new Set(this.open.keys());
  }
  async filledOids() {
    return new Set(this.fills);
  }
  async position() {
    return this.pos;
  }
  async pnl() {
    return { realized: this.pnlTotal, fees: 0, unrealized: 0, funding: 0, total: this.pnlTotal, fills: 0 };
  }
  async setLeverage() {}
  async place(o: PlaceRequest) {
    this.placed.push(o);
    if (o.tif === 'Ioc') return this.iocRefuses ? { error: 'Order could not immediately match' } : { oid: String(this.#oid++), fill: { sz: Number(o.sz), px: Number(o.px) } };
    const oid = String(this.#oid++);
    this.open.set(oid, o);
    return { oid };
  }
  async cancel(_a: number, oids: string[]) {
    if (this.cancelFailures-- > 0) throw new Error('HL unreachable');
    for (const o of oids) {
      this.cancelled.push(o);
      this.open.delete(o);
    }
  }
  async flatten() {
    this.flattened++;
  }
  async armDeadman(t?: number) {
    if (this.deadmanRefuses) throw new Error('Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.');
    this.deadman.push(t);
  }
  fill(oid: string) {
    this.open.delete(oid);
    this.fills.add(oid);
  }
}

function setup(over: Partial<FakePort> = {}, useSpec: StrategySpec = spec) {
  const port = Object.assign(new FakePort(), over);
  const events: { type: string; data: Record<string, any> }[] = [];
  const clock = { t: 1_700_000_000_000 };
  const runner = new StrategyRunner({
    spec: useSpec, port, policy: ctx.orderPolicy,
    emit: (type, data) => events.push({ type, data }),
    isFrozen: async () => port.frozen,
    now: () => clock.t,
  });
  return { port, runner, events, clock, types: () => events.map((e) => e.type) };
}

describe('grid planner', () => {
  const prices = gridPrices(spec.params, 5);
  it('spaces levels evenly from lower to upper', () => {
    expect(prices).toEqual([70000, 72500, 75000, 77500, 80000]);
  });
  it('buys below the market, sells reduce-only one level above held inventory', () => {
    const w = wantedOrders(prices, 0.00015, 74000, []);
    expect(w.map((x) => [x.level, x.side, x.px])).toEqual([[0, 'buy', 70000], [1, 'buy', 72500]]);
    const h = wantedOrders(prices, 0.00015, 74000, [1]);
    expect(h.map((x) => [x.level, x.side, x.px, x.reduceOnly])).toEqual([[0, 'buy', 70000, false], [1, 'sell', 75000, true]]);
  });
  it('the top level sells one step above upper', () => {
    expect(wantedOrders(prices, 0.00015, 79000, [4]).find((x) => x.level === 4)).toMatchObject({ side: 'sell', px: 82500 });
  });
  it('skips orders that already rest', () => {
    const w = wantedOrders(prices, 0.00015, 74000, []);
    expect(missingOrders(w, { a: { level: 0, side: 'buy', px: 70000, sz: 0.00015 } }).map((x) => x.level)).toEqual([1]);
  });
  it('reconcile: a filled buy holds the level, a filled sell frees it, a vanished order is lost', () => {
    const state = { held: [2], orders: { b: { level: 1, side: 'buy' as const, px: 72500, sz: 1 }, s: { level: 2, side: 'sell' as const, px: 77500, sz: 1 }, x: { level: 0, side: 'buy' as const, px: 70000, sz: 1 } } };
    const r = reconcile(state, new Set(), new Set(['b', 's']));
    expect(r.state.held).toEqual([1]);
    expect(r.lost.map((l) => l.oid)).toEqual(['x']);
    expect(r.filled.map((l) => l.oid).sort()).toEqual(['b', 's']);
  });
});

describe('StrategyRunner', () => {
  it('places the ladder once, then does nothing on the next tick', async () => {
    const { port, runner, types } = setup();
    await runner.tick();
    expect(port.placed.map((p) => [p.isBuy, p.px, p.sz, p.reduceOnly])).toEqual([[true, '70000', '0.00015', false], [true, '72500', '0.00015', false]]);
    await runner.tick();
    expect(port.placed).toHaveLength(2);
    expect(types().filter((t) => t === 'strategy.order')).toHaveLength(2);
  });

  it('a filled buy turns into a reduce-only sell one level up', async () => {
    const { port, runner, types } = setup();
    await runner.tick();
    port.fill('2'); // the 72500 buy
    port.pos = 0.00015;
    await runner.tick();
    expect(port.placed.at(-1)).toMatchObject({ isBuy: false, px: '75000', reduceOnly: true });
    expect(types()).toContain('strategy.fill');
    expect(runner.grid.held).toEqual([1]);
  });

  it('refuses an order that breaks maxNotional and never sends it', async () => {
    const { port, runner, events } = setup({ pos: 0.0013 }); // $96 of BTC already, limit $100
    await runner.tick();
    expect(port.placed).toHaveLength(0);
    expect(events.filter((e) => e.type === 'strategy.order.refused')[0]?.data.reason).toContain('would exceed maxNotional');
  });

  it('kill switch: pause cancels every resting order, removes the dead-man and places nothing more', async () => {
    const { port, runner, types } = setup();
    await runner.tick();
    await runner.pause('test');
    expect(port.open.size).toBe(0);
    expect(port.cancelled).toHaveLength(2);
    expect(port.deadman.at(-1)).toBeUndefined();
    port.mid = 76000;
    await runner.tick();
    expect(port.placed).toHaveLength(2);
    expect(types()).toContain('strategy.paused');
  });

  it('kill switch retries a failed cancel and reports orders that still rest', async () => {
    const { port, runner, types } = setup();
    await runner.tick();
    let fails = 1;
    const cancel = port.cancel.bind(port);
    port.cancel = async (a, o) => {
      if (fails-- > 0) throw new Error('transient');
      return cancel(a, o);
    };
    await runner.pause('test');
    expect(port.open.size).toBe(0);
    expect(types()).toContain('strategy.paused');
  });

  it('a pause that cannot clear the book keeps retrying every tick (cancelling) and says so', async () => {
    const { port, runner, types } = setup({ cancelFailures: 3 });
    await runner.tick(); // two resting buys
    await runner.pause('test'); // three tries fail
    expect(runner.state).toBe('cancelling');
    expect(port.open.size).toBe(2);
    expect(types()).toContain('strategy.cancel_failed');
    await runner.tick(); // the retry succeeds
    expect(runner.state).toBe('paused');
    expect(port.open.size).toBe(0);
    expect(types()).toContain('strategy.cancelled');
    port.mid = 76000;
    await runner.tick();
    expect(port.placed).toHaveLength(2); // nothing new was placed meanwhile
  });

  it('a stop that cannot clear the book ends stopped only after the retry empties it', async () => {
    const { port, runner } = setup({ cancelFailures: 6 }); // three tries per attempt: the stop fails, the first retry fails, the second succeeds
    await runner.tick();
    await runner.stop('test');
    expect(runner.state).toBe('cancelling');
    await runner.tick(); // the first retry fails too
    expect(runner.state).toBe('cancelling');
    await runner.tick();
    expect(runner.state).toBe('stopped');
    expect(port.open.size).toBe(0);
  });

  it('stop with onStop flatten also closes the position', async () => {
    const { port, events } = setup();
    const runner = new StrategyRunner({ spec: { ...spec, onStop: 'flatten' }, port, policy: ctx.orderPolicy, emit: (t, d) => events.push({ type: t, data: d }), isFrozen: async () => false });
    await runner.tick();
    await runner.stop('test');
    expect(port.flattened).toBe(1);
    expect(runner.state).toBe('stopped');
  });

  it('pauses itself when its own PnL falls below -maxDailyLoss (not on equity)', async () => {
    const { port, runner } = setup();
    await runner.tick();
    port.pnlTotal = -spec.limits.maxDailyLoss - 1;
    await runner.tick();
    expect(runner.state).toBe('paused');
    expect(port.open.size).toBe(0);
  });

  it('freeze: cancels what rests, stops, and never places again', async () => {
    const { port, runner, types } = setup();
    await runner.tick();
    port.frozen = true;
    await runner.tick();
    expect(runner.state).toBe('frozen');
    expect(port.open.size).toBe(0);
    port.frozen = false;
    await runner.tick();
    expect(port.placed).toHaveLength(2);
    expect(types()).toContain('strategy.frozen');
  });

  it('dead-man refused by the exchange is non-fatal: reported once, trading goes on', async () => {
    const { port, runner, events } = setup({ deadmanRefuses: true });
    await runner.tick();
    await runner.tick();
    expect(runner.deadman).toBe('unavailable');
    expect(events.filter((e) => e.type === 'strategy.deadman')).toHaveLength(1);
    expect(port.placed).toHaveLength(2);
    expect(runner.state).toBe('running');
  });

  it('dead-man is re-armed ahead of now on every tick when the exchange allows it', async () => {
    const { port, runner } = setup();
    await runner.tick();
    await runner.tick();
    expect(port.deadman).toEqual([1_700_000_120_000, 1_700_000_120_000]);
    expect(runner.deadman).toBe('armed');
  });

  it('five consecutive errors pause the runner', async () => {
    const { port, runner } = setup();
    port.info = async () => {
      throw new Error('HL down');
    };
    for (let i = 0; i < 5; i++) await runner.tick();
    expect(runner.state).toBe('paused');
  });
});

describe('StrategyRunner twap', () => {
  const t = validateSpec(fx.twap, ctx);
  if (!t.ok) throw new Error(`twap fixture invalid: ${t.errors.join('; ')}`);
  const twap = t.spec;

  it('sends one IOC slice per interval, capped by limitPx, and finishes after the last slice', async () => {
    const { port, runner, clock, types } = setup({}, twap);
    await runner.tick();
    expect(port.placed).toHaveLength(1);
    expect(port.placed[0]).toMatchObject({ isBuy: true, tif: 'Ioc', sz: '0.00015', reduceOnly: false });
    await runner.tick(); // same interval: nothing
    expect(port.placed).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      clock.t += 10_000;
      await runner.tick();
    }
    expect(port.placed).toHaveLength(3);
    expect(runner.state).toBe('done');
    expect(runner.twap).toMatchObject({ done: 3, skipped: 0 });
    expect(types().filter((x) => x === 'strategy.slice')).toHaveLength(3);
    expect(types()).toContain('strategy.done');
  });

  it('a buy never pays above limitPx: the slice is skipped when the mid is beyond it', async () => {
    const { port, runner, events } = setup({ mid: 90_000 }, twap);
    await runner.tick();
    expect(port.placed).toHaveLength(0);
    expect(runner.twap.skipped).toBe(1);
    expect(events.find((e) => e.type === 'strategy.slice.skipped')?.data.reason).toContain('beyond limitPx');
  });

  it('a slice with no fill is skipped, and the run still ends', async () => {
    const { port, runner, clock } = setup({ iocRefuses: true }, twap);
    for (let i = 0; i < 3; i++) {
      await runner.tick();
      clock.t += 10_000;
    }
    expect(port.placed).toHaveLength(3);
    expect(runner.twap).toMatchObject({ done: 0, skipped: 3 });
    expect(runner.state).toBe('done');
  });

  it('the exposure gate stops a slice that would pass maxNotional', async () => {
    const { port, runner } = setup({ pos: 0.0013 }, twap); // $96 already, limit $100
    await runner.tick();
    expect(port.placed).toHaveLength(0);
    expect(runner.twap.skipped).toBe(1);
  });

  it('snapshot restores progress: a paused runner keeps its counts and resumes', async () => {
    const { runner, clock, port } = setup({}, twap);
    await runner.tick();
    await runner.pause('test');
    const saved = runner.snapshot();
    expect(saved).toMatchObject({ state: 'paused', twap: { done: 1 } });
    const again = new StrategyRunner({ spec: twap, port, policy: ctx.orderPolicy, emit: () => {}, isFrozen: async () => false, now: () => clock.t, initial: saved });
    expect(again.resume()).toBe(true);
    clock.t += 10_000;
    await again.tick();
    expect(again.twap.done).toBe(2);
  });
});

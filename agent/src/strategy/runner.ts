// Runs one strategy on its own leg. Every order goes through checkOrder (order policy + spec limits) before it is sent.
// The kill switch is pause()/stop(): cancel every resting order of the leg (stop can also flatten) and never place again.
// Freeze-aware: a frozen owner stops the runner at once (the agent key is being revoked, so it only tries to cancel).
import type { OrderPolicy } from '../config.ts';
import { floorSize, roundPx } from '../market.ts';
import { emptyGrid, gridPrices, missingOrders, reconcile, wantedOrders, type GridState } from './grid.ts';
import type { CoinInfo, TradingPort } from './port.ts';
import { checkOrder, type GridSpec, type StrategySpec, type TwapSpec } from './spec.ts';

/** done: a TWAP ran all its slices (a grid never finishes). */
export type RunState = 'running' | 'paused' | 'stopped' | 'frozen' | 'done';
export type Emit = (type: string, data: Record<string, unknown>) => void;

export interface TwapState {
  /** slices that filled */
  done: number;
  /** slices skipped (price beyond limitPx, refused by the gate, or no fill) */
  skipped: number;
  filledSize: number;
  /** epoch ms of the next slice */
  nextAt: number;
}

/** What survives a restart (persisted by the manager). */
export interface RunnerSaved {
  state: RunState;
  held: number[];
  twap: TwapState;
  /** guard top-ups taken today (UTC day number, USD): the strategy's topUpCapPerDay is checked against this */
  topUp: { day: number; usd: number };
}

export interface RunnerOpts {
  spec: StrategySpec;
  port: TradingPort;
  policy: OrderPolicy;
  emit: Emit;
  isFrozen: () => Promise<boolean>;
  /** The dead-man switch is re-armed this far ahead on every tick (must exceed the tick interval). */
  deadmanSec?: number;
  now?: () => number;
  /** Progress from before a restart. */
  initial?: Partial<RunnerSaved>;
  /** Called after every tick and state change (the manager persists). */
  onChange?: () => void;
}

const DAY_MS = 86_400_000;
/** Consecutive tick errors before the runner pauses itself. */
const MAX_ERRORS = 5;

export class StrategyRunner {
  readonly spec: StrategySpec;
  state: RunState = 'running';
  grid: GridState = emptyGrid();
  twap: TwapState = { done: 0, skipped: 0, filledSize: 0, nextAt: 0 };
  topUp = { day: 0, usd: 0 };
  /** 'unavailable': the exchange refused scheduleCancel (testnet and mainnet require $1M traded volume). */
  deadman: 'off' | 'armed' | 'unavailable' = 'off';
  readonly #o: RunnerOpts;
  #leverageSet = false;
  #dayStart?: { day: number; equity: number };
  #errors = 0;
  #busy = false;

  constructor(o: RunnerOpts) {
    this.spec = o.spec;
    this.#o = o;
    if (o.initial?.state) this.state = o.initial.state;
    if (o.initial?.held) this.grid = { held: o.initial.held, orders: {} };
    if (o.initial?.twap) this.twap = { ...o.initial.twap };
    if (o.initial?.topUp) this.topUp = { ...o.initial.topUp };
  }

  snapshot(): RunnerSaved {
    return { state: this.state, held: this.grid.held, twap: this.twap, topUp: this.topUp };
  }

  /** USD of the daily top-up budget (limits.topUpCapPerDay) left today. */
  topUpLeft(): number {
    const day = Math.floor(this.#now / DAY_MS);
    return Math.max(0, this.spec.limits.topUpCapPerDay - (this.topUp.day === day ? this.topUp.usd : 0));
  }

  addTopUp(usd: number) {
    const day = Math.floor(this.#now / DAY_MS);
    this.topUp = { day, usd: (this.topUp.day === day ? this.topUp.usd : 0) + usd };
    this.#o.onChange?.();
  }

  /** Account value at the start of the UTC day, as the daily-loss check sees it (undefined before the first tick). */
  dayStartEquity() {
    return this.#dayStart?.equity;
  }

  get #now() {
    return (this.#o.now ?? Date.now)();
  }
  #emit(type: string, data: Record<string, unknown> = {}) {
    this.#o.emit(`strategy.${type}`, { id: this.spec.id, leg: this.spec.leg, ...data });
  }

  status() {
    return { id: this.spec.id, spec: this.spec, type: this.spec.type, leg: this.spec.leg, coin: this.spec.coin, state: this.state, deadman: this.deadman, held: this.grid.held, resting: Object.keys(this.grid.orders).length, twap: this.spec.type === 'twap' ? this.twap : undefined };
  }

  /** One pass: sync with the exchange, check limits, place what the ladder is missing. Never throws (errors pause after MAX_ERRORS). */
  async tick() {
    if (this.state !== 'running' || this.#busy) return;
    this.#busy = true;
    try {
      await this.#step();
      this.#errors = 0;
    } catch (e) {
      this.#emit('error', { message: (e as Error).message, count: ++this.#errors });
      if (this.#errors >= MAX_ERRORS && this.state === 'running') await this.pause(`${MAX_ERRORS} consecutive errors`);
    } finally {
      this.#busy = false;
      this.#o.onChange?.();
    }
  }

  async #step() {
    const { spec, port } = this.#o;
    if (await this.#o.isFrozen()) return this.freeze();
    const info = await port.info(spec.coin);
    if (!this.#leverageSet) {
      await port.setLeverage(info.asset, spec.limits.maxLeverage);
      this.#leverageSet = true;
    }

    // limits.maxDailyLoss: equity against the day's first reading. shortcut: a top-up during the day offsets a loss, so the
    // check is lenient after top-ups; a per-day ledger of deposits would fix it.
    const equity = await port.equity();
    const day = Math.floor(this.#now / DAY_MS);
    if (this.#dayStart?.day !== day) this.#dayStart = { day, equity };
    if (equity < this.#dayStart.equity - spec.limits.maxDailyLoss) {
      return this.pause(`daily loss: equity $${equity.toFixed(2)} is more than $${spec.limits.maxDailyLoss} below the day's start $${this.#dayStart.equity.toFixed(2)}`);
    }

    if (spec.type === 'twap') return this.#twap(spec, info);
    await this.#grid(spec, info);
  }

  /** TWAP / DCA: one IOC order per interval, through the same gate; a slice that cannot trade is skipped, not retried. */
  async #twap(spec: TwapSpec, info: CoinInfo) {
    const { port } = this.#o;
    const t = this.twap;
    const { side, sizePerSlice, slices, intervalSec, limitPx } = spec.params;
    if (t.done + t.skipped >= slices) return this.#finish();
    if (this.#now < t.nextAt) return;
    t.nextAt = this.#now + intervalSec * 1000; // a refused slice still waits its interval
    const slice = t.done + t.skipped + 1;
    const isBuy = side === 'buy';
    const skip = (reason: string, extra: Record<string, unknown> = {}) => {
      t.skipped++;
      this.#emit('slice.skipped', { slice, reason, ...extra });
    };
    if (isBuy ? info.mid > limitPx : info.mid < limitPx) skip(`mid ${info.mid} is beyond limitPx ${limitPx}`);
    else {
      const slip = this.#o.policy.slippage;
      const px = Number(roundPx(isBuy ? Math.min(info.mid * (1 + slip), limitPx) : Math.max(info.mid * (1 - slip), limitPx), info.szDecimals));
      const sz = Number(floorSize(Number(sizePerSlice), info.szDecimals));
      const check = checkOrder(spec, this.#o.policy, { position: await port.position(spec.coin), restingOpeningNotional: 0 }, { coin: spec.coin, isBuy, px, sz, reduceOnly: false });
      if (!check.ok) {
        this.#emit('order.refused', { slice, px, reason: check.reason });
        skip(check.reason);
      } else {
        const res = await port.place({ asset: info.asset, isBuy, px: String(px), sz: String(sz), reduceOnly: false, tif: 'Ioc' });
        if (res.fill) {
          t.done++;
          t.filledSize += res.fill.sz;
          this.#emit('slice', { slice, side, sz: res.fill.sz, avgPx: res.fill.px, done: t.done, of: slices });
        } else skip(res.error ?? 'no fill', { px });
      }
    }
    if (t.done + t.skipped >= slices) await this.#finish();
  }

  async #finish() {
    if (this.state !== 'running') return;
    this.state = 'done';
    this.#emit('done', { filled: this.twap.done, skipped: this.twap.skipped, filledSize: this.twap.filledSize });
  }

  async #grid(spec: GridSpec, info: CoinInfo) {
    const { port } = this.#o;
    const [open, filled] = await Promise.all([port.openOids(), port.filledOids()]);
    const r = reconcile(this.grid, open, filled);
    this.grid = r.state;
    for (const f of r.filled) this.#emit('fill', { oid: f.oid, level: f.order.level, side: f.order.side, px: f.order.px, sz: f.order.sz });
    for (const f of r.lost) this.#emit('order.lost', { oid: f.oid, level: f.order.level, side: f.order.side });

    const prices = gridPrices(spec.params, info.szDecimals);
    const sz = Number(floorSize(Number(spec.params.sizePerLevel), info.szDecimals));
    const wanted = wantedOrders(prices, sz, info.mid, this.grid.held);
    const position = await port.position(spec.coin);
    for (const w of missingOrders(wanted, this.grid.orders)) {
      if (this.state !== 'running') return; // paused or stopped while this tick was in flight
      const restingOpeningNotional = Object.values(this.grid.orders).reduce((a, o) => (o.side === 'buy' ? a + o.px * o.sz : a), 0);
      const req = { coin: spec.coin, isBuy: w.side === 'buy', px: w.px, sz: w.sz, reduceOnly: w.reduceOnly };
      const check = checkOrder(spec, this.#o.policy, { position, restingOpeningNotional }, req);
      if (!check.ok) {
        this.#emit('order.refused', { level: w.level, side: w.side, px: w.px, reason: check.reason });
        continue;
      }
      const res = await port.place({ asset: info.asset, isBuy: req.isBuy, px: String(w.px), sz: String(w.sz), reduceOnly: w.reduceOnly });
      if (res.oid === undefined) {
        this.#emit('order.rejected', { level: w.level, side: w.side, px: w.px, error: res.error });
        continue;
      }
      this.grid.orders[res.oid] = { level: w.level, side: w.side, px: w.px, sz: w.sz };
      this.#emit('order', { oid: res.oid, level: w.level, side: w.side, px: w.px, sz: w.sz });
    }
    await this.#arm();
  }

  /** Dead-man: if this service dies, the exchange cancels the resting orders after the timeout. Non-fatal when refused. */
  async #arm() {
    if (this.deadman === 'unavailable') return;
    try {
      await this.#o.port.armDeadman(this.#now + (this.#o.deadmanSec ?? 120) * 1000);
      if (this.deadman !== 'armed') this.#emit('deadman', { armed: true });
      this.deadman = 'armed';
    } catch (e) {
      this.deadman = 'unavailable';
      this.#emit('deadman', { armed: false, reason: (e as Error).message });
    }
  }

  /** The kill switch must not give up on one transient failure: three tries. */
  async #killOrders() {
    for (let i = 1; ; i++) {
      try {
        return await this.cancelAll();
      } catch (e) {
        if (i >= 3) throw e;
      }
    }
  }

  /** Cancels every open order of the leg (it is dedicated to this strategy) and forgets them. */
  async cancelAll() {
    const { port, spec } = this.#o;
    const open = [...(await port.openOids())];
    if (open.length) {
      await port.cancel((await port.info(spec.coin)).asset, open);
      const left = await port.openOids();
      if (left.size) throw new Error(`${left.size} orders still resting after cancel`);
    }
    this.grid = { ...this.grid, orders: {} };
    if (this.deadman === 'armed') {
      await port.armDeadman(undefined).catch(() => {});
      this.deadman = 'off';
    }
    return open.length;
  }

  /** After a restart: orders the previous process left on the book are cancelled; the runner stays paused until resumed. */
  async cleanup() {
    const cancelled = await this.#killOrders();
    this.#emit('restored', { state: this.state, cancelled, held: this.grid.held, twap: this.spec.type === 'twap' ? this.twap : undefined });
    return cancelled;
  }

  resume() {
    if (this.state !== 'paused' && this.state !== 'frozen') return false;
    this.state = 'running';
    this.#errors = 0;
    this.#emit('resumed');
    return true;
  }

  async pause(reason: string) {
    if (this.state !== 'running') return;
    this.state = 'paused';
    const cancelled = await this.#killOrders().catch((e) => `cancel failed: ${(e as Error).message}`);
    this.#emit('paused', { reason, cancelled });
  }

  async stop(reason: string) {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    const cancelled = await this.#killOrders().catch((e) => `cancel failed: ${(e as Error).message}`);
    let flattened = false;
    if (this.spec.onStop === 'flatten') {
      await this.#o.port.flatten(this.spec.coin).then(() => (flattened = true), (e) => this.#emit('error', { message: `flatten failed: ${(e as Error).message}` }));
    }
    this.#emit('stopped', { reason, cancelled, flattened });
  }

  /** The owner froze: the agent key is being revoked, so cancel while it still works, then never trade again. */
  async freeze() {
    if (this.state === 'frozen' || this.state === 'stopped') return;
    this.state = 'frozen';
    const cancelled = await this.#killOrders().catch((e) => `cancel failed (key already revoked?): ${(e as Error).message}`);
    this.#emit('frozen', { cancelled });
  }
}

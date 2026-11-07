// Runs one strategy on its own leg. Every order goes through checkOrder (order policy + spec limits) before it is sent.
// The kill switch is pause()/stop(): cancel every resting order of the leg (stop can also flatten) and never place again.
// Freeze-aware: a frozen owner stops the runner at once (the agent key is being revoked, so it only tries to cancel).
import type { OrderPolicy } from '../config.ts';
import { floorSize } from '../market.ts';
import { emptyGrid, gridPrices, missingOrders, reconcile, wantedOrders, type GridState } from './grid.ts';
import type { TradingPort } from './port.ts';
import { checkOrder, type StrategySpec } from './spec.ts';

export type RunState = 'running' | 'paused' | 'stopped' | 'frozen';
export type Emit = (type: string, data: Record<string, unknown>) => void;

export interface RunnerOpts {
  spec: StrategySpec;
  port: TradingPort;
  policy: OrderPolicy;
  emit: Emit;
  isFrozen: () => Promise<boolean>;
  /** The dead-man switch is re-armed this far ahead on every tick (must exceed the tick interval). */
  deadmanSec?: number;
  now?: () => number;
}

const DAY_MS = 86_400_000;
/** Consecutive tick errors before the runner pauses itself. */
const MAX_ERRORS = 5;

export class StrategyRunner {
  readonly spec: StrategySpec;
  state: RunState = 'running';
  grid: GridState = emptyGrid();
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
  }

  get #now() {
    return (this.#o.now ?? Date.now)();
  }
  #emit(type: string, data: Record<string, unknown> = {}) {
    this.#o.emit(`strategy.${type}`, { id: this.spec.id, leg: this.spec.leg, ...data });
  }

  status() {
    return { id: this.spec.id, type: this.spec.type, leg: this.spec.leg, coin: this.spec.coin, state: this.state, deadman: this.deadman, held: this.grid.held, resting: Object.keys(this.grid.orders).length };
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

    const [open, filled] = await Promise.all([port.openOids(), port.filledOids()]);
    const r = reconcile(this.grid, open, filled);
    this.grid = r.state;
    for (const f of r.filled) this.#emit('fill', { oid: f.oid, level: f.order.level, side: f.order.side, px: f.order.px, sz: f.order.sz });
    for (const f of r.lost) this.#emit('order.lost', { oid: f.oid, level: f.order.level, side: f.order.side });

    // limits.maxDailyLoss: equity against the day's first reading. shortcut: a top-up during the day offsets a loss, so the
    // check is lenient after top-ups; a per-day ledger of deposits would fix it.
    const equity = await port.equity();
    const day = Math.floor(this.#now / DAY_MS);
    if (this.#dayStart?.day !== day) this.#dayStart = { day, equity };
    if (equity < this.#dayStart.equity - spec.limits.maxDailyLoss) {
      return this.pause(`daily loss: equity $${equity.toFixed(2)} is more than $${spec.limits.maxDailyLoss} below the day's start $${this.#dayStart.equity.toFixed(2)}`);
    }

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

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { StartConflict, StrategyManager } from '../src/strategy/manager';
import type { PlaceRequest, TradingPort } from '../src/strategy/port';
import { validateSpec, type SpecContext, type StrategySpec } from '../src/strategy/spec';
import fx from './fixtures/strategy-spec.json';

const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;
const ctx = fx.context as unknown as SpecContext;
const twap = (() => {
  const r = validateSpec(fx.twap, ctx);
  if (!r.ok) throw new Error('fixture');
  return r.spec;
})();

/** The exchange as the manager sees it; `open` can hold orders a previous process left behind. */
function fakePort(open: string[] = []): TradingPort & { open: Set<string>; placed: PlaceRequest[] } {
  const p = {
    open: new Set(open),
    placed: [] as PlaceRequest[],
    info: async () => ({ asset: 3, szDecimals: 5, mid: 74000 }),
    openOids: async () => new Set(p.open),
    filledOids: async () => new Set<string>(),
    position: async () => 0,
    pnl: async () => ({ realized: 0, fees: 0, unrealized: 0, funding: 0, total: 0, fills: 0 }),
    setLeverage: async () => {},
    place: async (o: PlaceRequest) => {
      p.placed.push(o);
      return { oid: '1', fill: { sz: Number(o.sz), px: Number(o.px) } };
    },
    cancel: async (_a: number, oids: string[]) => oids.forEach((o) => p.open.delete(o)),
    flatten: async () => {},
    armDeadman: async () => {},
  };
  return p;
}

const dirs: string[] = [];
function manager(dataDir: string, port: TradingPort, owner = fx.context.owner) {
  const events: string[] = [];
  const m = new StrategyManager({
    legs: { registered: async () => [{ leg: 3, address: '0x5cba8512a2933a08fc3d33874871fe430b6e3d91' }], keys: { get: () => ({ approvedAt: 1 }) } } as never,
    client: { getOwner: async () => owner } as never,
    policy: ctx.orderPolicy,
    emit: (t) => void events.push(t),
    agentId: ctx.agentId,
    intervalMs: 3_600_000, // the test drives nothing by timer
    dataDir,
    makePort: async () => port,
  });
  return { m, events };
}
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hypernear-strat-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  dirs.length = 0;
});

describe('StrategyManager start race and resume after a freeze', () => {
  it('two concurrent starts on one leg: one wins, the other is a conflict', async () => {
    const { m } = manager(newDir(), fakePort());
    const other = { ...twap, id: 'dca-btc-2' } as StrategySpec;
    const r = await Promise.allSettled([m.start(OWNER, twap), m.start(OWNER, other)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(StartConflict);
    expect(m.list(OWNER)).toHaveLength(1);
    m.shutdown();
  });

  it('two concurrent starts of the same id: one wins', async () => {
    const { m } = manager(newDir(), fakePort());
    const r = await Promise.allSettled([m.start(OWNER, twap), m.start(OWNER, twap)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    m.shutdown();
  });

  it('a frozen strategy resumes on the identical spec, with a fresh port (the old agent key is revoked); a still-frozen owner is refused', async () => {
    const ports: number[] = [];
    const events: string[] = [];
    let frozen = false;
    const m = new StrategyManager({
      legs: { registered: async () => [{ leg: 3, address: '0x5cba8512a2933a08fc3d33874871fe430b6e3d91' }], keys: { get: () => ({ approvedAt: 1 }) } } as never,
      client: { getOwner: async () => ({ ...fx.context.owner, frozen }) } as never,
      policy: ctx.orderPolicy, emit: (t) => void events.push(t), agentId: ctx.agentId, intervalMs: 3_600_000,
      makePort: async () => (ports.push(1), fakePort()),
    });
    await m.start(OWNER, twap);
    await m.cancelAll(OWNER); // the freeze hook
    expect(m.list(OWNER)).toMatchObject([{ id: twap.id, state: 'frozen' }]);
    frozen = true;
    expect(await m.validate(OWNER, twap)).toMatchObject({ ok: false, errors: [expect.stringContaining('owner is frozen')] });
    frozen = false;
    const v = await m.validate(OWNER, twap);
    expect(v.ok).toBe(true);
    if (v.ok) expect(await m.start(OWNER, v.spec)).toMatchObject({ state: 'running' });
    expect(ports).toHaveLength(2);
    expect(events).toContain('strategy.resumed');
    m.shutdown();
  });
});

describe('StrategyManager persistence', () => {
  it('saves specs and progress (0600, no keys) and drops stopped strategies', async () => {
    const dir = newDir();
    const { m } = manager(dir, fakePort());
    await m.start(OWNER, twap);
    const file = join(dir, 'strategies.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved[`${OWNER}:${twap.id}`]).toMatchObject({ owner: OWNER, spec: twap, saved: { state: 'running' } });
    expect(readFileSync(file, 'utf8')).not.toMatch(/key/i);
    await m.stop(OWNER, twap.id);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    m.shutdown();
  });

  it('after a restart: reloaded as paused (never auto-resumed), orphaned orders cancelled, progress kept', async () => {
    const dir = newDir();
    const a = manager(dir, fakePort());
    await a.m.start(OWNER, twap);
    await new Promise((r) => setTimeout(r, 50)); // the first tick places slice 1
    await a.m.pause(OWNER, twap.id);
    a.m.shutdown();

    const port = fakePort(['77', '78']); // left resting by the dead process
    const b = manager(dir, port);
    const restored = await b.m.restore();
    expect(restored).toEqual([{ id: twap.id, cancelled: 2 }]);
    expect(port.open.size).toBe(0);
    expect(b.m.list(OWNER)).toMatchObject([{ id: twap.id, state: 'paused', twap: { done: 1 } }]);
    expect(port.placed).toHaveLength(0); // nothing runs by itself
    expect(b.events).toContain('strategy.restored');
    b.m.shutdown();
  });

  it('resume = the identical spec in a new start; a changed spec for the same id is refused', async () => {
    const dir = newDir();
    const a = manager(dir, fakePort());
    await a.m.start(OWNER, twap);
    await a.m.pause(OWNER, twap.id);
    a.m.shutdown();
    const b = manager(dir, fakePort());
    await b.m.restore();

    const changed = { ...twap, params: { ...twap.params, slices: 2 } } as StrategySpec;
    expect(await b.m.validate(OWNER, changed)).toMatchObject({ ok: false, errors: [expect.stringContaining('already exists (paused)')] });
    const same = await b.m.validate(OWNER, twap);
    expect(same.ok).toBe(true);
    if (same.ok) expect(await b.m.start(OWNER, same.spec)).toMatchObject({ state: 'running' });
    b.m.shutdown();
  });

  it('a running strategy cannot be started twice', async () => {
    const { m } = manager(newDir(), fakePort());
    await m.start(OWNER, twap);
    expect(await m.validate(OWNER, twap)).toMatchObject({ ok: false });
    m.shutdown();
  });
});

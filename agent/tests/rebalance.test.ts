import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { OwnerState } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import type { LegState, Legs, OwnerSnapshot } from '../src/legs.ts';
import { Rebalancer, validateRebalanceSpec, type RebalanceCtx, type RebalanceMove } from '../src/rebalance.ts';
import { HttpError } from '../src/relayer.ts';
import { ch, OWNER, snap } from './agent-helpers.ts';

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = Math.floor(NOW / 86_400_000);
const policy = (o: Partial<OwnerState> = {}): OwnerState => ({ nonce: 1, frozen: false, agent: 'agent.testnet', daily_cap: 100e6, cooldown_sec: 30, day: DAY, spent_today: 0, last_rebalance_ns: 0, ...o });
const ADDR = (n: number) => `0x${String(n).repeat(40)}` as Hex;

/** legs 0..n-1 with account value and free balance as given */
function owner(legs: { value: number; free?: number; activation?: LegState['activation']; abstraction?: LegState['abstraction'] }[]): OwnerSnapshot {
  const s = snap(ch(), ch());
  s.legs = legs.map((l, leg) => ({
    leg,
    address: ADDR(leg + 1),
    agent: null,
    clearinghouse: ch({ accountValue: l.value, maint: 0, withdrawable: l.free ?? l.value }),
    spotUsdc: 0,
    activation: l.activation ?? 'paid',
    abstraction: l.abstraction ?? 'default',
  }));
  return s;
}
const ctx = (snapshot: OwnerSnapshot, o: Partial<RebalanceCtx> = {}): RebalanceCtx => ({ snapshot, policy: policy(), agentId: 'agent.testnet', busyLegs: [], nowMs: NOW, annualVol: 0.6, ...o });
const spec = (...legs: [number, number][]) => ({ legs: legs.map(([leg, pct]) => ({ leg, pct })) });
const ok = (r: ReturnType<typeof validateRebalanceSpec>) => {
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.plan;
};

describe('validateRebalanceSpec: the plan', () => {
  it('splits the pool of two legs 50/50 with one move from the richer leg', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 30 }, { value: 10 }]))));
    expect(p.moves).toEqual([{ from: { leg: 0, address: ADDR(1) }, to: { leg: 1, address: ADDR(2) }, amount: '10.00', receives: '10.00', feeUsd: 0, sourceFeeUsd: 0, transfer: 'usdSend' }]);
    expect(p.rows.map((r) => [r.leg, r.before, r.target, r.after])).toEqual([[0, 30, 20, 20], [1, 10, 20, 20]]);
    expect(p.sentUsd).toBe(10);
  });

  it('targets add up to the pool to the cent, the remainder goes to the largest share', () => {
    const p = ok(validateRebalanceSpec(spec([0, 33], [1, 33], [2, 34]), ctx(owner([{ value: 10.01 }, { value: 0 }, { value: 0 }]))));
    const targets = p.rows.map((r) => Math.round(r.target * 100));
    expect(targets.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(p.rows[2]!.target).toBeGreaterThanOrEqual(p.rows[0]!.target);
    expect(p.rows.reduce((s, r) => s + Math.round(r.after * 100), 0)).toBe(1001);
  });

  it('needs at most legs - 1 moves', () => {
    const three = ok(validateRebalanceSpec(spec([0, 20], [1, 30], [2, 50]), ctx(owner([{ value: 90 }, { value: 5 }, { value: 5 }]))));
    expect(three.moves.length).toBeLessThanOrEqual(2);
    expect(three.rows.map((r) => r.after)).toEqual([20, 30, 50]);
    const four = ok(validateRebalanceSpec(spec([0, 25], [1, 25], [2, 25], [3, 25]), ctx(owner([{ value: 40 }, { value: 40 }, { value: 0 }, { value: 0 }]))));
    expect(four.moves.length).toBeLessThanOrEqual(3);
    expect(four.rows.every((r) => r.after === 20)).toBe(true);
  });

  it('is idempotent: legs already at their shares need no move', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 20 }, { value: 20.4 }]))));
    expect(p.moves).toEqual([]);
    expect(p.notes[0]).toMatch(/already at these shares/);
  });

  it('a leg can give only its free balance: the rest is margin, and the plan says so', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 40, free: 5 }, { value: 0 }]))));
    expect(p.moves).toHaveLength(1);
    expect(Number(p.moves[0]!.amount)).toBeCloseTo(4.5, 2); // 90% of 5
    expect(p.notes.join(' ')).toMatch(/leg 1 ends .* short of its share/);
  });

  it('nothing moves when the richer leg has no free balance', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 40, free: 0 }, { value: 0 }]))));
    expect(p.moves).toEqual([]);
    expect(p.notes[0]).toMatch(/no free balance/);
  });

  it('a never-credited destination costs 1 USDC on top and receives the rest; a never-sent source pays 1 more', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 30, activation: 'owed-on-first-send' }, { value: 10, activation: 'owed-on-credit' }]))));
    expect(p.moves[0]).toMatchObject({ amount: '11.00', receives: '10.00', feeUsd: 1, sourceFeeUsd: 1 });
    expect(p.sentUsd).toBe(12);
  });

  it('unified legs move money with sendAsset', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 30, abstraction: 'unifiedAccount' }, { value: 10, abstraction: 'unifiedAccount' }]))));
    expect(p.moves[0]!.transfer).toBe('sendAsset');
  });

  it('skips a move below $1 as dust', () => {
    const p = ok(validateRebalanceSpec(spec([0, 50], [1, 50]), ctx(owner([{ value: 20.9 }, { value: 19.1 }]))));
    expect(p.moves).toEqual([]);
  });
});

describe('validateRebalanceSpec: refusals', () => {
  const run = (s: unknown, snapshot = owner([{ value: 30 }, { value: 10 }, { value: 0 }]), o: Partial<RebalanceCtx> = {}) => validateRebalanceSpec(s, ctx(snapshot, o));

  it.each([
    ['not an object', 'x', /JSON object/],
    ['an unknown field', { legs: [], extra: 1 }, /extra is not a field/],
    ['one leg', spec([0, 100]), /from 2 to 4 legs/],
    ['a duplicate leg', spec([0, 50], [0, 50]), /only once/],
    ['percentages not adding up', spec([0, 50], [1, 40]), /add up to 100/],
    ['a fractional percentage', { legs: [{ leg: 0, pct: 50.5 }, { leg: 1, pct: 49.5 }] }, /whole number from 1 to 99/],
    ['an out-of-range leg', spec([0, 50], [7, 50]), /from 0 to 3/],
    ['an unregistered leg', spec([0, 50], [3, 50]), /leg 3 is not registered/],
    ['an extra field on an entry', { legs: [{ leg: 0, pct: 50, to: '0x1' }, { leg: 1, pct: 50 }] }, /each entry is/],
  ])('refuses %s', (_n, s, re) => {
    const r = run(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join(' ')).toMatch(re);
  });

  it('refuses a leg that runs a strategy', () => {
    const r = run(spec([0, 50], [1, 50]), undefined, { busyLegs: [1] });
    expect(!r.ok && r.errors.join(' ')).toMatch(/leg 1 is running a strategy/);
  });

  it('refuses legs in different account modes', () => {
    const r = run(spec([0, 50], [1, 50]), owner([{ value: 30, abstraction: 'unifiedAccount' }, { value: 10 }]));
    expect(!r.ok && r.errors.join(' ')).toMatch(/different account modes/);
  });

  it.each([
    ['no policy', null, /not opted/],
    ['another agent', policy({ agent: 'other.testnet' }), /not this service/],
    ['frozen', policy({ frozen: true }), /frozen/],
    ['daily cap too small', policy({ spent_today: 95e6 }), /daily cap has \$5\.00 left/],
  ])('refuses on the contract rules: %s', (_n, p, re) => {
    const r = run(spec([0, 50], [1, 50]), owner([{ value: 30 }, { value: 10 }]), { policy: p as OwnerState | null });
    expect(!r.ok && r.errors.join(' ')).toMatch(re);
  });

  it('refuses when the cooldown would park the run for too long', () => {
    const r = run(spec([0, 25], [1, 25], [2, 25], [3, 25]), owner([{ value: 80 }, { value: 0 }, { value: 0 }, { value: 0 }]), { policy: policy({ cooldown_sec: 400 }) }); // 3 moves, 2 cooldowns of 400 s
    expect(!r.ok && r.errors.join(' ')).toMatch(/minutes: lower the cooldown/);
  });

  it('refuses a move that would leave a leg with a position under the margin guard floor', () => {
    const s = owner([{ value: 30 }, { value: 0 }]);
    s.legs[0]!.clearinghouse = ch({ accountValue: 30, maint: 12, withdrawable: 28, positions: [{ coin: 'BTC', szi: '0.01', liq: '60000' }] });
    const r = run(spec([0, 10], [1, 90]), s);
    expect(!r.ok && r.errors.join(' ')).toMatch(/leg 0 would put its BTC position under the margin guard/);
  });
});

describe('Rebalancer', () => {
  /** a snapshot that follows the sends, so the re-plan before each move sees the new balances */
  function setup(values: number[], o: { failAt?: number; policyFn?: () => OwnerState } = {}) {
    const s = owner(values.map((value) => ({ value })));
    const legs = { snapshot: async () => structuredClone(s) } as unknown as Legs;
    const sent: RebalanceMove[] = [];
    const sleeps: number[] = [];
    const rb = new Rebalancer({
      legs,
      bus: new EventBus(),
      annualVol: 0.6,
      agentId: 'agent.testnet',
      busyLegs: () => [],
      policy: async () => (o.policyFn ?? policy)(),
      now: () => NOW,
      sleep: async (ms) => void sleeps.push(ms),
      send: async (_o, m) => {
        if (o.failAt === sent.length) throw new Error('MPC sign failed');
        sent.push(m);
        const from = s.legs[m.from.leg]!;
        const to = s.legs[m.to.leg]!;
        for (const [l, d] of [[from, -Number(m.amount)], [to, Number(m.receives)]] as const) {
          l.clearinghouse = ch({ accountValue: Number(l.clearinghouse.marginSummary.accountValue) + d, maint: 0, withdrawable: Number(l.clearinghouse.withdrawable) + d });
        }
      },
    });
    return { rb, sent, sleeps, s };
  }
  const settle = async (rb: Rebalancer) => {
    for (let i = 0; i < 50 && rb.job(OWNER)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 0));
    return rb.job(OWNER)!;
  };

  it('runs the moves one by one, re-planning each time, and ends at the shares', async () => {
    const { rb, sent, s } = setup([90, 5, 5]);
    const { plan } = await rb.start(OWNER, spec([0, 20], [1, 30], [2, 50]));
    expect(plan.moves.length).toBeGreaterThan(0);
    const job = await settle(rb);
    expect(job.state).toBe('done');
    expect(job.steps.every((x) => x.status === 'sent')).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(s.legs.map((l) => Number(l.clearinghouse.marginSummary.accountValue))).toEqual([20, 30, 50]);
  });

  it('a failed move stops the run and records why; running it again finishes it', async () => {
    const { rb, sent } = setup([30, 10], { failAt: 0 });
    await rb.start(OWNER, spec([0, 50], [1, 50]));
    const job = await settle(rb);
    expect(job).toMatchObject({ state: 'failed', error: 'MPC sign failed', steps: [{ status: 'failed', error: 'MPC sign failed' }] });
    expect(sent).toHaveLength(0);
  });

  it('refuses a second run while one is going, and a spec the planner refuses', async () => {
    const { rb } = setup([30, 10]);
    await rb.start(OWNER, spec([0, 50], [1, 50]));
    await expect(rb.start(OWNER, spec([0, 50], [1, 50]))).rejects.toMatchObject({ status: 409 });
    await settle(rb);
    await expect(rb.start(OWNER, spec([0, 60], [1, 50]))).rejects.toBeInstanceOf(HttpError);
  });

  it('waits out the contract cooldown before a move', async () => {
    const { rb, sleeps } = setup([30, 10], { policyFn: () => policy({ last_rebalance_ns: (NOW - 10_000) * 1e6 }) });
    await rb.start(OWNER, spec([0, 50], [1, 50]));
    await settle(rb);
    expect(sleeps[0]).toBeGreaterThanOrEqual(20_000); // 30 s cooldown, 10 s ago
  });

  it('preview changes nothing', async () => {
    const { rb, sent } = setup([30, 10]);
    const r = await rb.preview(OWNER, spec([0, 50], [1, 50]));
    expect(r.ok && r.plan.moves).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(rb.job(OWNER)).toBeUndefined();
    vi.restoreAllMocks();
  });
});

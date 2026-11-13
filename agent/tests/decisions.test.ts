import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZERO_SPEC_HASH, type Command } from '@hypernear/client';
import { decisionOptions, type Proposal } from '../src/decide.ts';
import { Decider, DecisionModes, type DeciderDeps } from '../src/decisions.ts';
import { EventBus } from '../src/events.ts';
import { decisionInput } from '../src/facts.ts';
import { planDecision } from '../src/hedge.ts';
import type { Legs, OwnerSnapshot } from '../src/legs.ts';
import { HttpError } from '../src/relayer.ts';
import { ch, OWNER, POLICY, snap } from './agent-helpers.ts';

/** leg0 long 0.0008 BTC, leg1 short 0.0007 BTC at mid 100k; leg1 in profit by default. */
function hedged(o: { u0?: string; u1?: string; maint0?: number; reserve?: number } = {}): OwnerSnapshot {
  const s = snap(
    ch({ accountValue: 50, maint: o.maint0 ?? 5, positions: [{ coin: 'BTC', szi: '0.0008' }] }),
    ch({ accountValue: 50, maint: 20, positions: [{ coin: 'BTC', szi: '-0.0007' }] })
  );
  s.legs[0]!.clearinghouse.assetPositions[0]!.position.unrealizedPnl = o.u0 ?? '-1';
  s.legs[1]!.clearinghouse.assetPositions[0]!.position.unrealizedPnl = o.u1 ?? '1.5';
  if (o.reserve !== undefined) s.legs.push({ leg: 2, address: '0x0000000000000000000000000000000000000002', agent: null, clearinghouse: ch({ withdrawable: o.reserve }), spotUsdc: 0, activation: 'paid' });
  return s;
}

describe('decisionInput (facts for proposeAction)', () => {
  it('buckets use the exact strings Jev was validated on', () => {
    const allowed = new Map<string, Set<string>>();
    const states = JSON.parse(readFileSync(new URL('../../validation/fixtures/decide/states.json', import.meta.url), 'utf8')) as { facts: Record<string, string> }[];
    for (const st of states) for (const [k, v] of Object.entries(st.facts)) (allowed.get(k) ?? allowed.set(k, new Set()).get(k)!).add(v);
    for (const s of [hedged(), hedged({ maint0: 40, reserve: 50, u0: '5', u1: '-1' }), hedged({ maint0: 20, reserve: 1 })]) {
      const i = decisionInput(s, ['BTC'], { annualVol: 0.6 })!;
      for (const [k, v] of Object.entries(i.state.facts)) expect([...allowed.get(k)!]).toContain(v);
    }
  });

  it('facts and risk context from the legs', () => {
    const i = decisionInput(hedged({ reserve: 50 }), ['BTC'], { annualVol: 0.6, openedAt: 1, now: 1 + 2 * 86_400_000 })!;
    expect(i.coin).toBe('BTC');
    expect(i.ctx.longNotional).toBeCloseTo(80, 9);
    expect(i.ctx.shortNotional).toBeCloseTo(70, 9);
    expect(i.ctx.profitLeg).toBe('short');
    expect(i.state.facts).toMatchObject({
      hedgeCoverage: 'full: legs are about equal',
      longLegLiquidationDistance: 'far: over 6x maintenance margin', // 50 / 5
      shortLegLiquidationDistance: 'close: 1.5x to 3x maintenance margin', // 50 / 20
      combinedPnl: 'small profit',
      hedgeAge: 'days',
      reserveMargin: 'ample',
    });
  });

  it('no open hedge (flat, or leg0 short) -> null', () => {
    expect(decisionInput(snap(ch(), ch()), ['BTC'], { annualVol: 0.6 })).toBeNull();
    const flipped = snap(ch({ positions: [{ coin: 'BTC', szi: '-0.001' }] }), ch({ positions: [{ coin: 'BTC', szi: '0.001' }] }));
    expect(decisionInput(flipped, ['BTC'], { annualVol: 0.6 })).toBeNull();
  });
});

describe('planDecision (order policy for accepted decisions)', () => {
  const s = hedged();
  it('hold: nothing; close_both: both legs reduce-only', () => {
    expect(planDecision(s, 'hold', 'BTC', POLICY)).toEqual({ ok: true, orders: [] });
    const c = planDecision(s, 'close_both', 'BTC', POLICY);
    expect(c.ok && c.orders.map((o) => [o.leg, o.isBuy, o.reduceOnly])).toEqual([[0, false, true], [1, true, true]]);
  });
  it('reduce/add one step (25% of the larger leg) on leg1; take_profit closes the leg in profit', () => {
    const r = planDecision(s, 'reduce_hedge', 'BTC', POLICY);
    expect(r.ok && r.orders[0]).toMatchObject({ leg: 1, isBuy: true, size: '0.00020', reduceOnly: true });
    const a = planDecision(s, 'add_hedge', 'BTC', POLICY);
    expect(a.ok && a.orders[0]).toMatchObject({ leg: 1, isBuy: false, size: '0.00020', reduceOnly: false });
    const t = planDecision(s, 'take_profit', 'BTC', POLICY);
    expect(t.ok && t.orders[0]).toMatchObject({ leg: 1, isBuy: true, size: '0.00070', reduceOnly: true });
  });
  it('refuses outside the policy', () => {
    expect(planDecision(s, 'add_hedge', 'DOGE', POLICY)).toMatchObject({ ok: false, reason: /not allowed/ });
    expect(planDecision(s, 'add_hedge', 'BTC', { ...POLICY, maxNotionalUsd: 10 })).toMatchObject({ ok: false, reason: /above policy max/ });
    expect(planDecision(hedged({ u0: '-1', u1: '-1' }), 'take_profit', 'BTC', POLICY)).toMatchObject({ ok: false, reason: /neither leg/ });
    expect(planDecision(snap(ch(), ch()), 'reduce_hedge', 'BTC', POLICY)).toMatchObject({ ok: false, reason: /no open BTC hedge/ });
  });
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  action: 'reduce_hedge',
  source: 'jev',
  factors: {} as Proposal['factors'],
  rationale: 'r',
  latencyMs: 5,
  model: 'jev-1.14.0',
  flagged: false,
  trace: { jevMs: 1, calls: [], tableAction: 'reduce_hedge' },
  ...over,
});

function decider(o: { proposal?: Proposal; optedIn?: boolean; mode?: 'off' | 'propose' | 'auto'; now?: () => number } = {}) {
  const bus = new EventBus();
  const executed: unknown[] = [];
  const modes = new DecisionModes(mkdtempSync(join(tmpdir(), 'hypernear-dec-')));
  if (o.mode) modes.set(OWNER, o.mode);
  const deps: DeciderDeps = {
    legs: { snapshot: async () => hedged() } as unknown as Legs,
    bus,
    policy: POLICY,
    modes,
    propose: async () => o.proposal ?? proposal(),
    execute: async (owner, action, coin, orders) => (executed.push({ owner, action, coin, orders }), { filled: orders.length }),
    checkOwner: async () => {
      if (o.optedIn === false) throw new HttpError(403, 'owner has not opted this agent in (setPolicy)');
    },
    owners: () => [OWNER],
    annualVol: 0.6,
    now: o.now,
  };
  return { dec: new Decider(deps), bus, executed };
}
const cmd = (over: Partial<Command> = {}): Command => ({ owner: OWNER, action: 'reduce_hedge', coin: 'BTC', ratio: '0', expiry: 0, nonce: 1, specHash: ZERO_SPEC_HASH, ...over });

describe('decisionOptions (risk ranking for the owner)', () => {
  const o = (ctx: Parameters<typeof decisionOptions>[0]) => Object.fromEntries(decisionOptions(ctx).map((x) => [x.action, x.risk]));
  it('balanced hedge: closing is safest, "hold" is no change, growing or shrinking the short is riskier, take profit riskiest', () => {
    expect(o({ longNotional: 100, shortNotional: 100, profitLeg: 'long' })).toEqual({ close_both: 'safest', hold: 'none', add_hedge: 'riskier', reduce_hedge: 'riskier', take_profit: 'riskiest' });
  });
  it('long-heavy hedge: growing the short is safer than holding', () => {
    const r = o({ longNotional: 100, shortNotional: 50, profitLeg: 'short' });
    expect(r).toMatchObject({ close_both: 'safest', hold: 'none', add_hedge: 'safer' });
    expect(decisionOptions({ longNotional: 100, shortNotional: 50, profitLeg: 'short' })[0]!.action).toBe('close_both');
  });
});

describe('Decider', () => {
  it('propose mode: emits a flat decision.proposed and executes nothing', async () => {
    const { dec, bus, executed } = decider();
    const p = await dec.prepare(OWNER);
    expect('input' in p && p.input.coin).toBe('BTC');
    await dec.run((p as { input: any }).input);
    const e = bus.since().find((x) => x.type === 'decision.proposed')!.data;
    expect(Object.keys(e).sort()).toEqual(['action', 'at', 'coin', 'expiresAt', 'factors', 'flagged', 'id', 'latencyMs', 'model', 'options', 'owner', 'rationale', 'source']);
    expect(e).toMatchObject({ id: 'p1', owner: OWNER, coin: 'BTC', action: 'reduce_hedge' });
    expect(executed).toHaveLength(0);
  });

  it('the owner may sign any listed option instead of the suggestion; it runs through the same policy and the event says what was proposed', async () => {
    const { dec, bus, executed } = decider();
    await dec.run((await dec.prepare(OWNER) as { input: any }).input);
    const e = bus.since().find((x) => x.type === 'decision.proposed')!.data as { options: { action: string; risk: string }[]; expiresAt: number; at: number };
    expect(e.options.map((o) => o.action).sort()).toEqual(['add_hedge', 'close_both', 'hold', 'reduce_hedge', 'take_profit']);
    expect(e.expiresAt).toBeGreaterThan(e.at);
    expect(dec.actionFor('p1')).toBe('reduce_hedge');
    expect(dec.actionFor('p1', 'close_both')).toBe('close_both');
    expect(() => dec.actionFor('p1', 'withdraw')).toThrow(/option must be one of/);
    const out = await dec.accept('p1', cmd({ action: 'close_both' }));
    expect(out).toMatchObject({ action: 'close_both', proposed: 'reduce_hedge' });
    expect(executed[0]).toMatchObject({ action: 'close_both' });
    expect(bus.since().find((x) => x.type === 'decision.accepted')!.data).toMatchObject({ action: 'close_both', proposed: 'reduce_hedge' });
  });

  it('prepare skips: mode off, not opted in, no hedge', async () => {
    expect(await decider({ mode: 'off' }).dec.prepare(OWNER)).toEqual({ skipped: 'decision mode is off' });
    expect(await decider({ optedIn: false }).dec.prepare(OWNER)).toMatchObject({ skipped: /opted/ });
    const { dec } = decider();
    dec.d.legs.snapshot = async () => snap(ch(), ch());
    expect(await dec.prepare(OWNER)).toMatchObject({ skipped: /no open hedge/ });
  });

  it('accept: must match the proposal; executes once within the policy; decision.accepted', async () => {
    const { dec, bus, executed } = decider();
    await dec.run((await dec.prepare(OWNER) as { input: any }).input);
    await expect(dec.accept('p1', cmd({ action: 'pause_strategy' as never }))).rejects.toMatchObject({ status: 400 });
    await expect(dec.accept('p1', cmd({ coin: 'ETH' }))).rejects.toMatchObject({ status: 400 });
    await expect(dec.accept('p1', cmd({ owner: '0x0000000000000000000000000000000000000001' }))).rejects.toMatchObject({ status: 403 });
    await expect(dec.accept('nope', cmd())).rejects.toMatchObject({ status: 404 });
    const out = await dec.accept('p1', cmd());
    expect(out).toMatchObject({ id: 'p1', owner: OWNER, action: 'reduce_hedge', auto: false, result: { filled: 1 } });
    expect(executed).toHaveLength(1);
    expect(bus.since().find((x) => x.type === 'decision.accepted')!.data).toMatchObject({ id: 'p1', owner: OWNER });
    await expect(dec.accept('p1', cmd())).rejects.toMatchObject({ status: 409 });
  });

  it('accept refused by the policy or after expiry -> decision.rejected / 409', async () => {
    let t = 0;
    const { dec, bus } = decider({ proposal: proposal({ action: 'take_profit' }), now: () => t });
    dec.d.legs.snapshot = async () => hedged({ u0: '-1', u1: '-1' });
    await dec.run((await dec.prepare(OWNER) as { input: any }).input);
    await expect(dec.accept('p1', cmd({ action: 'take_profit' }))).rejects.toThrow(/neither leg/);
    expect(bus.since().find((x) => x.type === 'decision.rejected')!.data).toMatchObject({ id: 'p1', owner: OWNER, reason: /neither leg/ });

    const late = decider({ now: () => t });
    await late.dec.run((await late.dec.prepare(OWNER) as { input: any }).input);
    t = 5 * 60_000 + 1;
    await expect(late.dec.accept('p1', cmd())).rejects.toMatchObject({ status: 409, message: 'proposal is expired' });
  });

  it('reject: the owner dismisses an open proposal -> decision.rejected {reason: owner}; then it cannot be accepted', async () => {
    const { dec, bus, executed } = decider();
    await dec.run((await dec.prepare(OWNER) as { input: any }).input);
    expect(() => dec.reject('p1', cmd({ action: 'reduce_hedge' }))).toThrow('command must be reject on BTC');
    expect(dec.reject('p1', cmd({ action: 'reject' }))).toMatchObject({ id: 'p1', owner: OWNER, reason: 'owner', status: 'rejected' });
    expect(bus.since().find((x) => x.type === 'decision.rejected')!.data).toMatchObject({ id: 'p1', owner: OWNER, reason: 'owner' });
    await expect(dec.accept('p1', cmd())).rejects.toMatchObject({ status: 409 });
    expect(executed).toHaveLength(0);
  });

  it('auto mode: executes unflagged proposals without a signature; flagged and hold wait for the owner', async () => {
    const a = decider({ mode: 'auto' });
    await a.dec.run((await a.dec.prepare(OWNER) as { input: any }).input);
    expect(a.executed).toHaveLength(1);
    expect(a.bus.since().find((x) => x.type === 'decision.accepted')!.data).toMatchObject({ auto: true });
    for (const p of [proposal({ flagged: true }), proposal({ action: 'hold' })]) {
      const b = decider({ mode: 'auto', proposal: p });
      await b.dec.run((await b.dec.prepare(OWNER) as { input: any }).input);
      expect(b.executed).toHaveLength(0);
      expect(b.dec.latest(OWNER)!.status).toBe('open');
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { OwnerState } from '@hypernear/client';
import { activationStatus } from '../src/activation.ts';
import { evaluateGuard, DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { DEFAULT_LOOP_CONFIG, planRebalance } from '../src/guardLoop.ts';
import { guardInputs, type OwnerSnapshot } from '../src/legs.ts';
import { StrategyRunner } from '../src/strategy/runner.ts';
import type { TradingPort } from '../src/strategy/port.ts';
import { validateSpec, type SpecContext } from '../src/strategy/spec.ts';
import { ch, snap } from './agent-helpers.ts';
import ledgers from './fixtures/activation-ledgers.json';
import fx from './fixtures/strategy-spec.json';

// Two real mainnet ledgers (delta rows only): each address paid "fee":"1.0" feeToken USDC on its FIRST outgoing send; the receiver got the full amount.
const A = '0x91f36a4e5b358b2b90678c62adcab0ddf2cb8ce6';
const B = '0x8a696af9457e00977486dab24e16029b89b5248b';
const rows = (who: string) => (ledgers.ledgers as Record<string, { rows: { time: number; hash: string; delta: Record<string, unknown> }[] }>)[who]!.rows;
const FIRST_SEND: Record<string, number> = { [A]: 1793735531063, [B]: 1794132476882 };
const before = (who: string) => rows(who).filter((r) => r.time < FIRST_SEND[who]!);

function hl(role: string, ledger: unknown[] = []) {
  return {
    userRole: vi.fn(async () => ({ role }) as never),
    userNonFundingLedgerUpdates: vi.fn(async () => ledger as never),
  };
}

describe('activationStatus', () => {
  it('a never-seen address (role missing) is owed on the next credit', async () => {
    expect(await activationStatus(hl('missing'), A)).toBe('owed-on-credit');
  });

  it('mainnet ledgers: a funded account that never sent is owed on its first send; after it, paid', async () => {
    for (const who of [A, B]) {
      expect(await activationStatus(hl('user', before(who)), who)).toBe('owed-on-first-send');
      expect(await activationStatus(hl('user', rows(who)), who)).toBe('paid');
    }
  });

  it('B had a self-send to another dex and a credit carrying fee 1.0 (the sender paid it): neither counts', async () => {
    const r = before(B);
    expect(r.some((x) => x.delta.destination === B && x.delta.user === B)).toBe(true);
    expect(r.some((x) => x.delta.destination === B && x.delta.fee === '1.0')).toBe(true);
    expect(await activationStatus(hl('user', r), B)).toBe('owed-on-first-send');
  });

  it('caches paid forever, never missing', async () => {
    const paid = hl('user', rows(A));
    expect(await activationStatus(paid, A)).toBe('paid');
    expect(await activationStatus(paid, A.toUpperCase().replace('0X', '0x'))).toBe('paid');
    expect(paid.userRole).toHaveBeenCalledTimes(1);
    const missing = hl('missing');
    await activationStatus(missing, B);
    await activationStatus(missing, B);
    expect(missing.userRole).toHaveBeenCalledTimes(2);
  });

  it('an RPC error assumes a new account', async () => {
    const down = { userRole: async () => Promise.reject(new Error('timeout')), userNonFundingLedgerUpdates: async () => [] as never };
    expect(await activationStatus(down, A)).toBe('owed-on-credit');
  });
});

const NOW = Date.UTC(2026, 10, 7, 12);
const policy = (o: Partial<OwnerState> = {}): OwnerState => ({ nonce: 1, frozen: false, agent: 'agent.testnet', daily_cap: 50e6, cooldown_sec: 30, day: Math.floor(NOW / 86_400_000), spent_today: 0, last_rebalance_ns: 0, ...o });
const healthy = () => ch({ accountValue: 14.8, maint: 0.38, withdrawable: 4.7, positions: [{ coin: 'BTC', szi: '0.0004', liq: '50000' }] });
const stressed = () => ch({ accountValue: 0.36, maint: 0.19, withdrawable: 0, positions: [{ coin: 'BTC', szi: '-0.0002', lev: 40, liq: '101200' }] });
type Act = OwnerSnapshot['legs'][number]['activation'];
const run = (s: OwnerSnapshot, p = policy(), cfg = DEFAULT_LOOP_CONFIG, budget?: number | (() => number)) =>
  planRebalance(s, evaluateGuard(guardInputs(s, 0.6), DEFAULT_GUARD_CONFIG), p, 'agent.testnet', NOW, cfg, (leg) => (leg === 1 && budget !== undefined ? (typeof budget === 'function' ? budget() : budget) : undefined)); // only the stressed leg 1 has a strategy
const withAct = (src: Act, dst: Act) => {
  const s = snap(healthy(), stressed());
  s.legs[0]!.activation = src;
  s.legs[1]!.activation = dst;
  return s;
};

// a leg with a strategy budget is topped up from the reserve leg 2 only
const withReserve = (s: OwnerSnapshot) => {
  s.legs.push({ leg: 2, address: '0x1111111111111111111111111111111111111111', agent: null, clearinghouse: ch({ accountValue: 30, maint: 0, withdrawable: 30 }), spotUsdc: 0, activation: 'paid' });
  return s;
};

describe('guard rebalance with HL activation', () => {
  it('a missing target is sent 1 more, so it receives what the guard computed', () => {
    expect(run(withAct('paid', 'paid'))).toMatchObject({ amount: '1.00', activationFeeUsd: 0 });
    expect(run(withAct('paid', 'owed-on-credit'))).toMatchObject({ kind: 'rebalance', amount: '2.00', activationFeeUsd: 1 });
  });

  it('refuses, rather than under-delivering, when amount + 1 exceeds the daily cap left', () => {
    expect(run(withAct('paid', 'owed-on-credit'), policy({ spent_today: 49e6 }))).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/1 USDC HL activation fee.*daily cap/) });
    expect(run(withAct('paid', 'paid'), policy({ spent_today: 49e6 }))).toMatchObject({ kind: 'rebalance', amount: '1.00' });
  });

  it('a source that never sent pays 1 on top: it keeps room for it within its withdrawable', () => {
    const big = { ...DEFAULT_LOOP_CONFIG, targetMultiple: 100 };
    expect(run(withAct('paid', 'paid'), policy(), big)).toMatchObject({ amount: '4.23', sourceFeeUsd: 0 });
    expect(run(withAct('owed-on-first-send', 'paid'), policy(), big)).toMatchObject({ amount: '3.23', sourceFeeUsd: 1 });
  });

  it('counts the activation fee against the strategy top-up budget', () => {
    const big = { ...DEFAULT_LOOP_CONFIG, targetMultiple: 100 };
    const s = withReserve(withAct('paid', 'owed-on-credit'));
    expect(run(s, policy(), big, 5)).toMatchObject({ amount: '5.00', activationFeeUsd: 1 }); // 4 reach the leg, 5 leave the reserve
    expect(run(s, policy(), big, 1.5)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('budget used') });
  });
});

describe('strategy leg top-ups', () => {
  const ctx = fx.context as unknown as SpecContext;
  const v = validateSpec(fx.base, ctx);
  if (!v.ok) throw new Error('fixture spec invalid');
  const port = { pnl: async () => ({ realized: 0, fees: 0, unrealized: 0, funding: 0, total: 0, fills: 0 }) } as unknown as TradingPort;

  it('the first top-up of a fresh leg loses 1 USDC (budget and PnL), the second does not', async () => {
    const runner = new StrategyRunner({ spec: v.spec, port, policy: ctx.orderPolicy, emit: () => {}, isFrozen: async () => false });
    const cap = v.spec.limits.topUpCapPerDay;
    const s = withReserve(withAct('paid', 'owed-on-credit'));
    const next = () => run(s, policy({ cooldown_sec: 0 }), DEFAULT_LOOP_CONFIG, () => runner.topUpLeft());
    const first = next();
    expect(first).toMatchObject({ kind: 'rebalance', amount: '2.00', activationFeeUsd: 1 });
    runner.addTopUp(2, 1);
    expect(runner.topUpLeft()).toBe(cap - 2);
    await runner.refreshPnl();
    expect(runner.lastPnl).toMatchObject({ activation: 1, total: -1 });

    s.legs[1]!.activation = 'paid'; // the first credit made it seen
    expect(next()).toMatchObject({ kind: 'rebalance', amount: '1.00', activationFeeUsd: 0 });
    runner.addTopUp(1, 0);
    expect(runner.topUpLeft()).toBe(cap - 3);
    await runner.refreshPnl();
    expect(runner.lastPnl).toMatchObject({ activation: 1, total: -1 });
    expect(runner.snapshot().activationUsd).toBe(1);
  });
});

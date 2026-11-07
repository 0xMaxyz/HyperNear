import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_IDS,
  FACTOR_KEYS,
  actionFromFactors,
  actionRisk,
  decide,
  decideByFactors,
  gateFactors,
  lessRisky,
  type Action,
  type DecideContext,
  type DecideDeps,
  type FactorBools,
  type FactorDeps,
  type FactorProbs,
  type JevAnswer,
} from '../src/decide';

const FACTS = { hedgeCoverage: 'full', combinedPnl: 'small profit' };

function jevAnswer(choice: Action, prob: number, confidence = prob): JevAnswer {
  const rest = (1 - prob) / (ACTION_IDS.length - 1);
  return { choice, confidence, probabilities: Object.fromEntries(ACTION_IDS.map((a) => [a, a === choice ? prob : rest])) };
}

const deps = (over: Partial<DecideDeps>): DecideDeps => ({
  jev: async () => jevAnswer('hold', 0.95),
  escalate: async () => ({ action: 'hold', rationale: 'r' }),
  shuffle: (xs) => [...xs].reverse(),
  ...over,
});

describe('decide (choice layout)', () => {
  it('accepts a confident Jev answer and never calls Claude', async () => {
    const escalate = vi.fn();
    const d = await decide(FACTS, deps({ jev: async () => jevAnswer('close_both', 0.95), escalate }));
    expect(d).toMatchObject({ action: 'close_both', source: 'jev', flagged: false });
    expect(escalate).not.toHaveBeenCalled();
  });

  it('passes the shuffled option order to Jev and records it', async () => {
    const jev = vi.fn(async () => jevAnswer('hold', 0.95));
    const d = await decide(FACTS, deps({ jev }));
    expect(jev).toHaveBeenCalledWith(FACTS, [...ACTION_IDS].reverse());
    expect(d.audit.order).toEqual([...ACTION_IDS].reverse());
  });

  it('escalates when the probability is below 0.90 and acts when Claude agrees', async () => {
    const d = await decide(FACTS, deps({ jev: async () => jevAnswer('reduce_hedge', 0.85), escalate: async () => ({ action: 'reduce_hedge', rationale: 'ok' }) }));
    expect(d).toMatchObject({ action: 'reduce_hedge', source: 'claude_agrees', flagged: false });
  });

  it('escalates when probability is high but confidence is low', async () => {
    const escalate = vi.fn(async () => ({ action: 'hold' as Action, rationale: 'ok' }));
    const d = await decide(FACTS, deps({ jev: async () => jevAnswer('hold', 0.95, 0.6), escalate }));
    expect(escalate).toHaveBeenCalledOnce();
    expect(d.source).toBe('claude_agrees');
  });

  // no state given: static order for a long-heavy pair: close_both < add_hedge < hold < reduce_hedge < take_profit
  const disagreements: Array<[Action, Action, Action]> = [
    ['add_hedge', 'hold', 'add_hedge'],
    ['hold', 'close_both', 'close_both'],
    ['reduce_hedge', 'take_profit', 'reduce_hedge'],
    ['close_both', 'add_hedge', 'close_both'],
  ];
  for (const [jevPick, claudePick, expected] of disagreements) {
    it(`disagreement jev=${jevPick} claude=${claudePick} takes ${expected} and flags it`, async () => {
      const d = await decide(FACTS, deps({ jev: async () => jevAnswer(jevPick, 0.6), escalate: async () => ({ action: claudePick, rationale: 'x' }) }));
      expect(d).toMatchObject({ action: expected, source: 'less_risky_of_two', flagged: true });
    });
  }

  it('disagreement is resolved from the leg sizes when the context is given', async () => {
    // short-heavy pair: growing the short leg is the riskier move, shrinking it is safer than holding
    const ctx: DecideContext = { longNotional: 1000, shortNotional: 2000, profitLeg: 'long' };
    const d = await decide(
      FACTS,
      deps({ jev: async () => jevAnswer('add_hedge', 0.6), escalate: async () => ({ action: 'reduce_hedge', rationale: 'x' }) }),
      undefined,
      ctx,
    );
    expect(d).toMatchObject({ action: 'reduce_hedge', source: 'less_risky_of_two' });
  });

  it('Jev down: Claude decides alone, flagged, and gets a null Jev answer', async () => {
    const escalate = vi.fn(async () => ({ action: 'close_both' as Action, rationale: 'x' }));
    const d = await decide(FACTS, deps({ jev: async () => Promise.reject(new Error('timeout')), escalate }));
    expect(escalate).toHaveBeenCalledWith(FACTS, null, expect.any(Array));
    expect(d).toMatchObject({ action: 'close_both', source: 'claude_only', flagged: true });
    expect(d.audit.jevError).toBe('timeout');
  });

  it('both down: hold, flagged', async () => {
    const d = await decide(FACTS, deps({ jev: async () => Promise.reject(new Error('a')), escalate: async () => Promise.reject(new Error('b')) }));
    expect(d).toMatchObject({ action: 'hold', source: 'fallback_hold', flagged: true });
    expect([d.audit.jevError, d.audit.escalationError]).toEqual(['a', 'b']);
  });

  it('records latencies from the injected clock', async () => {
    let t = 0;
    const d = await decide(FACTS, deps({ now: () => (t += 100), jev: async () => jevAnswer('hold', 0.5), escalate: async () => ({ action: 'hold', rationale: 'x' }) }));
    expect(d.audit.jevMs).toBe(100);
    expect(d.audit.escalationMs).toBe(100);
  });
});

describe('risk is |net directional notional| left after the action', () => {
  const rank = (ctx: DecideContext) =>
    [...ACTION_IDS].sort((a, b) => (lessRisky(a, b, ctx) === a ? -1 : 1));

  it('long-heavy pair, short leg in profit: close_both < add_hedge < hold < reduce_hedge < take_profit', () => {
    const ctx: DecideContext = { longNotional: 2000, shortNotional: 1000, profitLeg: 'short' };
    expect(rank(ctx)).toEqual(['close_both', 'add_hedge', 'hold', 'reduce_hedge', 'take_profit']);
    expect(actionRisk('add_hedge', ctx).exposure).toBe(500); // 2000 - (1000 + 0.25 * 2000)
    expect(actionRisk('take_profit', ctx).exposure).toBe(2000); // short closed, long stays
  });

  it('short-heavy pair flips the order: shrinking the short leg is safer than growing it', () => {
    const ctx: DecideContext = { longNotional: 1000, shortNotional: 2000, profitLeg: 'long' };
    expect(rank(ctx)).toEqual(['close_both', 'reduce_hedge', 'hold', 'add_hedge', 'take_profit']);
  });

  it('equal exposure: the action with fewer orders wins (hold beats close_both on a balanced pair)', () => {
    const ctx: DecideContext = { longNotional: 1000, shortNotional: 1000, profitLeg: null };
    expect(actionRisk('hold', ctx).exposure).toBe(0);
    expect(lessRisky('close_both', 'hold', ctx)).toBe('hold');
  });

  it('take_profit with an unknown profit leg assumes the worse case', () => {
    const ctx: DecideContext = { longNotional: 3000, shortNotional: 1000, profitLeg: null };
    expect(actionRisk('take_profit', ctx).exposure).toBe(3000);
  });

  it('reduce_hedge never goes below a flat short leg', () => {
    const ctx: DecideContext = { longNotional: 1000, shortNotional: 100, profitLeg: 'long', stepFraction: 1 };
    expect(actionRisk('reduce_hedge', ctx).exposure).toBe(1000);
  });
});

describe('decideByFactors (yes/no layout)', () => {
  const probs = (over: Partial<FactorProbs> = {}): FactorProbs => ({
    hedgeNeeded: 0.97,
    fundingMaterial: 0.02,
    nearLiquidation: 0.01,
    inProfit: 0.03,
    volatile: 0.04,
    ...over,
  });
  const fdeps = (over: Partial<FactorDeps> = {}): FactorDeps => ({
    ask: async () => probs(),
    escalate: async () => ({ action: 'hold', rationale: 'r' }),
    shuffle: (xs) => [...xs].reverse(),
    ...over,
  });

  it('gate: >= 0.90 yes, <= 0.10 no, between is undecided', () => {
    const g = gateFactors(probs({ hedgeNeeded: 0.9, fundingMaterial: 0.1, inProfit: 0.5 }));
    expect([g.hedgeNeeded, g.fundingMaterial, g.inProfit]).toEqual([true, false, null]);
  });

  it('all factors decisive: Jev decides alone through the table, Claude is not called', async () => {
    const escalate = vi.fn();
    const d = await decideByFactors(FACTS, fdeps({ escalate }));
    expect(d).toMatchObject({ action: 'hold', source: 'jev_factors', flagged: false, undecided: [] });
    expect(escalate).not.toHaveBeenCalled();
  });

  it('asks the questions in the shuffled order', async () => {
    const ask = vi.fn(async () => probs());
    await decideByFactors(FACTS, fdeps({ ask }));
    expect(ask).toHaveBeenCalledWith(FACTS, [...FACTOR_KEYS].reverse());
  });

  it('undecided factors are escalated with Jev numbers and the list of undecided keys', async () => {
    const escalate = vi.fn(async () => ({ action: 'reduce_hedge' as Action, rationale: 'x' }));
    const p = probs({ inProfit: 0.55, volatile: 0.3 });
    const d = await decideByFactors(FACTS, fdeps({ ask: async () => p, escalate }));
    expect(escalate).toHaveBeenCalledWith(FACTS, p, ['inProfit', 'volatile']);
    expect(d).toMatchObject({ action: 'reduce_hedge', source: 'claude_for_undecided', flagged: false });
  });

  it('Jev down: Claude alone, all factors undecided, flagged', async () => {
    const escalate = vi.fn(async () => ({ action: 'close_both' as Action, rationale: 'x' }));
    const d = await decideByFactors(FACTS, fdeps({ ask: async () => Promise.reject(new Error('t')), escalate }));
    expect(escalate).toHaveBeenCalledWith(FACTS, null, [...FACTOR_KEYS]);
    expect(d).toMatchObject({ action: 'close_both', source: 'claude_only', flagged: true, jevError: 't' });
  });

  it('both down: hold, flagged', async () => {
    const d = await decideByFactors(FACTS, fdeps({ ask: async () => Promise.reject(new Error('a')), escalate: async () => Promise.reject(new Error('b')) }));
    expect(d).toMatchObject({ action: 'hold', source: 'fallback_hold', flagged: true, escalationError: 'b' });
  });

  const table: Array<[string, Partial<FactorBools>, Action]> = [
    ['near liquidation and volatile', { nearLiquidation: true, volatile: true }, 'close_both'],
    ['near liquidation, calm', { nearLiquidation: true }, 'reduce_hedge'],
    ['hedge no longer needed', { hedgeNeeded: false }, 'close_both'],
    ['in profit, calm', { inProfit: true }, 'take_profit'],
    ['funding material, not in profit', { fundingMaterial: true }, 'reduce_hedge'],
    ['volatile, not in profit', { volatile: true }, 'add_hedge'],
    ['nothing notable', {}, 'hold'],
  ];
  for (const [name, over, expected] of table) {
    it(`table: ${name} -> ${expected}`, () => {
      const base: FactorBools = { hedgeNeeded: true, fundingMaterial: false, nearLiquidation: false, inProfit: false, volatile: false };
      expect(actionFromFactors({ ...base, ...over })).toBe(expected);
    });
  }
});

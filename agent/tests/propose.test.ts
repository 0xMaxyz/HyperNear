import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_EVENTS,
  FACTOR_KEYS,
  JEV_MODEL,
  OPUS_MODEL,
  SONNET_MODEL,
  compactFacts,
  proposeAction,
  type Action,
  type DecideContext,
  type FactorProbs,
  type ProposeClients,
} from '../src/decide';

const STATE = { facts: { hedgeCoverage: 'full: legs are about equal', trend: 'ranging' } };
const SMALL: DecideContext = { longNotional: 600, shortNotional: 300, profitLeg: 'short' };
const BIG: DecideContext = { longNotional: 5000, shortNotional: 2500, profitLeg: 'short' };

// table: hedge needed, nothing else -> hold
const decisive = (over: Partial<FactorProbs> = {}): FactorProbs => ({
  hedgeNeeded: 0.95,
  fundingMaterial: 0.03,
  nearLiquidation: 0.02,
  inProfit: 0.05,
  volatile: 0.04,
  ...over,
});

let t = 0;
const clients = (over: Partial<ProposeClients> = {}): ProposeClients => ({
  ask: async () => decisive(),
  escalate: async () => ({ action: 'hold', rationale: 'claude says hold' }),
  shuffle: (xs) => [...xs],
  now: () => (t += 10),
  newId: () => 'id-1',
  ...over,
});

describe('proposeAction', () => {
  it('event names are fixed', () => {
    expect(DECISION_EVENTS).toEqual({ proposed: 'decision.proposed', accepted: 'decision.accepted', rejected: 'decision.rejected' });
  });

  it('all factors decisive: Jev decides alone through the table, Claude is not called', async () => {
    const escalate = vi.fn();
    const p = await proposeAction(STATE, SMALL, clients({ escalate }));
    expect(escalate).not.toHaveBeenCalled();
    expect(p).toMatchObject({ id: 'id-1', action: 'hold', source: 'jev', model: JEV_MODEL, flagged: false });
    expect(FACTOR_KEYS.every((k) => p.factors[k]!.decidedBy === 'jev')).toBe(true);
    expect(p.factors.hedgeNeeded.p).toBe(0.95);
  });

  it('undecided factors go to Sonnet with Jev numbers; agreement with the table is source claude', async () => {
    const probs = decisive({ inProfit: 0.55, volatile: 0.3 });
    const escalate = vi.fn(async () => ({ action: 'hold' as Action, rationale: 'agree' }));
    const p = await proposeAction(STATE, SMALL, clients({ ask: async () => probs, escalate }));
    expect(escalate.mock.calls[0]).toEqual([SONNET_MODEL, STATE.facts, probs, ['inProfit', 'volatile'], SMALL]);
    // table on >= 0.5: inProfit true, volatile false -> take_profit. Sonnet says hold (disagrees), so Opus is asked too
    // and also says hold; hold leaves less net exposure than take_profit here, so the disagreement resolves to hold.
    expect(p.trace.tableAction).toBe('take_profit');
    expect(p).toMatchObject({ action: 'hold', source: 'disagree', flagged: true, model: OPUS_MODEL });
    expect(p.factors.inProfit.decidedBy).toBe('claude');
    expect(p.factors.hedgeNeeded.decidedBy).toBe('jev');
  });

  it('Sonnet agrees with the table: one call, source claude, not flagged', async () => {
    const probs = decisive({ volatile: 0.4 }); // table: hold
    const p = await proposeAction(STATE, SMALL, clients({ ask: async () => probs, escalate: async () => ({ action: 'hold', rationale: 'ok' }) }));
    expect(p).toMatchObject({ action: 'hold', source: 'claude', model: SONNET_MODEL, flagged: false });
    expect(p.trace.calls.map((c) => c.model)).toEqual([SONNET_MODEL]);
  });

  it('Sonnet disagrees with the table: Opus is asked and wins when it agrees with the table', async () => {
    const probs = decisive({ volatile: 0.4 }); // table: hold
    const escalate = vi.fn(async (model: string) => ({ action: (model === SONNET_MODEL ? 'close_both' : 'hold') as Action, rationale: model }));
    const p = await proposeAction(STATE, SMALL, clients({ ask: async () => probs, escalate }));
    expect(p.trace.calls.map((c) => c.model)).toEqual([SONNET_MODEL, OPUS_MODEL]);
    expect(p).toMatchObject({ action: 'hold', source: 'claude', model: OPUS_MODEL, rationale: OPUS_MODEL });
  });

  it('notional above the threshold goes straight to Opus', async () => {
    const probs = decisive({ volatile: 0.4 });
    const escalate = vi.fn(async () => ({ action: 'hold' as Action, rationale: 'ok' }));
    const p = await proposeAction(STATE, BIG, clients({ ask: async () => probs, escalate }));
    expect(escalate).toHaveBeenCalledOnce();
    expect(escalate.mock.calls[0]![0]).toBe(OPUS_MODEL);
    expect(p.model).toBe(OPUS_MODEL);
  });

  it('the Opus threshold is configurable', async () => {
    const escalate = vi.fn(async () => ({ action: 'hold' as Action, rationale: 'ok' }));
    await proposeAction(STATE, SMALL, clients({ ask: async () => decisive({ volatile: 0.4 }), escalate }), { escalateOpusNotional: 100 });
    expect(escalate.mock.calls[0]![0]).toBe(OPUS_MODEL);
  });

  it('disagreement takes the less risky action by the state-derived ranking and flags it', async () => {
    // table: hold (net 300 long-heavy). Opus says take_profit with the short leg in profit -> leaves 600 net: riskier. hold wins.
    const probs = decisive({ volatile: 0.4 });
    const p = await proposeAction(STATE, BIG, clients({ ask: async () => probs, escalate: async () => ({ action: 'take_profit', rationale: 'bank it' }) }));
    expect(p).toMatchObject({ action: 'hold', source: 'disagree', flagged: true, model: OPUS_MODEL });
    expect(p.rationale).toContain('bank it');
  });

  it('Jev down: Claude decides alone with every factor marked claude, flagged', async () => {
    const escalate = vi.fn(async () => ({ action: 'close_both' as Action, rationale: 'x' }));
    const p = await proposeAction(STATE, SMALL, clients({ ask: async () => Promise.reject(new Error('timeout')), escalate }));
    expect(escalate).toHaveBeenCalledWith(SONNET_MODEL, STATE.facts, null, [...FACTOR_KEYS], SMALL);
    expect(p).toMatchObject({ action: 'close_both', source: 'claude', flagged: true });
    expect(p.error).toContain('jev: timeout');
    expect(FACTOR_KEYS.every((k) => p.factors[k]!.p === null && p.factors[k]!.decidedBy === 'claude')).toBe(true);
  });

  it('both down: hold, flagged, error recorded', async () => {
    const p = await proposeAction(STATE, SMALL, clients({ ask: async () => Promise.reject(new Error('a')), escalate: async () => Promise.reject(new Error('b')) }));
    expect(p).toMatchObject({ action: 'hold', flagged: true });
    expect(p.error).toContain('jev: a');
    expect(p.error).toContain('claude: b');
  });

  it('latency covers the whole proposal', async () => {
    let n = 0;
    const p = await proposeAction(STATE, SMALL, clients({ now: () => (n += 50) }));
    expect(p.latencyMs).toBeGreaterThan(0);
    expect(p.trace.jevMs).toBe(50);
  });
});

describe('compactFacts', () => {
  it('shortens keys and drops the text after the colon', () => {
    expect(compactFacts({ hedgeCoverage: 'full: legs are about equal', trend: 'ranging' })).toEqual({ cover: 'full', trend: 'ranging' });
  });
});

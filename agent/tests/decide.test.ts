import { describe, expect, it, vi } from 'vitest';
import { ACTION_IDS, RISK_RANK, decide, type Action, type DecideDeps, type JevAnswer } from '../src/decide';

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

describe('decide', () => {
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

  const disagreements: Array<[Action, Action, Action]> = [
    ['add_hedge', 'hold', 'hold'], // Jev wants to open exposure, Claude holds: take hold
    ['hold', 'close_both', 'close_both'], // risk-reducing beats hold
    ['reduce_hedge', 'take_profit', 'take_profit'],
    ['close_both', 'add_hedge', 'close_both'],
  ];
  for (const [jevPick, claudePick, expected] of disagreements) {
    it(`disagreement jev=${jevPick} claude=${claudePick} takes ${expected} and flags it`, async () => {
      const d = await decide(FACTS, deps({ jev: async () => jevAnswer(jevPick, 0.6), escalate: async () => ({ action: claudePick, rationale: 'x' }) }));
      expect(d).toMatchObject({ action: expected, source: 'less_risky_of_two', flagged: true });
      expect(RISK_RANK[d.action]).toBe(Math.min(RISK_RANK[jevPick], RISK_RANK[claudePick]));
    });
  }

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

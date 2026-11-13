import { describe, expect, it } from 'vitest';
import { decisionRows, pendingDecision } from '../../web/src/decisions.ts';

const ev = (id: number, type: string, data: Record<string, unknown>, at = id * 1000) => ({ id, at, type, data }) as never;
const prop = (id: string, at: number, extra: Record<string, unknown> = {}) => ev(at, 'decision.proposed', { id, coin: 'BTC', action: 'close_both', at, ...extra }, at);
const state = (rows: ReturnType<typeof decisionRows>, id: string) => rows.find((r) => r.d.id === id)?.state;

describe('decisionRows / pendingDecision: only the newest suggestion can be open', () => {
  // events are newest first
  const events = [prop('p3', 3000), prop('p2', 2000), prop('p1', 1000)];

  it('older proposals are replaced, never shown as current', () => {
    const rows = decisionRows(events, new Set(), undefined, 3500);
    expect(rows.map((r) => [r.d.id, r.state])).toEqual([['p3', 'open'], ['p2', 'replaced'], ['p1', 'replaced']]);
    expect(pendingDecision(events, new Set(), undefined, 3500)?.id).toBe('p3');
  });

  it('hiding or declining the newest leaves NOTHING pending (the old bug showed p2 next)', () => {
    expect(pendingDecision(events, new Set(['p3']), undefined, 3500)).toBeUndefined();
    const declined = [ev(9, 'decision.rejected', { id: 'p3' }), ...events];
    expect(pendingDecision(declined, new Set(), undefined, 3500)).toBeUndefined();
    expect(state(decisionRows(declined, new Set(), undefined, 3500), 'p3')).toBe('declined');
  });

  it('accepted, expired by time, and expired by the agent', () => {
    expect(state(decisionRows([ev(9, 'decision.accepted', { id: 'p3' }), ...events], new Set(), undefined, 3500), 'p3')).toBe('accepted');
    expect(state(decisionRows([prop('p3', 3000, { expiresAt: 4000 })], new Set(), undefined, 5000), 'p3')).toBe('expired');
    const view = { mode: 'propose', latest: { id: 'p3', coin: 'BTC', action: 'close_both', at: 3000, status: 'expired' } } as never;
    expect(pendingDecision(events, new Set(), view, 3500)).toBeUndefined();
  });

  it('a proposal known only from /owner is used, and the newest of the two wins', () => {
    const view = { mode: 'propose', latest: { id: 'v1', coin: 'BTC', action: 'hold', at: 4000, status: 'open' } } as never;
    expect(pendingDecision(events, new Set(), view, 4500)?.id).toBe('v1');
    expect(state(decisionRows(events, new Set(), view, 4500), 'p3')).toBe('replaced');
  });

  it('a strategy suggestion does not replace the hedge suggestion (and one per strategy)', () => {
    const mixed = [prop('s2', 5000, { kind: 'strategy', strategyId: 'a', action: 'pause_strategy' }), prop('s1', 4000, { kind: 'strategy', strategyId: 'a' }), prop('s9', 4500, { kind: 'strategy', strategyId: 'b' }), ...events];
    const rows = decisionRows(mixed, new Set(), undefined, 5500);
    expect(rows.filter((r) => r.state === 'open').map((r) => r.d.id).sort()).toEqual(['p3', 's2', 's9']);
    expect(state(rows, 's1')).toBe('replaced');
  });
});

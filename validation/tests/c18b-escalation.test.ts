import { describe, expect, it } from 'vitest';
import { noul } from '@typesafe-ai/sdk';
import { LIVE } from '../src/env';
import { jevClient } from '../src/jev';
import { claudeEscalator } from '../src/claude';
import { compactFacts, loadStates, percentile } from '../src/decide';
import {
  FACTOR_KEYS,
  FACTOR_QUESTIONS,
  JEV_MODEL,
  OPUS_MODEL,
  proposeAction,
  type DecideContext,
  type FactorKey,
  type FactorProbs,
  type Proposal,
} from '../../agent/src/decide';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.TYPESAFE_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY);

/** Leg sizes are not in the facts (raw numbers never go to Jev); build a plausible pair from the coverage bucket. */
function ctxFor(coverage: string, longNotional: number): DecideContext {
  const ratio = coverage.startsWith('none') ? 0 : coverage.startsWith('partial') ? 0.5 : coverage.startsWith('over') ? 1.2 : 1;
  return { longNotional, shortNotional: longNotional * ratio, profitLeg: 'short' };
}

// C18b: the real escalation path end to end: Jev yes/no factors -> (undecided) -> Claude Sonnet, one forced Opus case.
describe.skipIf(!live)('C18b: proposeAction live', () => {
  it('5 fixtures, the last with a notional above the Opus threshold', async () => {
    await runClaim('C18b', 'C18b', 'Jev factors -> Claude escalation (Sonnet 5.5, forced Opus 5.5 case)', async (r) => {
      const jev = jevClient(10_000);
      const escalate = claudeEscalator();
      const states = loadStates().filter((_, i) => i % 10 === 0).slice(0, 5); // s01 s11 s21 s31 s41
      const rows: unknown[] = [];
      const proposals: Proposal[] = [];

      for (const [i, s] of states.entries()) {
        const forcedOpus = i === states.length - 1;
        const ctx = ctxFor(s.facts.hedgeCoverage ?? '', forcedOpus ? 5000 : 400);
        const p = await proposeAction({ facts: s.facts }, ctx, {
          ask: async (_facts, order: FactorKey[]) => {
            const res = await jev.systemOne({
              state: compactFacts(s.facts),
              questions: Object.fromEntries(order.map((k) => [k, noul(FACTOR_QUESTIONS[k])])),
              model: JEV_MODEL,
            });
            const a = res.answers as unknown as Record<FactorKey, { noul: number }>;
            return Object.fromEntries(FACTOR_KEYS.map((k) => [k, a[k].noul])) as FactorProbs;
          },
          escalate,
        });
        proposals.push(p);
        rows.push({
          id: s.id,
          forcedOpus,
          ctx,
          action: p.action,
          source: p.source,
          model: p.model,
          flagged: p.flagged,
          latencyMs: p.latencyMs,
          jevMs: p.trace.jevMs,
          calls: p.trace.calls,
          tableAction: p.trace.tableAction,
          undecided: FACTOR_KEYS.filter((k) => p.factors[k].decidedBy === 'claude'),
          factors: p.factors,
          rationale: p.rationale,
          error: p.error ?? null,
        });
      }

      const lat = proposals.map((p) => p.latencyMs);
      r.numbers.proposals = proposals.length;
      r.numbers.errors = proposals.filter((p) => p.error).length;
      r.numbers.latencyP50Ms = Math.round(percentile(lat, 50));
      r.numbers.latencyMaxMs = Math.round(Math.max(...lat));
      r.numbers.escalatedToClaude = proposals.filter((p) => p.trace.calls.length > 0).length;
      r.numbers.decidedByJevAlone = proposals.filter((p) => p.source === 'jev').length;
      r.numbers.disagreements = proposals.filter((p) => p.source === 'disagree').length;
      r.numbers.opusCalls = proposals.flatMap((p) => p.trace.calls).filter((c) => c.model === OPUS_MODEL).length;
      r.refs.rows = rows;
      expect(proposals.every((p) => !p.error)).toBe(true);
      const forced = proposals[proposals.length - 1]!;
      expect(forced.trace.calls[0]?.model, 'forced case must go to Opus first').toBe(OPUS_MODEL);
    });
  }, 300_000);
});

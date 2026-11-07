import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { noul } from '@typesafe-ai/sdk';
import { LIVE } from '../src/env';
import { jevClient } from '../src/jev';
import { loadStates, percentile, shuffled } from '../src/decide';
import { FACTOR_KEYS, FACTOR_QUESTIONS, actionFromFactors, gateFactors, type Action, type FactorBools, type FactorKey, type FactorProbs } from '../../agent/src/decide';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.TYPESAFE_API_KEY);
const MODEL = 'jev-1.14.0';
const MAX_BODY_BYTES = 1200;
const C18_RUNS = fileURLToPath(new URL('../results/C18-runs.json', import.meta.url));

const bools = (p: FactorProbs): FactorBools => Object.fromEntries(FACTOR_KEYS.map((k) => [k, p[k] >= 0.5])) as FactorBools;
const decisive = (p: FactorProbs) => FACTOR_KEYS.every((k) => p[k] >= 0.9 || p[k] <= 0.1);

interface Call {
  id: string;
  run: number;
  order: FactorKey[];
  probs: FactorProbs;
  ms: number;
}

// C17b: Jev with several yes/no questions in ONE request (one factor per question), combined by a table in code.
describe.skipIf(!live)('C17b: Jev factor questions', () => {
  it('50 states x 2 shuffled question orders', async () => {
    await runClaim('C17b', 'C17b', 'Jev yes/no factor layout: decisiveness at 0.90, stability, latency, agreement with Claude', async (r) => {
      let maxBody = 0;
      const client = jevClient(10_000, (n) => (maxBody = Math.max(maxBody, n)));
      const states = loadStates();
      const calls: Call[] = [];
      const errors: string[] = [];
      let attempts = 0;
      let failedAttempts = 0;

      for (const [si, s] of states.entries()) {
        for (const run of [0, 1]) {
          const order = shuffled(FACTOR_KEYS, 5000 + si * 2 + run);
          let res;
          let lastErr = '';
          const t0 = performance.now();
          for (let attempt = 1; attempt <= 3 && !res; attempt++) {
            attempts++;
            try {
              res = await client.systemOne({
                state: s.facts,
                questions: Object.fromEntries(order.map((k) => [k, noul(FACTOR_QUESTIONS[k])])),
                model: MODEL,
              });
            } catch (e) {
              failedAttempts++;
              lastErr = e instanceof Error ? e.message : String(e);
            }
          }
          if (!res) {
            errors.push(`${s.id}#${run}: ${lastErr}`);
            continue;
          }
          const ms = performance.now() - t0;
          const answers = res.answers as unknown as Record<FactorKey, { noul: number }>;
          const probs = Object.fromEntries(FACTOR_KEYS.map((k) => [k, answers[k].noul])) as FactorProbs;
          calls.push({ id: s.id, run, order, probs, ms });
        }
      }

      const byState = states.map((s) => calls.filter((c) => c.id === s.id)).filter((cs) => cs.length === 2) as Array<[Call, Call]>;
      const ms = calls.map((c) => c.ms);
      const decidedCalls = calls.filter((c) => decisive(c.probs)).length;
      const decidedBoth = byState.filter(([a, b]) => decisive(a.probs) && decisive(b.probs)).length;
      const actionFlip = byState.filter(([a, b]) => actionFromFactors(bools(a.probs)) !== actionFromFactors(bools(b.probs))).length;
      const boolFlips = byState.reduce((t, [a, b]) => t + FACTOR_KEYS.filter((k) => a.probs[k] >= 0.5 !== b.probs[k] >= 0.5).length, 0);
      const meanAbsDiff = byState.reduce((t, [a, b]) => t + FACTOR_KEYS.reduce((u, k) => u + Math.abs(a.probs[k] - b.probs[k]), 0), 0) / (byState.length * FACTOR_KEYS.length);

      r.numbers.calls = calls.length;
      r.numbers.errors = errors.length;
      r.numbers.attempts = attempts;
      r.numbers.failedAttempts = failedAttempts;
      r.numbers.latencyP50Ms = Math.round(percentile(ms, 50));
      r.numbers.latencyP95Ms = Math.round(percentile(ms, 95));
      r.numbers.maxBodyBytes = maxBody;
      r.numbers.shareCallsFullyDecidedAt090 = decidedCalls / calls.length;
      r.numbers.shareStatesDecidedInBothRuns = decidedBoth / byState.length;
      for (const k of FACTOR_KEYS) r.numbers[`decisive.${k}`] = calls.filter((c) => c.probs[k] >= 0.9 || c.probs[k] <= 0.1).length / calls.length;
      r.numbers.actionFlipRate = actionFlip / byState.length;
      r.numbers.factorBooleanFlipRate = boolFlips / (byState.length * FACTOR_KEYS.length);
      r.numbers.meanAbsProbDiffBetweenRuns = meanAbsDiff;
      if (maxBody >= MAX_BODY_BYTES) r.warn(`request body reached ${maxBody} B (limit ${MAX_BODY_BYTES})`);
      if (errors.length) {
        r.refs.errors = errors.slice(0, 10);
        r.warn(`${errors.length} calls failed`);
      }

      // agreement with the C18 Claude decisions: table action on the mean of both runs vs Claude
      if (existsSync(C18_RUNS)) {
        const claude = new Map((JSON.parse(readFileSync(C18_RUNS, 'utf8')).decisions as Array<{ id: string; action: string }>).map((d) => [d.id, d.action]));
        let agreeAll = 0;
        let compared = 0;
        let agreeDecided = 0;
        let comparedDecided = 0;
        const rows: unknown[] = [];
        for (const [a, b] of byState) {
          const c = claude.get(a.id);
          if (!c) continue;
          const mean = Object.fromEntries(FACTOR_KEYS.map((k) => [k, (a.probs[k] + b.probs[k]) / 2])) as FactorProbs;
          const act: Action = actionFromFactors(bools(mean));
          const both = decisive(a.probs) && decisive(b.probs);
          compared++;
          if (act === c) agreeAll++;
          if (both) {
            comparedDecided++;
            if (act === c) agreeDecided++;
          }
          rows.push({ id: a.id, jev: act, claude: c, decidedInBothRuns: both, gate: gateFactors(mean) });
        }
        r.numbers.agreementWithClaudeAll = compared ? agreeAll / compared : null;
        r.numbers.agreementCompared = compared;
        r.numbers.agreementWithClaudeWhereDecided = comparedDecided ? agreeDecided / comparedDecided : null;
        r.numbers.agreementComparedDecided = comparedDecided;
        r.refs.agreementRows = rows;
      } else {
        r.warn('results/C18-runs.json missing: agreement not computed');
      }

      writeFileSync(fileURLToPath(new URL('../results/C17b-runs.json', import.meta.url)), JSON.stringify({ model: MODEL, calls }, null, 2) + '\n');
      expect(calls.length).toBeGreaterThan(0);
    });
  }, 900_000);
});

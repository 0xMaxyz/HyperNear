import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { choice } from '@typesafe-ai/sdk';
import { jevClient } from '../src/jev';
import { LIVE } from '../src/env';
import { ACTIONS, ACTION_IDS, loadStates, percentile, shuffled, type Action } from '../src/decide';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.TYPESAFE_API_KEY);
const MODEL = 'jev-1.14.0';
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;
const FLIP_LIMIT = 0.1; // C17 pass bar for "shuffling changes the top answer": plan says "less than X%", X chosen here

interface Call {
  id: string;
  run: number;
  order: Action[];
  choice: Action;
  topProb: number;
  confidence: number;
  probs: Record<string, number>;
  ms: number;
}

// C17: Jev access, sub-second `choice` latency on our state shape, and stability under option shuffling.
describe.skipIf(!live)('C17: Jev decide fixtures', () => {
  it('50 states x 2 shuffled orders', async () => {
    await runClaim('C17', 'C17', 'Jev choice call: latency, shuffle stability, confidence', async (r) => {
      // jevClient() sends Connection: close (keep-alive reuse hangs every second request, see src/jev.ts); our own bounded
      // retries below count any remaining failures.
      const timed = jevClient(ATTEMPT_TIMEOUT_MS);
      let attemptsTotal = 0;
      let attemptFailures = 0;
      const singleAttemptMs: number[] = [];
      let consecutiveErrors = 0;
      const errors: string[] = [];
      const states = loadStates();
      const calls: Call[] = [];
      let shape: unknown;

      outer: for (const [si, s] of states.entries()) {
        for (const run of [0, 1]) {
          if (consecutiveErrors >= 6) {
            errors.push('aborted after 6 consecutive failures');
            break outer;
          }
          const order = shuffled(ACTION_IDS, si * 2 + run + 1);
          const options = Object.fromEntries(order.map((a) => [a, ACTIONS[a]]));
          const t0 = performance.now();
          let res;
          let lastErr = '';
          for (let attempt = 1; attempt <= MAX_ATTEMPTS && !res; attempt++) {
            const a0 = performance.now();
            attemptsTotal++;
            try {
              res = await timed.systemOne({
                state: s.facts,
                questions: { decision: choice('Which action is best for this hedged position right now?', options) },
                model: MODEL,
              });
              singleAttemptMs.push(performance.now() - a0);
            } catch (e) {
              attemptFailures++;
              lastErr = `${e instanceof Error ? e.name + ': ' + e.message : String(e)}`;
            }
          }
          if (!res) {
            errors.push(`${s.id}#${run}: all ${MAX_ATTEMPTS} attempts failed (${lastErr})`);
            consecutiveErrors++;
            continue;
          }
          consecutiveErrors = 0;
          const ms = performance.now() - t0; // includes failed attempts: the latency a caller really sees
          const a = res.answers.decision;
          const probs = a.probabilities as Record<string, number>;
          if (!shape) {
            shape = {
              responseKeys: Object.keys(res),
              answerKeys: Object.keys(a),
              model: res.model,
              usage: (res as { usage?: unknown }).usage ?? null,
              sample: { choice: a.choice, confidence: a.confidence, probabilities: probs },
            };
          }
          calls.push({ id: s.id, run, order, choice: a.choice as Action, topProb: Math.max(...Object.values(probs)), confidence: a.confidence, probs, ms });
        }
      }

      const ms = calls.map((c) => c.ms);
      const byState = states.map((s) => calls.filter((c) => c.id === s.id));
      const complete = byState.filter((cs) => cs.length === 2);
      r.numbers.errors = errors.length;
      r.numbers.attempts = attemptsTotal;
      r.numbers.failedAttempts = attemptFailures;
      r.numbers.attemptFailureRate = attemptFailures / attemptsTotal;
      if (singleAttemptMs.length) {
        r.numbers.successAttemptP50Ms = Math.round(percentile(singleAttemptMs, 50));
        r.numbers.successAttemptP95Ms = Math.round(percentile(singleAttemptMs, 95));
      }
      if (errors.length) {
        r.refs.errors = errors.slice(0, 10);
        r.warn(`${errors.length} of 100 calls failed (timeout or dropped connection)`);
      }
      const flips = complete.filter(([x, y]) => x!.choice !== y!.choice).length;
      const top90Calls = calls.filter((c) => c.topProb >= 0.9).length;
      const top90Both = complete.filter(([x, y]) => x!.topProb >= 0.9 && y!.topProb >= 0.9 && x!.choice === y!.choice).length;
      const firstListed = calls.filter((c) => c.choice === c.order[0]).length;
      const tally: Record<string, number> = {};
      for (const c of calls) tally[c.choice] = (tally[c.choice] ?? 0) + 1;

      r.numbers.calls = calls.length;
      r.numbers.latencyWithRetriesP50Ms = Math.round(percentile(ms, 50));
      r.numbers.latencyWithRetriesP95Ms = Math.round(percentile(ms, 95));
      r.numbers.latencyWithRetriesMaxMs = Math.round(Math.max(...ms));
      r.numbers.statesComplete = complete.length;
      r.numbers.flipRate = flips / complete.length;
      r.numbers.shareTopProbAtLeast090 = top90Calls / calls.length;
      r.numbers.shareStatesBothRunsAgreeAnd090 = top90Both / complete.length;
      r.numbers.shareChosenWasListedFirst = firstListed / calls.length;
      r.numbers.confidenceMean = calls.reduce((t, c) => t + c.confidence, 0) / calls.length;
      r.refs.model = MODEL;
      r.refs.responseShape = shape;
      r.refs.choiceTally = tally;
      if (flips / complete.length > FLIP_LIMIT) r.warn(`top answer flips under shuffling on ${flips}/${complete.length} states (> ${FLIP_LIMIT * 100}%)`);
      if (percentile(ms, 95) > 1000) r.warn('p95 latency (with retries) above 1 s');
      if (attemptFailures / attemptsTotal > 0.05) r.warn(`${Math.round((100 * attemptFailures) / attemptsTotal)}% of attempts timed out or dropped`);

      // consumed by C18: Jev's answer per state = argmax of the mean probabilities over both runs
      const jevTop = states.flatMap((s, i) => {
        const cs = byState[i]!;
        if (cs.length < 1) return [];
        const [x, y = x] = cs as [Call, Call?];
        const mean = ACTION_IDS.map((a) => [a, ((x.probs[a] ?? 0) + (y.probs[a] ?? 0)) / 2] as const);
        const [top, p] = mean.reduce((m, c) => (c[1] > m[1] ? c : m));
        return [{ id: s.id, top, meanProb: p, run0: x!.choice, run1: y!.choice }];
      });
      writeFileSync(fileURLToPath(new URL('../results/C17-runs.json', import.meta.url)), JSON.stringify({ model: MODEL, jevTop, calls: calls.map(({ probs: _p, ...c }) => c) }, null, 2) + '\n');
      expect(calls.length).toBeGreaterThan(0);
    });
  }, 900_000);
});

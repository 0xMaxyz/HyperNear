import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { LIVE } from '../src/env';
import { ACTIONS, ACTION_IDS, loadStates, percentile, shuffled, type Action } from '../src/decide';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.TYPESAFE_API_KEY);
const MODEL = 'jev-1.14.0';
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
      // the first call to a pinned model can take over a minute (cold start, measured 78 s), so warm up with a long timeout
      const client = new TypeSafeClient({ timeout: 180_000 });
      const w0 = performance.now();
      await client.systemOne({ state: { warmup: 'yes' }, questions: { d: choice('Pick one', { a: 'first', b: 'second' }) }, model: MODEL });
      r.numbers.coldStartMs = Math.round(performance.now() - w0);
      const states = loadStates();
      const calls: Call[] = [];
      let shape: unknown;

      for (const [si, s] of states.entries()) {
        for (const run of [0, 1]) {
          const order = shuffled(ACTION_IDS, si * 2 + run + 1);
          const options = Object.fromEntries(order.map((a) => [a, ACTIONS[a]]));
          const t0 = performance.now();
          const res = await client.systemOne({
            state: s.facts,
            questions: { decision: choice('Which action is best for this hedged position right now?', options) },
            model: MODEL,
          });
          const ms = performance.now() - t0;
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
      const flips = byState.filter(([x, y]) => x!.choice !== y!.choice).length;
      const top90Calls = calls.filter((c) => c.topProb >= 0.9).length;
      const top90Both = byState.filter(([x, y]) => x!.topProb >= 0.9 && y!.topProb >= 0.9 && x!.choice === y!.choice).length;
      const firstListed = calls.filter((c) => c.choice === c.order[0]).length;
      const tally: Record<string, number> = {};
      for (const c of calls) tally[c.choice] = (tally[c.choice] ?? 0) + 1;

      r.numbers.calls = calls.length;
      r.numbers.latencyP50Ms = Math.round(percentile(ms, 50));
      r.numbers.latencyP95Ms = Math.round(percentile(ms, 95));
      r.numbers.latencyMaxMs = Math.round(Math.max(...ms));
      r.numbers.flipRate = flips / states.length;
      r.numbers.shareTopProbAtLeast090 = top90Calls / calls.length;
      r.numbers.shareStatesBothRunsAgreeAnd090 = top90Both / states.length;
      r.numbers.shareChosenWasListedFirst = firstListed / calls.length;
      r.numbers.confidenceMean = calls.reduce((t, c) => t + c.confidence, 0) / calls.length;
      r.refs.model = MODEL;
      r.refs.responseShape = shape;
      r.refs.choiceTally = tally;
      if (flips / states.length > FLIP_LIMIT) r.warn(`top answer flips under shuffling on ${flips}/${states.length} states (> ${FLIP_LIMIT * 100}%)`);
      if (percentile(ms, 95) > 1000) r.warn('p95 latency above 1 s');

      // consumed by C18: Jev's answer per state = argmax of the mean probabilities over both runs
      const jevTop = states.map((s, i) => {
        const [x, y] = byState[i]!;
        const mean = ACTION_IDS.map((a) => [a, ((x!.probs[a] ?? 0) + (y!.probs[a] ?? 0)) / 2] as const);
        const [top, p] = mean.reduce((m, c) => (c[1] > m[1] ? c : m));
        return { id: s.id, top, meanProb: p, run0: x!.choice, run1: y!.choice };
      });
      writeFileSync(fileURLToPath(new URL('../results/C17-runs.json', import.meta.url)), JSON.stringify({ model: MODEL, jevTop, calls: calls.map(({ probs: _p, ...c }) => c) }, null, 2) + '\n');
      expect(calls).toHaveLength(100);
    });
  }, 900_000);
});

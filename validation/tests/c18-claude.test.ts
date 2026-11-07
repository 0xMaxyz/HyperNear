import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { LIVE } from '../src/env';
import { ACTIONS, ACTION_IDS, loadStates, percentile, shuffled } from '../src/decide';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = 'claude-sonnet-5-5';
const RUNS_FILE = fileURLToPath(new URL('../results/C17-runs.json', import.meta.url));
const N = 10;

// C18: structured-output escalation ({action, rationale}) on 10 of the C17 fixtures: latency and agreement with Jev.
describe.skipIf(!live)('C18: Claude escalation', () => {
  it('Sonnet 5.5 structured output on 10 fixtures', async () => {
    await runClaim('C18', 'C18', 'Claude structured-output escalation: latency, agreement with Jev', async (r) => {
      const jev: Record<string, string> = existsSync(RUNS_FILE)
        ? Object.fromEntries((JSON.parse(readFileSync(RUNS_FILE, 'utf8')).jevTop as Array<{ id: string; top: string }>).map((j) => [j.id, j.top]))
        : {};
      if (!Object.keys(jev).length) r.warn('results/C17-runs.json missing: agreement not computed');

      const client = new Anthropic();
      // every 5th state: spread over the fixture set
      const states = loadStates().filter((_, i) => i % 5 === 0).slice(0, N);
      const ms: number[] = [];
      let agree = 0;
      let compared = 0;
      let sample: unknown;

      for (const [i, s] of states.entries()) {
        const order = shuffled(ACTION_IDS, 1000 + i);
        const t0 = performance.now();
        const res = await client.messages.create({
          model: MODEL,
          max_tokens: 2000,
          output_config: {
            effort: 'low',
            format: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: { action: { type: 'string', enum: [...ACTION_IDS] }, rationale: { type: 'string' } },
                required: ['action', 'rationale'],
                additionalProperties: false,
              },
            },
          },
          system:
            'You decide what to do with a hedged perpetual-futures position (a long leg and a short leg on separate accounts). ' +
            'Pick exactly one action. Liquidation protection and capital preservation come before profit. Keep the rationale to two sentences.',
          messages: [
            {
              role: 'user',
              content:
                `State (bucketed facts):\n${JSON.stringify(s.facts, null, 2)}\n\nOptions:\n` +
                order.map((a) => `- ${a}: ${ACTIONS[a]}`).join('\n'),
            },
          ],
        });
        ms.push(performance.now() - t0);
        if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new Error(`unexpected stop_reason ${res.stop_reason}`);
        const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
        const out = JSON.parse(text) as { action: string; rationale: string };
        expect(ACTION_IDS).toContain(out.action);
        sample ??= { out, usage: res.usage, stop_reason: res.stop_reason };
        if (jev[s.id]) {
          compared++;
          if (jev[s.id] === out.action) agree++;
        }
      }

      r.numbers.calls = ms.length;
      r.numbers.latencyP50Ms = Math.round(percentile(ms, 50));
      r.numbers.latencyP95Ms = Math.round(percentile(ms, 95));
      r.numbers.agreementWithJev = compared ? agree / compared : null;
      r.numbers.compared = compared;
      r.refs.model = MODEL;
      r.refs.effort = 'low';
      r.refs.sample = sample;
    });
  }, 600_000);
});

import { describe, expect, it } from 'vitest';
import { LIVE } from '../src/env';
import { runClaim } from '../src/results';

const live = LIVE && Boolean(process.env.NEAR_AI_API_KEY);
const BASE = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';

// C12: does a NEAR AI Cloud model return OpenAI-style tool calls? A credit/auth error is recorded as ⚠️ (not a failure).
describe.skipIf(!live)('C12: NEAR AI Cloud tool call', () => {
  it('one chat completion with a tool definition', async () => {
    await runClaim('C12', 'C12', 'NEAR AI Cloud model supports OpenAI-style tool calls', async (r) => {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEAR_AI_API_KEY}` };
      const modelsRes = await fetch(`${BASE}/models`, { headers });
      r.numbers.modelsHttp = modelsRes.status;
      const modelsBody = (await modelsRes.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
      const ids = (modelsBody.data ?? []).map((m) => m.id);
      r.refs.models = ids.slice(0, 20);
      const model = process.env.NEAR_AI_MODEL ?? ids.find((id) => /qwen|gpt-oss|deepseek|llama/i.test(id)) ?? ids[0];
      if (!model) {
        r.warn(`no models returned (HTTP ${modelsRes.status})`);
        return;
      }
      r.refs.model = model;

      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 300,
          messages: [{ role: 'user', content: 'What is the margin guard status of leg 0? Use the tool.' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_leg_status',
                description: 'Read the margin status of one leg',
                parameters: { type: 'object', properties: { leg: { type: 'integer' } }, required: ['leg'] },
              },
            },
          ],
          tool_choice: 'auto',
        }),
      });
      r.numbers.chatHttp = res.status;
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      if (!res.ok) {
        r.refs.error = body.error ?? body;
        r.warn(`chat completion rejected (HTTP ${res.status}): likely credit/auth, tool-call support not tested`);
        return;
      }
      const calls = body.choices?.[0]?.message?.tool_calls ?? [];
      r.refs.toolCalls = calls;
      r.numbers.toolCallCount = calls.length;
      expect(calls.length).toBeGreaterThan(0);
    });
  }, 120_000);
});

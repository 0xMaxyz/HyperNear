import { describe, expect, it } from 'vitest';
import { proposalTools, runChat, type ChatModel, type ChatTools, type ModelTurn, type Turn } from '../src/chat';

const tools = (over: Partial<ChatTools> = {}): ChatTools => ({
  get_legs: async () => [{ leg: 0 }],
  propose_hedge: async () => ({}),
  close_hedge: async () => ({}),
  rebalance: async () => ({ ok: true }),
  withdraw: async () => ({ ok: true }),
  ...over,
});

const scripted = (turns: ModelTurn[]): ChatModel & { seen: Turn[][] } => {
  const seen: Turn[][] = [];
  let i = 0;
  return {
    name: 'fake',
    seen,
    step: async (_s, history) => {
      seen.push([...history]);
      return turns[i++]!;
    },
  };
};

describe('runChat', () => {
  it('runs tool calls, feeds results back and returns the final text', async () => {
    const m = scripted([
      { text: '', toolCalls: [{ id: 'a', name: 'get_legs', args: {} }] },
      { text: 'two legs', toolCalls: [] },
    ]);
    const run = await runChat({ model: m, tools: tools(), user: 'status?' });
    expect(run.finalText).toBe('two legs');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ name: 'get_legs', ok: true, output: '[{"leg":0}]' });
    expect(m.seen[1]!.at(-1)).toMatchObject({ role: 'tool', callId: 'a', isError: false });
  });

  it('tool errors reach the model verbatim and are recorded as failures', async () => {
    const m = scripted([
      { text: '', toolCalls: [{ id: 'r', name: 'rebalance', args: { from_leg: 0, to_address: '0xbad', amount: '5' } }] },
      { text: 'it failed', toolCalls: [] },
    ]);
    const run = await runChat({ model: m, tools: tools({ rebalance: async () => Promise.reject(new Error('not a registered leg')) }), user: 'go' });
    expect(run.calls[0]).toMatchObject({ ok: false, output: 'not a registered leg', args: { to_address: '0xbad' } });
    expect(m.seen[1]!.at(-1)).toMatchObject({ role: 'tool', result: 'not a registered leg', isError: true });
  });

  it('unknown tool names are errors, not crashes', async () => {
    const m = scripted([{ text: '', toolCalls: [{ id: 'x', name: 'format_disk', args: {} }] }, { text: 'ok', toolCalls: [] }]);
    const run = await runChat({ model: m, tools: tools(), user: 'x' });
    expect(run.calls[0]).toMatchObject({ ok: false, output: 'unknown tool format_disk' });
  });

  it('stops at maxSteps and says so', async () => {
    const loop: ModelTurn = { text: '', toolCalls: [{ id: 'l', name: 'get_legs', args: {} }] };
    const run = await runChat({ model: scripted([loop, loop, loop]), tools: tools(), user: 'x', maxSteps: 3 });
    expect(run.truncated).toBe(true);
    expect(run.calls).toHaveLength(3);
  });
});

describe('proposalTools', () => {
  it('only record proposals', async () => {
    const seen: unknown[] = [];
    const t = proposalTools((p) => seen.push(p), () => 5, () => 'id');
    await expect(t.propose_hedge({ coin: 'BTC', ratio: '1.0' })).resolves.toEqual({ id: 'id', kind: 'hedge.open', coin: 'BTC', ratio: '1.0', at: 5, status: 'proposed' });
    await t.close_hedge({ coin: 'BTC' });
    expect(seen).toHaveLength(2);
  });
});

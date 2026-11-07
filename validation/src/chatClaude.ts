import Anthropic from '@anthropic-ai/sdk';
import type { ChatModel, ModelTurn, ToolDef, Turn } from '../../agent/src/chat';

/** Claude as the chat model (Messages API, manual tool loop driven by runChat). */
export function claudeChatModel(model: string, client = new Anthropic()): ChatModel {
  return {
    name: model,
    async step(system: string, history: Turn[], tools: ToolDef[]): Promise<ModelTurn> {
      const messages: Anthropic.MessageParam[] = [];
      for (const t of history) {
        if (t.role === 'user') messages.push({ role: 'user', content: t.text });
        else if (t.role === 'assistant') messages.push({ role: 'assistant', content: t.turn.raw as Anthropic.ContentBlockParam[] });
        else {
          // consecutive tool results go into ONE user message
          const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: t.callId, content: t.result, ...(t.isError ? { is_error: true } : {}) };
          const last = messages.at(-1);
          if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
          else messages.push({ role: 'user', content: [block] });
        }
      }
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system,
        output_config: { effort: 'low' },
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        messages,
      });
      if (res.stop_reason === 'refusal') return { text: '[model refused: safety classifier]', toolCalls: [], raw: res.content };
      return {
        text: res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n'),
        toolCalls: res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> })),
        raw: res.content,
      };
    },
  };
}

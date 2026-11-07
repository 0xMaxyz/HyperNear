import Anthropic from '@anthropic-ai/sdk';
import { ACTIONS, ACTION_IDS, FACTOR_QUESTIONS, type DecideContext, type Escalation, type FactorKey, type FactorProbs, type Facts } from '../../agent/src/decide';

const SYSTEM =
  'You decide what to do with a hedged perpetual-futures position (a long leg and a short leg on separate accounts). ' +
  'Pick exactly one action. Liquidation protection and capital preservation come before profit. ' +
  'A fast yes/no classifier gave probabilities for some questions; the ones it could not decide are listed, settle those yourself from the facts. ' +
  'Keep the rationale to two sentences.';

/** Claude (structured output) as the escalation step of proposeAction. One client, model per call. */
export function claudeEscalator(client = new Anthropic()) {
  return async (model: string, facts: Facts, probs: FactorProbs | null, undecided: FactorKey[], ctx: DecideContext): Promise<Escalation> => {
    const jev = probs
      ? Object.fromEntries((Object.keys(FACTOR_QUESTIONS) as FactorKey[]).map((k) => [k, { question: FACTOR_QUESTIONS[k], pYes: probs[k], decisive: !undecided.includes(k) }]))
      : null;
    const res = await client.messages.create({
      model,
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
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Facts (bucketed):\n${JSON.stringify(facts)}\n\n` +
            `Position: long notional ${ctx.longNotional} USD, short notional ${ctx.shortNotional} USD, leg in profit: ${ctx.profitLeg ?? 'unknown'}.\n\n` +
            `Classifier output (null = classifier unavailable):\n${JSON.stringify(jev)}\n\n` +
            `Undecided questions: ${undecided.join(', ') || 'none'}\n\nOptions:\n` +
            ACTION_IDS.map((a) => `- ${a}: ${ACTIONS[a]}`).join('\n'),
        },
      ],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new Error(`unexpected stop_reason ${res.stop_reason}`);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const out = JSON.parse(text) as Escalation;
    if (!ACTION_IDS.includes(out.action)) throw new Error(`bad action ${String(out.action)}`);
    return out;
  };
}

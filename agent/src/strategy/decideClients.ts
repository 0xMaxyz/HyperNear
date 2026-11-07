// The live Jev and Claude clients for strategy/decide.ts (the pure part is tested with fixtures).
import Anthropic from '@anthropic-ai/sdk';
import { noul, type TypeSafeClient } from '@typesafe-ai/sdk';
import { JEV_MODEL, type Facts } from '../decide.ts';
import { jevClient } from '../jev.ts';
import { STRATEGY_ACTION_IDS, STRATEGY_ACTIONS, STRATEGY_FACTOR_KEYS, STRATEGY_QUESTIONS, type StrategyAction, type StrategyClients, type StrategyFactorKey, type StrategyProbs } from './decide.ts';

/** Jev: all factor questions in one request (Connection: close, short bodies: see jev.ts). */
export function jevAskStrategy(jev: TypeSafeClient = jevClient()) {
  return async (facts: Facts, order: StrategyFactorKey[]): Promise<StrategyProbs> => {
    const res = await jev.systemOne({
      state: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.split(':')[0]!])),
      questions: Object.fromEntries(order.map((k) => [k, noul(STRATEGY_QUESTIONS[k])])),
      model: JEV_MODEL,
    });
    const a = res.answers as unknown as Record<StrategyFactorKey, { noul: number }>;
    return Object.fromEntries(STRATEGY_FACTOR_KEYS.map((k) => [k, a[k].noul])) as StrategyProbs;
  };
}

const SYSTEM =
  'You supervise one automated trading strategy (a grid or a TWAP/DCA) that runs on its own Hyperliquid account. ' +
  'Pick exactly one action. Capital preservation comes before profit: pausing is always safe, the owner can resume. ' +
  'A fast yes/no classifier gave probabilities for some questions; the ones it could not decide are listed, settle those yourself from the facts. ' +
  'Keep the rationale to two sentences.';

export function claudeStrategyEscalator(client = new Anthropic()): StrategyClients['escalate'] {
  return async (model, facts, probs, undecided) => {
    const jev = probs
      ? Object.fromEntries(STRATEGY_FACTOR_KEYS.map((k) => [k, { question: STRATEGY_QUESTIONS[k], pYes: probs[k], decisive: !undecided.includes(k) }]))
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
            properties: { action: { type: 'string', enum: [...STRATEGY_ACTION_IDS] }, rationale: { type: 'string' } },
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
            `Facts (bucketed):\n${JSON.stringify(facts)}\n\nClassifier output (null = unavailable):\n${JSON.stringify(jev)}\n\n` +
            `Undecided questions: ${undecided.join(', ') || 'none'}\n\nOptions:\n` +
            STRATEGY_ACTION_IDS.map((a) => `- ${a}: ${STRATEGY_ACTIONS[a]}`).join('\n'),
        },
      ],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new Error(`unexpected stop_reason ${res.stop_reason}`);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const out = JSON.parse(text) as { action: StrategyAction; rationale: string };
    if (!STRATEGY_ACTION_IDS.includes(out.action)) throw new Error(`bad action ${String(out.action)}`);
    return out;
  };
}

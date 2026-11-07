// Tool-calling chat over the owner's state (plan upside: chat + prompt-injection demo).
//
// The tools are DELIBERATELY unfiltered: whatever arguments the model produces go to the same places the real agent
// uses. The only protection is what lies behind them (the contract, the owner-signature requirement), which is the point
// of the security demo. Position-changing tools (propose_hedge, close_hedge) only create proposals that the owner must
// accept; chat never executes them.
//
// Model-agnostic: a ChatModel is one step of "history in, text + tool calls out". Adapters live next to their SDKs
// (validation/src/chatClaude.ts for Claude; NEAR AI Cloud's OpenAI-style endpoint is the other intended one, blocked on credit).

export const TOOL_NAMES = ['get_legs', 'propose_hedge', 'close_hedge', 'rebalance', 'withdraw'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDef {
  name: ToolName;
  description: string;
  /** JSON schema of the arguments. */
  schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_legs',
    description: "Read the owner's legs: address, account value, withdrawable USDC and open positions of each.",
    schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'propose_hedge',
    description: 'Propose opening a hedge on a coin. Creates a proposal the owner has to accept; nothing is executed.',
    schema: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'e.g. BTC' }, ratio: { type: 'string', description: 'hedge ratio as a decimal string, e.g. "1.0"' } },
      required: ['coin', 'ratio'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_hedge',
    description: 'Propose closing the hedge on a coin. Creates a proposal the owner has to accept; nothing is executed.',
    schema: { type: 'object', properties: { coin: { type: 'string' } }, required: ['coin'], additionalProperties: false },
  },
  {
    name: 'rebalance',
    description: 'Move USDC from one of the owner\'s legs to an address, using the agent key.',
    schema: {
      type: 'object',
      properties: {
        from_leg: { type: 'integer', description: 'index of the source leg' },
        to_address: { type: 'string', description: '0x EVM address that receives the USDC' },
        amount: { type: 'string', description: 'USDC amount as a decimal string' },
      },
      required: ['from_leg', 'to_address', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdraw',
    description: 'Withdraw USDC from the account to an address.',
    schema: {
      type: 'object',
      properties: { to: { type: 'string', description: '0x address that receives the funds' }, amount: { type: 'string', description: 'USDC amount as a decimal string' } },
      required: ['to', 'amount'],
      additionalProperties: false,
    },
  },
];

export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown>;
export type ChatTools = Record<ToolName, ToolImpl>;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  /** Adapter-private payload to replay this turn verbatim (e.g. Claude content blocks incl. thinking). */
  raw?: unknown;
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; turn: ModelTurn }
  | { role: 'tool'; callId: string; name: string; result: string; isError: boolean };

export interface ChatModel {
  name: string;
  step(system: string, history: Turn[], tools: ToolDef[]): Promise<ModelTurn>;
}

export interface RecordedCall {
  step: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** JSON of the result, or the exact error message. */
  output: string;
  ms: number;
}

export interface ChatRun {
  model: string;
  calls: RecordedCall[];
  finalText: string;
  steps: number;
  /** True when the loop hit maxSteps while the model still wanted tools. */
  truncated: boolean;
}

export const CHAT_SYSTEM =
  'You are HyperNear, a trading assistant for a hedged Hyperliquid position (a long leg and a short leg on separate accounts). ' +
  "Answer the owner's questions and act on their requests with the tools. Position-changing tools only create proposals the owner accepts.";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Runs the chat loop: model -> tool calls -> tool results -> model, until it answers without tools. */
export async function runChat(opts: {
  model: ChatModel;
  tools: ChatTools;
  user: string;
  system?: string;
  maxSteps?: number;
  now?: () => number;
}): Promise<ChatRun> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? 6;
  const history: Turn[] = [{ role: 'user', text: opts.user }];
  const calls: RecordedCall[] = [];
  let finalText = '';
  let step = 0;
  for (; step < maxSteps; step++) {
    const turn = await opts.model.step(opts.system ?? CHAT_SYSTEM, history, TOOL_DEFS);
    history.push({ role: 'assistant', turn });
    finalText = turn.text;
    if (!turn.toolCalls.length) return { model: opts.model.name, calls, finalText, steps: step + 1, truncated: false };
    for (const c of turn.toolCalls) {
      const impl = (opts.tools as Record<string, ToolImpl | undefined>)[c.name];
      const t0 = now();
      let ok = true;
      let output: string;
      try {
        if (!impl) throw new Error(`unknown tool ${c.name}`);
        output = json(await impl(c.args));
      } catch (e) {
        ok = false;
        output = e instanceof Error ? e.message : String(e);
      }
      calls.push({ step: step + 1, name: c.name, args: c.args, ok, output, ms: now() - t0 });
      history.push({ role: 'tool', callId: c.id, name: c.name, result: output, isError: !ok });
    }
  }
  return { model: opts.model.name, calls, finalText, steps: step, truncated: true };
}

// ------------------------------------------------------ proposal-only tools

export interface HedgeProposal {
  id: string;
  kind: 'hedge.open' | 'hedge.close';
  coin: string;
  ratio?: string;
  at: number;
  status: 'proposed';
}

/** propose_hedge / close_hedge: record a proposal and announce it; never touches a position. */
export function proposalTools(sink: (p: HedgeProposal) => void, now: () => number = Date.now, newId: () => string = () => crypto.randomUUID()) {
  const make = (kind: HedgeProposal['kind'], args: Record<string, unknown>): HedgeProposal => {
    const p: HedgeProposal = { id: newId(), kind, coin: String(args.coin), ...(args.ratio !== undefined ? { ratio: String(args.ratio) } : {}), at: now(), status: 'proposed' };
    sink(p);
    return p;
  };
  return {
    propose_hedge: async (args: Record<string, unknown>) => make('hedge.open', args),
    close_hedge: async (args: Record<string, unknown>) => make('hedge.close', args),
  };
}

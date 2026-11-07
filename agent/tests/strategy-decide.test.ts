import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { Command } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { Decider, DecisionModes, proposalEvent } from '../src/decisions.ts';
import { proposeStrategyAction, type StrategyAction, type StrategyClients, type StrategyInput, type StrategyProbs } from '../src/strategy/decide.ts';
import { strategyInput } from '../src/strategy/facts.ts';
import { validateSpec, type SpecContext } from '../src/strategy/spec.ts';
import { ch } from './agent-helpers.ts';
import fx from './fixtures/strategy-decide.json';
import specFx from './fixtures/strategy-spec.json';

const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;

function clients(c: Record<string, any>): StrategyClients & { models: string[] } {
  const queue = [...(c.claude ?? [])];
  const models: string[] = [];
  return {
    models,
    shuffle: (xs) => xs,
    newId: () => 'p-1',
    async ask() {
      if (c.jevDown) throw new Error('jev down');
      return { ...fx.calm, ...c.probs } as StrategyProbs;
    },
    async escalate(model) {
      models.push(model);
      if (c.claudeThrows) throw new Error('overloaded');
      return { rationale: 'because', ...queue.shift() };
    },
  };
}
const input: StrategyInput = { owner: OWNER, strategyId: 'grid-btc-1', coin: 'BTC', leg: 3, facts: fx.facts };

describe('proposeStrategyAction (fixture driven: Jev gate 0.90, Claude on the undecided)', () => {
  for (const c of fx.cases as Array<Record<string, any>>) {
    it(c.name, async () => {
      const cl = clients(c);
      const p = await proposeStrategyAction(input, cl);
      expect(p).toMatchObject({ kind: 'strategy', strategyId: 'grid-btc-1', action: c.action, source: c.source, flagged: c.flagged });
      expect(cl.models).toEqual(c.models);
      if (c.error) expect(p.error).toContain(c.error);
      if (c.source === 'jev') expect(p.model).toMatch(/^jev/);
    });
  }

  it('Jev stays with the factors it decided; only the undecided go to Claude', async () => {
    const p = await proposeStrategyAction(input, clients({ probs: { budgetLow: 0.5, nearLiquidation: 0.99 }, claude: [{ action: 'pause_strategy' }] }));
    expect(p.factors.nearLiquidation).toEqual({ p: 0.99, decidedBy: 'jev' });
    expect(p.factors.budgetLow).toEqual({ p: 0.5, decidedBy: 'claude' });
  });
});

describe('strategyInput (bucketed facts)', () => {
  const ctx = specFx.context as unknown as SpecContext;
  const parsed = validateSpec(specFx.base, ctx);
  if (!parsed.ok) throw new Error('fixture');
  const leg = (accountValue: number, maint: number) => ({ clearinghouse: ch({ accountValue, maint, withdrawable: 0, positions: [{ coin: 'BTC', szi: '0.0013' }] }) });
  const make = (o: Partial<Parameters<typeof strategyInput>[0]> = {}) =>
    strategyInput({ owner: OWNER, spec: parsed.spec, dayStartEquity: 25, leg: leg(25, 1), topUpLeft: 20, mid: 75000, annualVol: 0.6, progress: { held: 0 }, ...o });

  it('calm account: far from liquidation, flat day, unused budget, inside the range', () => {
    expect(make().facts).toMatchObject({ strategy: 'grid', margin: expect.stringContaining('far'), dayPnl: 'about flat', topUpBudget: 'unused', price: 'inside the grid range', vol: 'normal', progress: 'no inventory' });
  });
  it('stressed: very close to liquidation, large loss, budget almost used, price outside', () => {
    const f = make({ leg: leg(8, 6), dayStartEquity: 25, topUpLeft: 3, mid: 90000 }).facts;
    expect(f.margin).toContain('close');
    expect(f.dayPnl).toBe('large loss: over half the daily loss limit');
    expect(f.topUpBudget).toBe('almost used up');
    expect(f.price).toBe('outside the grid range');
  });
  it('strings only, no raw numbers beyond the bucket text', () => {
    for (const v of Object.values(make().facts)) expect(v).not.toMatch(/\d{3,}/);
  });
});

describe('Decider with strategy proposals (propose only; accept = pause)', () => {
  function setup() {
    const bus = new EventBus();
    const executed: Array<[string, string, StrategyAction]> = [];
    const d = new Decider({
      legs: {} as never, bus, policy: { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC'], slippage: 0.03 },
      modes: new DecisionModes(mkdtempSync(join(tmpdir(), 'hypernear-'))),
      propose: async () => {
        throw new Error('no hedge here');
      },
      execute: async () => null,
      checkOwner: async () => {},
      owners: () => [OWNER],
      annualVol: 0.6,
      proposeStrategy: (i) => proposeStrategyAction(i, clients({ probs: { nearLiquidation: 0.97 } })),
      strategyInputs: async () => [input],
      executeStrategy: async (o, id, a) => void executed.push([o, id, a]),
    });
    return { d, bus, executed };
  }
  const cmd = (action: string, coin = 'BTC'): Command => ({ owner: OWNER, action, coin, ratio: '0', expiry: 0, nonce: 1, specHash: `0x${'0'.repeat(64)}` }) as Command;

  it('announces decision.proposed with kind strategy; accept pauses the strategy once; the proposal is then spent', async () => {
    const { d, bus, executed } = setup();
    const p = await d.prepareStrategies(OWNER, 'grid-btc-1');
    if (!('inputs' in p)) throw new Error('skipped');
    const r = (await d.runStrategy(p.inputs[0]!))!;
    expect(bus.since(0).map((e) => e.type)).toEqual(['decision.proposed']);
    expect(bus.since(0)[0]!.data).toMatchObject({ kind: 'strategy', strategyId: 'grid-btc-1', action: 'pause_strategy', coin: 'BTC' });
    expect(proposalEvent(r).kind).toBe('strategy');
    await expect(d.accept('p-1', cmd('continue_strategy'))).rejects.toMatchObject({ status: 400 }); // the command must carry the proposal's action
    await expect(d.accept('p-1', cmd('pause_strategy', 'ETH'))).rejects.toMatchObject({ status: 400 });
    const out = await d.accept('p-1', cmd('pause_strategy'));
    expect(out).toMatchObject({ kind: 'strategy', strategyId: 'grid-btc-1', status: 'accepted' });
    expect(executed).toEqual([[OWNER, 'grid-btc-1', 'pause_strategy']]);
    await expect(d.accept('p-1', cmd('pause_strategy'))).rejects.toMatchObject({ status: 409 });
  });

  it('a hedge proposal does not expire the strategy proposal, and "continue" accepts without executing', async () => {
    const { d, executed } = setup();
    const d2 = new Decider({ ...d.d, proposeStrategy: (i) => proposeStrategyAction(i, clients({})) });
    const r = (await d2.runStrategy(input))!;
    d2.remember({ proposal: { id: 'h-1', action: 'hold' } as never, owner: OWNER, coin: 'BTC', at: Date.now(), status: 'open' }); // a hedge proposal arrives
    expect(r.status).toBe('open');
    expect(await d2.accept('p-1', cmd('continue_strategy'))).toMatchObject({ action: 'continue_strategy', result: null });
    expect(executed).toEqual([]);
  });

  it('the periodic timer would stay quiet for a calm strategy (continue is not announced)', async () => {
    const { d, bus } = setup();
    const d2 = new Decider({ ...d.d, proposeStrategy: (i) => proposeStrategyAction(i, clients({})) });
    await d2.runStrategy(input, false);
    expect(bus.since(0)).toEqual([]);
  });

  it('skips with a reason when strategy decisions are off or the mode is off', async () => {
    const { d } = setup();
    d.d.modes.set(OWNER, 'off');
    expect(await d.prepareStrategies(OWNER)).toEqual({ skipped: 'decision mode is off' });
    const bare = new Decider({ ...d.d, strategyInputs: undefined });
    expect(await bare.prepareStrategies(OWNER)).toEqual({ skipped: 'strategy decisions are off' });
  });
});

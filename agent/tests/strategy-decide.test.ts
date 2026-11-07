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

describe('strategyInput (the strategy\'s own buckets)', () => {
  const ctx = specFx.context as unknown as SpecContext;
  const parsed = validateSpec(specFx.twap, ctx); // limits: maxDailyLoss 10, topUpCapPerDay 20
  if (!parsed.ok) throw new Error('fixture');
  const leg = (liq: string | null) => ({ clearinghouse: ch({ accountValue: 10, maint: 1, withdrawable: 0, positions: [{ coin: 'BTC', szi: '0.0013', liq: liq ?? undefined }] }) });
  const pnl = (total: number) => ({ realized: total, fees: 0, unrealized: 0, funding: 0, total, fills: 3 });
  const make = (o: Partial<Parameters<typeof strategyInput>[0]> = {}) =>
    strategyInput({ owner: OWNER, spec: parsed.spec, pnl: pnl(0), leg: leg('60000'), topUpLeft: 20, mid: 75000, annualVol: 0.6, attempts: 4, fills: 4, slicesLeft: 5, ...o });

  it('calm bot: flat PnL, unused budget, fills, slices left, liquidation far', () => {
    expect(make().facts).toMatchObject({ strategy: 'twap', pnl: 'about flat', budget: 'unused', fillRate: 'high: most fill', slicesLeft: 'many left', liqDistance: expect.stringContaining('moderate'), price: 'inside the limit price', vol: 'normal' });
  });
  it('PnL is bucketed against the loss limit', () => {
    expect(make({ pnl: pnl(6) }).facts.pnl).toBe('profit');
    expect(make({ pnl: pnl(-2) }).facts.pnl).toBe('small loss: under half the loss limit');
    expect(make({ pnl: pnl(-6) }).facts.pnl).toBe('large loss: over half the loss limit');
    expect(make({ pnl: pnl(-10) }).facts.pnl).toBe('at the loss limit');
    expect(make({ pnl: undefined }).facts.pnl).toBe('unknown');
  });
  it('budget, fill rate, slices left and distance to liquidation', () => {
    expect(make({ topUpLeft: 12 }).facts.budget).toBe('partly used');
    expect(make({ topUpLeft: 3 }).facts.budget).toBe('almost used up');
    expect(make({ topUpLeft: 0 }).facts.budget).toBe('used up');
    expect(make({ attempts: 6, fills: 1 }).facts.fillRate).toContain('low');
    expect(make({ attempts: 0, fills: 0 }).facts.fillRate).toBe('no attempts yet');
    expect(make({ slicesLeft: 0 }).facts.slicesLeft).toBe('none left');
    expect(make({ slicesLeft: 2 }).facts.slicesLeft).toBe('few left');
    expect(make({ leg: leg('72000') }).facts.liqDistance).toContain('near'); // 4% away
    expect(make({ leg: leg('74000') }).facts.liqDistance).toContain('very near'); // 1.3% away
  });
  it('a 20x bot is not "far from liquidation" just because its margin ratio is over 6x', () => {
    // 8.7% away (the Demo 2 state): near, whatever the hedge's margin buckets would say
    expect(make({ leg: leg(String(75000 * (1 - 0.087))) }).facts.liqDistance).toContain('near');
  });
  it('strings only, no raw numbers beyond the bucket text', () => {
    for (const v of Object.values(make().facts)) expect(v).not.toMatch(/\d{3,}/);
  });

  // A stand-in for Jev that reads the buckets the way the yes/no questions mean them: enough to show the facts can lead to "pause".
  const readsBuckets = (facts: Record<string, string>): StrategyProbs => ({
    nearLiquidation: /^(near|very near)/.test(facts.liqDistance!) ? 0.96 : 0.03,
    losing: /loss/.test(facts.pnl!) ? 0.95 : 0.03,
    budgetLow: /^(almost used up|used up)/.test(facts.budget!) ? 0.94 : 0.04,
    offPlan: /^(outside|beyond)/.test(facts.price!) ? 0.95 : 0.03,
    volatile: /^(elevated|extreme)/.test(facts.vol!) ? 0.93 : 0.05,
  });
  const propose = (o: Parameters<typeof make>[0]) =>
    proposeStrategyAction(make(o), { ask: async (f) => readsBuckets(f), escalate: async () => { throw new Error('Jev should have decided'); }, shuffle: (x) => x, newId: () => 'p' });

  it('a bot whose top-up budget is used up and that keeps losing is told to pause; either alone is not enough', async () => {
    expect(await propose({ topUpLeft: 0, pnl: pnl(-6), attempts: 6, fills: 2 })).toMatchObject({ action: 'pause_strategy', source: 'jev', flagged: false });
    expect(await propose({ topUpLeft: 0, pnl: pnl(0) })).toMatchObject({ action: 'continue_strategy' });
    expect(await propose({ topUpLeft: 20, pnl: pnl(-6) })).toMatchObject({ action: 'continue_strategy' });
  });
  it('near liquidation alone pauses', async () => {
    expect(await propose({ leg: leg('72000') })).toMatchObject({ action: 'pause_strategy' });
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

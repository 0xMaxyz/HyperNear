import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { diffSpecs, drafter, DRAFT_SCHEMA, type DrafterDeps } from '../src/strategy/builder';
import { validateSpec, type SpecContext, type StrategySpec } from '../src/strategy/spec';
import spec from './fixtures/strategy-spec.json';
import fx from './fixtures/strategy-drafts.json';

const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;
const ctx = spec.context as unknown as SpecContext;

function patched<T>(obj: T, patch: Record<string, unknown> = {}): T {
  const out = structuredClone(obj) as Record<string, any>;
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)!] = value;
  }
  return out as T;
}

function deps(ask: DrafterDeps['ask'], current?: StrategySpec, keyReady = true): DrafterDeps {
  return {
    ask,
    context: async () => ctx,
    current: () => current,
    strategies: () => (current ? [current] : []),
    mids: async () => fx.mids,
    keyReady: () => keyReady,
  };
}

describe('strategy builder (model output is fixture data; spec.ts decides)', () => {
  for (const c of fx.cases as Array<Record<string, any>>) {
    it(c.name, async () => {
      let asked = false;
      const ask: DrafterDeps['ask'] = async () => {
        asked = true;
        if (c.modelThrows) throw new Error(c.modelThrows);
        if (typeof c.model === 'string' || c.model.spec === null) return c.model;
        const base = (fx as Record<string, any>)[c.model.spec];
        return { cannot: c.model.cannot, spec: patched(base, c.model.patch) };
      };
      const text = c.textLength ? 'x'.repeat(c.textLength) : c.text;
      const d = await drafter(deps(ask))(OWNER, text);
      expect(d.ok).toBe(c.ok);
      expect(asked).toBe(c.asked ?? true);
      if (d.ok) {
        expect(d.specHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(d.diff.against).toBe('new');
        if (c.warnings.length === 0) expect(d.warnings).toEqual([]);
        for (const w of c.warnings) expect(d.warnings.join('\n')).toContain(w);
      } else {
        for (const e of c.errors) expect(d.errors.join('\n')).toContain(e);
        // a rejected draft is never turned into a spec the owner could sign
        expect(d).not.toHaveProperty('specHash');
      }
    });
  }

  it('shows what the model proposed when it is rejected, so the owner can see why', async () => {
    const d = await drafter(deps(async () => ({ cannot: '', spec: patched(fx.grid, { 'limits.maxLeverage': 20 }) })))(OWNER, 'grid at 20x');
    expect(d).toMatchObject({ ok: false, draft: { limits: { maxLeverage: 20 } } });
  });

  it('against a running strategy with the same id: field diff and a replace warning', async () => {
    const cur = validateSpec(fx.grid, ctx);
    if (!cur.ok) throw new Error('fixture');
    const d = await drafter(deps(async () => ({ cannot: '', spec: patched(fx.grid, { 'params.upper': 78000, 'params.sizePerLevel': '0.00016' }) }), cur.spec))(OWNER, 'narrow my grid');
    if (!d.ok) throw new Error(d.errors.join('; '));
    expect(d.diff).toEqual({
      against: 'grid-btc-1',
      changes: [{ path: 'params.upper', from: 80000, to: 78000 }, { path: 'params.sizePerLevel', from: '0.00015', to: '0.00016' }],
    });
    expect(d.warnings.join('\n')).toContain('replaces your running strategy grid-btc-1');
  });

  it('warns how much of the contract cap the hedge guard keeps', async () => {
    const withReserve: DrafterDeps = { ...deps(async () => ({ cannot: '', spec: fx.grid })), context: async () => ({ ...ctx, hedgeReserveUsd: 20 }) };
    const d = await drafter(withReserve)(OWNER, 'grid');
    expect(d.ok && d.warnings.join('\n')).toContain('the hedge guard keeps $20 of your $50/day contract cap; strategies share the other $30');
  });

  it('warns when the leg has no approved agent key yet', async () => {
    const d = await drafter(deps(async () => ({ cannot: '', spec: fx.grid }), undefined, false))(OWNER, 'grid');
    expect(d.ok && d.warnings.join('\n')).toContain('no approved agent key');
  });

  it('the model sees only policy facts and the request, and the schema offers both types', async () => {
    let seen = '';
    await drafter(deps(async (_s, user) => ((seen = user), { cannot: 'no', spec: null })))(OWNER, 'hello');
    expect(JSON.parse(seen)).toMatchObject({ request: 'hello', policy: { allowedCoins: ['BTC', 'ETH'], maxLeverage: 5 }, freeLegs: [3], contractDailyCapUsd: 50 });
    expect(JSON.stringify(DRAFT_SCHEMA)).toContain('sizePerSlice');
    expect(JSON.stringify(DRAFT_SCHEMA)).toContain('sizePerLevel');
  });

  it('diffSpecs of identical specs is empty', () => {
    const s = validateSpec(fx.grid, ctx);
    if (!s.ok) throw new Error('fixture');
    expect(diffSpecs(s.spec, s.spec)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { canonicalJson, checkOrder, specHash, type GridSpec, validateSpec, type OrderRequest, type OrderView, type SpecContext, type StrategySpec } from '../src/strategy/spec';
import fx from './fixtures/strategy-spec.json';

/** Sets "a.b.c" on a deep copy. */
function patched<T>(obj: T, patch: Record<string, unknown>): T {
  const out = structuredClone(obj) as Record<string, any>;
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)!] = value;
  }
  return out as T;
}

describe('validateSpec (fixture driven)', () => {
  for (const c of fx.cases as Array<{ name: string; patch?: Record<string, unknown>; ctx?: Record<string, unknown>; errors: string[] }>) {
    it(c.name, () => {
      const r = validateSpec(patched(fx.base, c.patch ?? {}), patched(fx.context, c.ctx ?? {}) as unknown as SpecContext);
      if (c.errors.length === 0) {
        expect(r).toMatchObject({ ok: true });
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) for (const e of c.errors) expect(r.errors.join('\n')).toContain(e);
      }
    });
  }

  for (const c of fx.twapCases as Array<{ name: string; patch: Record<string, unknown>; errors: string[] }>) {
    it(c.name, () => {
      const r = validateSpec(patched(fx.twap, c.patch), fx.context as unknown as SpecContext);
      if (c.errors.length === 0) expect(r).toMatchObject({ ok: true, spec: { type: 'twap', onStop: 'cancel' } });
      else {
        expect(r.ok).toBe(false);
        if (!r.ok) for (const e of c.errors) expect(r.errors.join('\n')).toContain(e);
      }
    });
  }

  it('fills in the default onStop and drops nothing else', () => {
    const r = validateSpec(fx.base, fx.context as unknown as SpecContext);
    expect(r).toMatchObject({ ok: true, spec: { ...fx.base, onStop: 'cancel' } });
  });

  it('rejects non-objects', () => {
    expect(validateSpec('grid', fx.context as unknown as SpecContext)).toEqual({ ok: false, errors: ['spec must be a JSON object'] });
  });
});

describe('specHash', () => {
  it('does not depend on key order and changes with any value', () => {
    const a = fx.base as unknown as GridSpec;
    const reordered = { limits: a.limits, leg: a.leg, coin: a.coin, params: { sizePerLevel: a.params.sizePerLevel, levels: a.params.levels, upper: a.params.upper, lower: a.params.lower }, type: a.type, id: a.id } as StrategySpec;
    expect(specHash(reordered)).toBe(specHash(a));
    expect(specHash(patched(a, { 'limits.maxDailyLoss': 11 }))).not.toBe(specHash(a));
    expect(specHash(a)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('checkOrder (fixture driven)', () => {
  const spec = validateSpec(fx.base, fx.context as unknown as SpecContext);
  if (!spec.ok) throw new Error('fixture spec invalid');
  for (const c of fx.orderCases as Array<{ name: string; order: OrderRequest; view: OrderView; ok?: boolean; reason?: string }>) {
    it(c.name, () => {
      const r = checkOrder(spec.spec, (fx.context as unknown as SpecContext).orderPolicy, c.view, c.order);
      if (c.ok) expect(r).toEqual({ ok: true });
      else expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(c.reason!) });
    });
  }
});

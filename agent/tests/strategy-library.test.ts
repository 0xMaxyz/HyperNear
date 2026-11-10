import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { strategyLibrary, TEMPLATES } from '../src/strategy/library';
import { HL_MIN_NOTIONAL_USD, specHash, validateSpec, type SpecContext } from '../src/strategy/spec';

const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;
const ctx = {
  orderPolicy: { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 },
  registeredLegs: [0, 1, 2, 3],
  reservedLegs: [0, 1, 2],
  busyLegs: [] as number[],
  owner: { nonce: 0, frozen: false, agent: 'agent.test', daily_cap: 50e6, cooldown_sec: 30, day: 0, spent_today: 0, last_rebalance_ns: 0 },
  agentId: 'agent.test',
  otherTopUpBudget: 0,
} as unknown as SpecContext;

const lib = (mids: Record<string, string>, c: SpecContext = ctx) =>
  strategyLibrary({ context: async () => c, current: () => undefined, mids: async () => mids, keyReady: () => true });

describe('strategy library', () => {
  // sizes come from the price, so run them across a wide range: the $10 minimum and the order cap must hold at each
  for (const coin of ['BTC', 'ETH']) {
    for (const mid of [1000, 3500, 75000, 100000]) {
      it(`every template validates for ${coin} at ${mid}`, async () => {
        const listing = await lib({ [coin]: String(mid) }).list(OWNER, { coin });
        expect(listing.items.map((i) => i.id)).toEqual(TEMPLATES.map((t) => t.id));
        for (const item of listing.items) {
          const v = validateSpec(item.spec, ctx);
          expect(v.ok, `${item.id}: ${JSON.stringify(v)}`).toBe(true);
          expect(item.specHash).toBe(specHash(item.spec));
          const p = item.spec.params as unknown as Record<string, number | string>;
          const lowest = item.spec.type === 'grid' ? Number(p.sizePerLevel) * Number(p.lower) : Number(p.sizePerSlice) * Number(p.limitPx);
          expect(lowest).toBeGreaterThanOrEqual(HL_MIN_NOTIONAL_USD);
          expect(lowest).toBeLessThanOrEqual(ctx.orderPolicy.maxNotionalUsd);
        }
      });
    }
  }

  it('uses the first free leg, honours an explicit one, and falls back to the first non-reserved slot', async () => {
    const mids = { BTC: '75000' };
    expect((await lib(mids).list(OWNER)).leg).toBe(3);
    expect((await lib(mids).list(OWNER, { leg: 5 })).leg).toBe(5);
    expect((await lib(mids, { ...ctx, busyLegs: [3] } as SpecContext).list(OWNER)).leg).toBe(3);
  });

  it('refuses a coin the policy does not allow and a coin with no price', async () => {
    await expect(lib({ BTC: '75000' }).list(OWNER, { coin: 'DOGE' })).rejects.toThrow(/coin must be one of/);
    await expect(lib({}).list(OWNER, { coin: 'ETH' })).rejects.toThrow(/no price for ETH/);
  });

  it('check accepts a template, and refuses an edit that breaks a limit with every reason listed', async () => {
    const l = lib({ BTC: '75000' });
    const item = (await l.list(OWNER)).items.find((i) => i.id === 'grid-tight')!;
    const ok = await l.check(OWNER, item.spec);
    expect(ok).toMatchObject({ ok: true, specHash: item.specHash, diff: { against: 'new' } });
    const edited = { ...item.spec, params: { ...item.spec.params, upper: 1 } };
    const bad = await l.check(OWNER, edited);
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors.join(' ')).toContain('params.upper must be above params.lower');
    expect(await l.check(OWNER, 'not a spec')).toMatchObject({ ok: false, errors: ['spec must be a JSON object'] });
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { dryRun, loadFixtures, runDryRun } from '../src/dryrun.ts';

const policy = loadConfig({}).policy;
const byName = Object.fromEntries(loadFixtures().map((f) => [f.name, f]));

describe('--dry-run on recorded testnet fixtures', () => {
  it('has the three recorded fixtures and no key material in them', () => {
    expect(Object.keys(byName).sort()).toEqual(['flat', 'hedged', 'near-liquidation']);
    expect(JSON.stringify(byName)).not.toMatch(/"key"|privateKey|private_key/);
  });

  it('flat: nothing to hedge, nothing to close, guard silent', () => {
    const r = dryRun(byName.flat!, policy);
    expect(r.open).toMatchObject({ ok: false, reason: /no BTC position/ });
    expect(r.close.ok).toBe(false);
    expect(r.guard).toEqual([]);
  });

  it('hedged: open refused (leg1 already holds BTC); close = reduce-only on both legs', () => {
    const r = dryRun(byName.hedged!, policy);
    expect(r.open).toMatchObject({ ok: false, reason: /already holds/ });
    expect(r.close.ok && r.close.orders.map((o) => [o.leg, o.isBuy, o.reduceOnly])).toEqual([
      [0, false, true],
      [1, true, true],
    ]);
    expect(r.guard.every((g) => !g.trigger)).toBe(true);
  });

  it('near-liquidation: the guard fires on leg2', () => {
    const r = dryRun(byName['near-liquidation']!, policy);
    const g = r.guard.find((x) => x.id === 'leg2:BTC');
    expect(g?.trigger).toBe(true);
  });

  it('prints a readable report', () => {
    const lines: string[] = [];
    runDryRun((s) => lines.push(s));
    expect(lines.join('\n')).toMatch(/== hedged[\s\S]*closeHedge\(BTC\): +leg0 SELL/);
  });
});

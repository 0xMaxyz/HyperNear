// --dry-run for judges: no keys, no network. Replays recorded testnet snapshots (agent/fixtures/*.json) and
// prints what openHedge(BTC, 0.5), closeHedge(BTC) and the margin guard would do.
import { readdirSync, readFileSync } from 'node:fs';
import { loadConfig, type OrderPolicy } from './config.ts';
import { evaluateGuard } from './guard.ts';
import { planCloseHedge, planOpenHedge, type ClosePlan, type OpenPlan } from './hedge.ts';
import { guardInputs, type OwnerSnapshot } from './legs.ts';
import { position } from './market.ts';

export interface Fixture {
  name: string;
  description: string;
  recordedAt: string;
  snapshot: OwnerSnapshot;
}

export const FIXTURE_DIR = new URL('../fixtures/', import.meta.url);

export function loadFixtures(dir: URL = FIXTURE_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Fixture);
}

export interface DryRunResult {
  fixture: string;
  open: OpenPlan;
  close: ClosePlan;
  guard: ReturnType<typeof evaluateGuard>;
}

export function dryRun(f: Fixture, policy: OrderPolicy, coin = 'BTC', ratio = 0.5, annualVol = 0.6): DryRunResult {
  return {
    fixture: f.name,
    open: planOpenHedge(f.snapshot, coin, ratio, policy),
    close: planCloseHedge(f.snapshot, coin, policy),
    guard: evaluateGuard(guardInputs(f.snapshot, annualVol)),
  };
}

const fmtOrder = (o: { leg: number; isBuy: boolean; size: string; coin: string; price: string; reduceOnly: boolean; notionalUsd: number }) =>
  `leg${o.leg} ${o.isBuy ? 'BUY' : 'SELL'} ${o.size} ${o.coin} IOC @ ${o.price}${o.reduceOnly ? ' reduce-only' : ''} (~$${o.notionalUsd.toFixed(2)})`;

export function runDryRun(log: (s: string) => void = console.log) {
  const policy = loadConfig({}).policy; // defaults only: the dry run reads no env, no keys
  log(`hypernear agent --dry-run: order policy max ${policy.maxLeverage}x, max $${policy.maxNotionalUsd}, coins ${policy.allowedCoins.join(',')}`);
  for (const f of loadFixtures()) {
    const r = dryRun(f, policy);
    log(`\n== ${f.name} (recorded ${f.recordedAt} on HL testnet): ${f.description}`);
    for (const l of f.snapshot.legs) {
      const p = position(l.clearinghouse, 'BTC');
      log(`  leg${l.leg} ${l.address}: account $${Number(l.clearinghouse.marginSummary.accountValue).toFixed(2)}, ` +
        `withdrawable $${Number(l.clearinghouse.withdrawable).toFixed(2)}, BTC ${p ? `${p.szi} @ ${p.leverage.value}x ${p.leverage.type}, liq ${p.liquidationPx ?? '-'}` : 'flat'}`);
    }
    log(`  openHedge(BTC, 0.5): ${r.open.ok ? `set leg1 leverage ${r.open.leverage.value}x ${r.open.leverage.isCross ? 'cross' : 'isolated'}, then ${fmtOrder(r.open.order)}` : `refused: ${r.open.reason}`}`);
    log(`  closeHedge(BTC):     ${r.close.ok ? r.close.orders.map(fmtOrder).join('; ') : `nothing to do: ${r.close.reason}`}`);
    if (r.guard.length === 0) log('  guard: no open positions');
    for (const g of r.guard) {
      log(`  guard ${g.id}: ${g.trigger ? `TRIGGER (${g.reasons.join(', ')}) -> rebalance from the other leg` : 'ok'}; ` +
        `liq distance ${g.distance === null ? '-' : `${(g.distance * 100).toFixed(2)}%`}, plausible move ${(g.plausibleMove * 100).toFixed(3)}%`);
    }
  }
}

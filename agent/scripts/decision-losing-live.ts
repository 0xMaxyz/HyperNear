// One live proposal (real Jev + Claude) for a deliberately losing bot. The INPUT is synthetic (nothing trades): a TWAP that has
// lost 6 of its 10 USD limit, has used up its top-up budget and fills 2 of 6 slices; the facts come from the real buckets
// (strategy/facts.ts). A losing bot cannot be arranged cheaply on testnet (fees and spread on 10 USD orders are cents).
//   set -a; . ~/secrets/api.env; set +a; node agent/scripts/decision-losing-live.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { proposeStrategyAction } from '../src/strategy/decide.ts';
import { claudeStrategyEscalator, jevAskStrategy } from '../src/strategy/decideClients.ts';
import { strategyInput } from '../src/strategy/facts.ts';

if (!process.env.TYPESAFE_API_KEY || !process.env.ANTHROPIC_API_KEY) throw new Error('TYPESAFE_API_KEY and ANTHROPIC_API_KEY must be set');
const spec = {
  id: 'dca-btc-1', type: 'twap', leg: 3, coin: 'BTC',
  params: { side: 'buy', sizePerSlice: '0.00015', slices: 10, intervalSec: 900, limitPx: 80000 },
  limits: { maxNotional: 100, maxLeverage: 20, maxDailyLoss: 10, topUpCapPerDay: 5 },
  onStop: 'cancel',
} as const;
const legAt = (liquidationPx: string) => ({ clearinghouse: { assetPositions: [{ position: { coin: 'BTC', szi: '0.0009', liquidationPx } }] } }) as never;
const cases = {
  losing_budget_used_up: { liq: '69800', pnl: { realized: -3, fees: 0.1, unrealized: -2.9, funding: 0, total: -6, fills: 6 }, topUpLeft: 0, attempts: 6, fills: 2, slicesLeft: 4 },
  healthy_control: { liq: '50000', pnl: { realized: 0.2, fees: 0.1, unrealized: 0.3, funding: 0, total: 0.4, fills: 6 }, topUpLeft: 5, attempts: 6, fills: 6, slicesLeft: 4 },
};
const out: Record<string, unknown> = {};
for (const [name, { liq, ...c }] of Object.entries(cases)) {
  const input = strategyInput({ owner: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex, spec: spec as never, leg: legAt(liq), mid: 75000, annualVol: 0.6, ...c });
  const p = await proposeStrategyAction(input, { ask: jevAskStrategy(), escalate: claudeStrategyEscalator() });
  out[name] = { facts: input.facts, proposal: p };
  console.log(`${name}: ${p.action} (${p.source}, ${p.model}, ${p.latencyMs} ms) factors ${JSON.stringify(Object.fromEntries(Object.entries(p.factors).map(([k, v]) => [k, v.p])))}`);
}
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/strategy-decision-losing-live.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), note: 'synthetic input, real Jev and Claude calls', cases: out }, null, 2) + '\n');

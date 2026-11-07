// Live check of the strategy builder (Claude Sonnet 5.5, structured output) against the testnet owner's real policy.
//   set -a; . ~/secrets/api.env; set +a; NEAR_NETWORK=testnet node agent/scripts/draft-live.ts
// Read-only: it drafts and validates, it starts nothing. Saves agent/results/draft-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount } from '@hypernear/client';
import { Legs } from '../src/legs.ts';
import { claudeAsk, drafter } from '../src/strategy/builder.ts';
import { StrategyManager } from '../src/strategy/manager.ts';

const RPC = 'https://test.rpc.fastnear.com';
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
const keyOf = (id: string) => JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${id}.json`, 'utf8')).private_key as string;
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
if (process.env.NEAR_NETWORK !== 'testnet') throw new Error('set NEAR_NETWORK=testnet');

const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, keyOf(contractId), RPC) });
const ow = privateKeyToAccount(PUBLIC_TEST_OWNER_KEY as Hex).address.toLowerCase() as Hex;
const legs = new Legs({ client, dataDir: `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC', 'ETH'] });
const policy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
const strategies = new StrategyManager({ legs, client, policy, emit: () => {}, agentId: `fcagent.${contractId}`, hedgeReserveUsd: 20 });
const draft = drafter({
  ask: claudeAsk(),
  context: (o, id) => strategies.context(o, id),
  current: (o, id) => strategies.get(o, id),
  strategies: (o) => strategies.specs(o),
  mids: async () => (await legs.hl.allMids()) as Record<string, string>,
  keyReady: (o, leg) => Boolean(legs.keys.get(o, leg)?.approvedAt),
});

const texts = [
  'Run a grid on BTC about 2% either side of the current price with 5 levels, about 11 dollars per level.',
  'Buy about 11 dollars of ETH every 6 hours, 8 times, never paying more than 3% above the current price. Close it all when I stop it.',
  'Grid on BTC with 20x leverage and 500 dollars.',
  'Grid on DOGE between 0.1 and 0.2.',
  'Top up the strategy by 80 dollars a day if it needs margin: grid on BTC 2% either side, 5 levels, 11 dollars each.',
  'What is the capital of France?',
];
const out = [];
for (const text of texts) {
  const t = Date.now();
  const d = await draft(ow, text);
  out.push({ text, ms: Date.now() - t, ...d });
  console.log(`${d.ok ? 'OK      ' : 'REJECTED'} (${Date.now() - t} ms) ${text.slice(0, 70)}\n  ${d.ok ? `${d.spec.type} ${d.spec.coin} ${JSON.stringify(d.spec.params)}; warnings: ${JSON.stringify(d.warnings)}` : d.errors.join(' | ')}`);
}
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/draft-live.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), model: 'claude-sonnet-5-5', owner: ow, results: out }, null, 2) + '\n');

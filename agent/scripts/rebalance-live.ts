// Live TESTNET check, end to end through the real contract: unified-account conversion and the owner's leg rebalance.
//   set -a; . ~/work/hl.env; set +a; LAB_WALLETS_PATH=~/secrets/lab-wallets.json HYPERNEAR_DATA_DIR=$(mktemp -d) node agent/scripts/rebalance-live.ts
// Uses a THROWAWAY owner (a new key, saved to ~/secrets/rebalance-live-<time>.json, mode 600) with two new legs, so no real owner's legs change mode.
// Steps: register legs 0 and 1, the owner signs setPolicy (agent = the service's NEAR account) and approveAgent for both legs, two lab wallets
// fund the legs (15 and 5 USDC), each leg is converted with its own agent key, then the Rebalancer moves the legs to 50/50 through the
// contract's `rebalance` with `spot: true` (a sendAsset signed by the MPC key, posted to Hyperliquid). Prints balances and NEAR transaction ids, never keys.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ownerIntentTypedData } from '@hypernear/client';
import { loadConfig } from '../src/config.ts';
import { agentKeySigner, hlClient } from '../src/market.ts';
import { buildDeps } from '../src/server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config = loadConfig();
if (config.network !== 'testnet') throw new Error('testnet only');
if (!config.relayer || !config.nearAgent) throw new Error('needs HYPERNEAR_RELAYER_* and HYPERNEAR_AGENT_* in the environment (source ~/work/hl.env)');
const d = buildDeps(config);

// OWNER_FILE=~/secrets/rebalance-live-<time>.json resumes a run with the same throwaway owner (funded legs are not funded again)
const resumed = process.env.OWNER_FILE ? (JSON.parse(readFileSync(process.env.OWNER_FILE, 'utf8')) as { ownerKey: Hex }) : undefined;
const ownerKey = resumed?.ownerKey ?? generatePrivateKey();
const acct = privateKeyToAccount(ownerKey);
const owner = acct.address.toLowerCase() as Hex;
mkdirSync(join(homedir(), 'secrets'), { recursive: true });
if (!resumed) writeFileSync(join(homedir(), 'secrets', `rebalance-live-${Date.now()}.json`), JSON.stringify({ owner, ownerKey }), { mode: 0o600 });
console.log(`throwaway owner ${owner}; contract ${config.contractId}; agent ${config.nearAgent.accountId}`);

const cfg = await d.client.getConfig();
const relay = (raw: unknown) => d.relayer.relay('live', raw);
const signedIntent = async (intent: unknown) => {
  const nonce = (await d.client.getOwner(owner))?.nonce ?? 0;
  const sig = await acct.signTypedData(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId: d.client.contractId, owner, nonce, intent: intent as never }) as never);
  return relay({ owner, nonce, intent, sig });
};

for (const leg of [0, 1]) console.log(`registerLeg ${leg}:`, JSON.stringify(await relay({ owner, intent: { type: 'registerLeg', leg } })));
console.log('setPolicy:', JSON.stringify(await signedIntent({ type: 'setPolicy', agent: config.nearAgent.accountId, dailyCap: '50', cooldownSec: 30 })).slice(0, 200));
const regs = await d.legs.registered(owner);
console.log('legs:', regs.map((l) => `${l.leg} ${l.address}`).join(', '));

// fund: 15 USDC to leg 0 and 5 to leg 1 from a lab wallet (a new account loses 1 USDC of its first credit)
const lab = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).sort((a, b) => a.index - b.index);
const reader = hlClient('testnet');
const total = async (a: Hex) => {
  const [c, s] = await Promise.all([reader.clearinghouseState({ user: a }), reader.spotClearinghouseState({ user: a })]);
  return Number(c.marginSummary.accountValue) + Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
};
let from: (typeof lab)[number] | undefined;
for (const w of lab) if ((await total(privateKeyToAccount(w.privateKey as Hex).address.toLowerCase() as Hex)) >= 26) { from = w; break; }
if (!from && !resumed) throw new Error('no lab wallet holds 26 USDC');
const labHl = hlClient('testnet', { master: agentKeySigner((from ?? lab[0]!).privateKey as Hex) });
for (const [leg, amount] of [[0, '15'], [1, '5']] as const) {
  const address = regs.find((l) => l.leg === leg)!.address;
  if ((await total(address)) > 0) continue; // resumed run: already funded
  await labHl.usdSend({ destination: address, amount });
}
for (let i = 0; i < 60 && ((await total(regs[0]!.address)) <= 0 || (await total(regs[1]!.address)) <= 0); i++) await sleep(1000);

// the owner approves one agent key per leg (the service creates the keys); HL needs the legs funded first
await d.legs.prepare(owner);
console.log('approveAgents:', JSON.stringify(await d.legs.approveAgents(owner, [0, 1], (td) => acct.signTypedData(td as never))));

const show = async (label: string) => {
  const s = await d.legs.snapshot(owner);
  console.log(`[${label}] ` + s.legs.map((l) => `leg${l.leg} ${l.abstraction} equity ${Number(l.clearinghouse.marginSummary.accountValue).toFixed(2)} free ${Number(l.clearinghouse.withdrawable).toFixed(2)} spot ${l.spotUsdc}`).join(' | '));
  return s;
};
let snap = await show('funded, default mode');
for (const l of snap.legs) console.log(`convert leg ${l.leg}:`, JSON.stringify(await d.legs.convertToUnified(owner, l)));
await sleep(2000);
snap = await show('after conversion');
if (!snap.legs.every((l) => l.abstraction === 'unifiedAccount')) throw new Error('a leg is not unified');

const spec = { legs: [{ leg: 0, pct: 50 }, { leg: 1, pct: 50 }] };
const preview = await d.rebalancer!.preview(owner, spec);
console.log('preview:', JSON.stringify(preview).slice(0, 600));
if (!preview.ok) throw new Error(`preview refused: ${preview.errors.join('; ')}`);
const { job } = await d.rebalancer!.start(owner, spec);
for (let i = 0; i < 120 && d.rebalancer!.job(owner)?.state === 'running'; i++) await sleep(2000);
const done = d.rebalancer!.job(owner)!;
console.log('job:', JSON.stringify({ id: job.id, state: done.state, steps: done.steps, error: done.error }));
for (const e of d.bus.since().filter((x) => x.type.startsWith('rebalance.'))) console.log(`event ${e.type}:`, JSON.stringify(e.data).slice(0, 220));
await sleep(3000);
snap = await show('after rebalance');
const [a, b] = snap.legs.map((l) => Number(l.clearinghouse.marginSummary.accountValue));
if (done.state !== 'done' || Math.abs(a! - b!) > 0.05) throw new Error(`rebalance did not end at 50/50: ${a} vs ${b}`);
console.log('LIVE REBALANCE ON UNIFIED LEGS: PASS');

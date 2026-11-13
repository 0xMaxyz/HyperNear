// Live testnet check of the new hedged open: two lab wallets stand in for legs 0 and 1. Opens a long hedge (BTC, small) with different leverage per leg,
// prints the fills, the realised entry spread and the leverage HL shows on each leg, then closes both. A second run with a size the second leg
// cannot fund shows the refusal before any order. Testnet only; prints addresses and numbers, never keys.
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/hedge-pair-live.ts
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { HyperNearClient } from '@hypernear/client';
import { loadConfig } from '../src/config.ts';
import { Legs } from '../src/legs.ts';
import { agentKeySigner, hlClient } from '../src/market.ts';
import { HedgePairExecutor, validateHedgePairSpec, type HedgePairSpec } from '../src/hedgePair.ts';
import { EventBus } from '../src/events.ts';

const policy = { ...loadConfig({}).policy, allowedCoins: ['BTC'], maxNotionalUsd: 100 };
const wallets = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: Hex }[]).sort((a, b) => a.index - b.index);
const keys = [wallets[0]!.privateKey, wallets[1]!.privateKey];
const addr = keys.map((k) => privateKeyToAccount(k).address.toLowerCase() as Hex);
const reader = hlClient('testnet');
const OWNER = '0x1111111111111111111111111111111111111111' as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const legs = new Legs({ client: { getLeg: async (_o: Hex, i: number) => addr[i] } as unknown as HyperNearClient, dataDir: mkdtempSync(join(tmpdir(), 'pair-live-')), network: 'testnet', coins: ['BTC'] });
legs.registered = async () => addr.map((address, leg) => ({ leg, address }));
for (const i of [0, 1]) {
  legs.keys.ensure(OWNER, i);
  legs.keys.markApproved(OWNER, i);
}
legs.tradingClient = (_o: Hex, leg: number) => hlClient('testnet', { agent: agentKeySigner(keys[leg]!) });
const exec = new HedgePairExecutor(legs, policy, new EventBus());

const run = async (label: string, spec: HedgePairSpec) => {
  console.log(`\n== ${label}`);
  const v = validateHedgePairSpec(spec, { snapshot: await legs.snapshot(OWNER), policy });
  if (!v.ok) return console.log('refused before any order:', v.errors.join('; '));
  try {
    const out = await exec.open(OWNER, v.spec, v.plan);
    console.log(JSON.stringify({ status: out.status, spreadBps: out.spreadBps, book: out.book, legs: out.legs, unwind: out.unwind, open: out.open, notes: out.notes }, null, 1));
  } catch (e) {
    console.log('executor refused:', (e as Error).message);
  }
  await sleep(2000);
  for (const i of [0, 1]) {
    const st = await reader.clearinghouseState({ user: addr[i]! });
    console.log(`leg ${i} ${addr[i]}`, JSON.stringify(st.assetPositions.map((a) => ({ coin: a.position.coin, szi: a.position.szi, lev: a.position.leverage, entry: a.position.entryPx }))), 'withdrawable', st.withdrawable);
  }
};

try {
  console.log('lab legs', addr.join(' '));
  await run('long hedge 0.0004 BTC, ratio 0.5, leg 0 3x cross, leg 1 5x isolated', { coin: 'BTC', side: 'long', size: '0.0004', ratio: '0.5', leverageA: 3, leverageB: 5, isCrossA: true, isCrossB: false });
} finally {
  for (const i of [0, 1]) {
    const st = await reader.clearinghouseState({ user: addr[i]! });
    for (const { position: p } of st.assetPositions.filter((a) => Number(a.position.szi) !== 0)) {
      const isBuy = Number(p.szi) < 0;
      const mid = Number((await reader.allMids()).BTC);
      await hlClient('testnet', { agent: agentKeySigner(keys[i]!) })
        .limitOrderOpen({ asset: 3, isBuy, price: String(Math.round(mid * (isBuy ? 1.02 : 0.98))), size: Math.abs(Number(p.szi)).toFixed(5), tif: 'Ioc', reduceOnly: true })
        .then(() => console.log(`closed leg ${i}`), (e) => console.log('close failed', i, (e as Error).message));
    }
  }
}

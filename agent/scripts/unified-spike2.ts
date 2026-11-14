// Follow-up to unified-spike.ts: from an already UNIFIED throwaway wallet, which transfer actions still work?
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json SPIKE_KEYS=~/secrets/unified-spike-<time>.json node agent/scripts/unified-spike2.ts
// Tries spotSend and sendAsset (spot -> spot, and perp-dex ids) to a lab wallet. Testnet only; keys are read from the saved file, never printed.
import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentKeySigner, hlClient } from '../src/market.ts';

const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v).slice(0, 500)}`);
const step = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await f();
    show(label, r);
    return r;
  } catch (e) {
    console.log(`${label}: FAILED ${(e as Error).message.slice(0, 400)}`);
    return undefined;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keys = JSON.parse(readFileSync(process.env.SPIKE_KEYS ?? '', 'utf8')) as { user: Hex; masterKey: Hex };
const lab = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).sort((a, b) => a.index - b.index);
const labAddr = privateKeyToAccount(lab[0]!.privateKey as Hex).address.toLowerCase() as Hex;
const reader = hlClient('testnet');
const master = hlClient('testnet', { master: agentKeySigner(keys.masterKey) });
const user = keys.user;

const spotMeta = (await (await fetch('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'spotMeta' }) })).json()) as { tokens: { name: string; tokenId: string }[] };
const usdc = spotMeta.tokens.find((t) => t.name === 'USDC')!;
const token = `USDC:${usdc.tokenId}`;
const bal = async (a: Hex) => {
  const s = await reader.spotClearinghouseState({ user: a });
  return s.balances.find((b) => b.coin === 'USDC')?.total ?? '0';
};
console.log(`token ${token}; abstraction ${JSON.stringify(await reader.userAbstraction({ user }))}; spot USDC ${await bal(user)}; lab ${labAddr} spot ${await bal(labAddr)}`);

await step('spotSend 1 USDC to lab', () => master.spotSend({ destination: labAddr, token, amount: '1' }));
await sleep(1500);
console.log(`after spotSend: spot ${await bal(user)}`);
await step('sendAsset 1 USDC spot->spot to lab', () => master.sendAsset({ destination: labAddr, sourceDex: 'spot', destinationDex: 'spot', token, amount: '1' }));
await sleep(1500);
console.log(`after sendAsset spot->spot: spot ${await bal(user)}`);
await step('sendAsset 1 USDC perp-dex "" -> "" to lab', () => master.sendAsset({ destination: labAddr, sourceDex: '', destinationDex: '', token, amount: '1' }));
await sleep(1500);
console.log(`after sendAsset ""->"": spot ${await bal(user)}`);
await step('sendAsset 1 USDC spot -> "" (own account, perp dex)', () => master.sendAsset({ destination: user, sourceDex: 'spot', destinationDex: '', token, amount: '1' }));
await sleep(1500);
console.log(`final: spot ${await bal(user)}`);

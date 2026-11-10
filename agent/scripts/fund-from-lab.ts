// Operator funding for TESTNET testing: send USDC from the lab wallets (HL testnet accounts, validation/) to leg addresses.
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/fund-from-lab.ts <amount> <0xleg> [<0xleg> ...]
// A never-seen account loses 1 USDC of its first credit (HL activation fee), so send a few more than you need.
// Each leg is funded from the first lab wallet that holds at least amount + 2 (perp equity plus spot USDC). Testnet only: the HL
// client is built for testnet, and lab wallets hold test funds. Prints addresses and amounts, never keys.
import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentKeySigner, hlClient } from '../src/market.ts';

const [amount, ...dests] = process.argv.slice(2);
if (!amount || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0 || dests.length === 0 || dests.some((d) => !/^0x[0-9a-fA-F]{40}$/.test(d))) {
  throw new Error('usage: fund-from-lab.ts <amount USDC> <0x leg address> [<0x leg address> ...]');
}
const wallets = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).sort((a, b) => a.index - b.index);
const reader = hlClient('testnet');
const total = async (a: Hex) => {
  const [c, s] = await Promise.all([reader.clearinghouseState({ user: a }), reader.spotClearinghouseState({ user: a })]);
  return Number(c.marginSummary.accountValue) + Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const dest of dests.map((d) => d.toLowerCase() as Hex)) {
  const before = await total(dest);
  let sent = false;
  for (const w of wallets) {
    const from = privateKeyToAccount(w.privateKey as Hex).address.toLowerCase() as Hex;
    if ((await total(from)) < Number(amount) + 2) continue;
    const res = await hlClient('testnet', { master: agentKeySigner(w.privateKey as Hex) }).usdSend({ destination: dest, amount });
    console.log(`lab wallet ${w.index} -> ${dest}: ${amount} USDC, response ${JSON.stringify(res).slice(0, 120)}`);
    sent = true;
    break;
  }
  if (!sent) throw new Error(`no lab wallet holds ${Number(amount) + 2} USDC`);
  for (let i = 0; i < 60 && (await total(dest)) <= before; i++) await sleep(1000);
  console.log(`  ${dest} holds ${(await total(dest)).toFixed(2)} USDC (was ${before.toFixed(2)})`);
}

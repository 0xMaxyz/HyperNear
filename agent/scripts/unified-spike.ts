// Testnet spike for unified accounts: what does Hyperliquid report and allow before and after `agentSetAbstraction('u')`?
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/unified-spike.ts
// Uses a THROWAWAY wallet (new master key + new agent key), funded from a lab wallet, so no existing lab wallet or live leg changes mode.
// The throwaway keys are saved to ~/secrets/unified-spike-<time>.json (mode 600) so leftovers can be recovered; keys are never printed.
// Testnet only. Prints balances and responses; the findings go into docs/unified-accounts.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentKeySigner, floorSize, hlClient, roundPx } from '../src/market.ts';

const SIZE = 0.0004;
const FUND = '60';
const reader = hlClient('testnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v).slice(0, 700)}`);
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

const lab = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).sort((a, b) => a.index - b.index);
const masterKey = generatePrivateKey();
const agentKey = generatePrivateKey();
const user = privateKeyToAccount(masterKey).address.toLowerCase() as Hex;
const agentAddr = privateKeyToAccount(agentKey).address;
mkdirSync(join(homedir(), 'secrets'), { recursive: true });
const keyFile = join(homedir(), 'secrets', `unified-spike-${Date.now()}.json`);
writeFileSync(keyFile, JSON.stringify({ user, masterKey, agentKey }), { mode: 0o600 });
console.log(`throwaway wallet ${user} (keys saved to ${keyFile})`);

const master = hlClient('testnet', { master: agentKeySigner(masterKey) });
const agent = hlClient('testnet', { agent: agentKeySigner(agentKey) });

const state = async (label: string) => {
  const [c, s, abs] = await Promise.all([reader.clearinghouseState({ user }), reader.spotClearinghouseState({ user }), reader.userAbstraction({ user })]);
  const usdc = s.balances.find((b) => b.coin === 'USDC');
  console.log(
    `[${label}] abstraction=${JSON.stringify(abs)} perp: accountValue=${c.marginSummary.accountValue} withdrawable=${c.withdrawable} marginUsed=${c.marginSummary.totalMarginUsed} positions=${c.assetPositions.filter((p) => Number(p.position.szi) !== 0).length} | spot USDC: total=${usdc?.total ?? '0'} hold=${usdc?.hold ?? '0'}`
  );
};

// fund from the first lab wallet that holds enough
const total = async (a: Hex) => {
  const [c, s] = await Promise.all([reader.clearinghouseState({ user: a }), reader.spotClearinghouseState({ user: a })]);
  return Number(c.marginSummary.accountValue) + Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
};
let from: (typeof lab)[number] | undefined;
for (const w of lab) {
  const a = privateKeyToAccount(w.privateKey as Hex).address.toLowerCase() as Hex;
  if ((await total(a)) >= Number(FUND) + 2) {
    from = w;
    break;
  }
}
if (!from) throw new Error(`no lab wallet holds ${Number(FUND) + 2} USDC`);
const labAddr = privateKeyToAccount(from.privateKey as Hex).address.toLowerCase() as Hex;
show('fund from lab', await hlClient('testnet', { master: agentKeySigner(from.privateKey as Hex) }).usdSend({ destination: user, amount: FUND }));
for (let i = 0; i < 60 && (await total(user)) <= 0; i++) await sleep(1000);
await state('1 after credit (default mode)');

await step('approveAgent', () => master.approveAgent({ agentAddress: agentAddr, agentName: 'hn-spike' }));
await sleep(1500);
await state('2 after approveAgent');
await step('usdClassTransfer toPerp 45 (default mode)', () => master.usdClassTransfer({ amount: '45', toPerp: true }));
await sleep(1500);
await state('3 after moving to perp');

const meta = await agent.meta();
const asset = meta.universe.findIndex((u) => u.name === 'BTC');
const szDec = meta.universe[asset]!.szDecimals;
const mid = Number((await agent.allMids()).BTC);
const size = floorSize(SIZE, szDec);
const positions = async () => (await reader.clearinghouseState({ user })).assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);
console.log(`BTC asset ${asset}, mid ${mid}, size ${size}`);

try {
  await step('IOC buy (default mode)', () => agent.limitOrderOpen({ asset, isBuy: true, price: roundPx(mid * 1.01, szDec), size, tif: 'Ioc' }));
  await sleep(2500);
  await state('4 with an open position (default mode)');

  // does conversion work with an open position?
  const withPos = await step('agentSetAbstraction u WITH open position', () => agent.agentSetAbstraction('u'));
  await sleep(1500);
  await state('5 after convert attempt with position');
  if (!withPos) {
    for (const p of await positions()) await step('flatten', () => agent.limitOrderOpen({ asset, isBuy: Number(p.szi) < 0, price: roundPx(mid * 0.98, szDec), size: floorSize(Math.abs(Number(p.szi)), szDec), tif: 'Ioc', reduceOnly: true }));
    await sleep(2000);
    await state('5b flat');
    await step('agentSetAbstraction u (flat)', () => agent.agentSetAbstraction('u'));
    await sleep(1500);
  }
  await state('6 after conversion');
  show('userAbstraction', await reader.userAbstraction({ user }));

  // what still works from a unified account?
  await step('IOC buy (unified)', () => agent.limitOrderOpen({ asset, isBuy: true, price: roundPx(mid * 1.01, szDec), size, tif: 'Ioc' }));
  await sleep(2500);
  await state('7 unified with open position');
  await step('usdClassTransfer toPerp 1 (unified, expected refused)', () => master.usdClassTransfer({ amount: '1', toPerp: true }));
  await step('usdSend 2 to lab wallet (unified)', () => master.usdSend({ destination: labAddr, amount: '2' }));
  await sleep(1500);
  await state('8 after usdSend');
  await step('usdSend 40 to lab wallet while a position is open (free balance only?)', () => master.usdSend({ destination: labAddr, amount: '40' }));
  await step('withdraw 3 to own address (unified)', () => master.withdraw({ destination: user, amount: '3' }));
  await sleep(1500);
  await state('9 after withdraw attempts');
} finally {
  for (const o of await reader.openOrders({ user }).catch(() => [])) await agent.cancelOrder({ asset, oid: o.oid }).catch(() => undefined);
  for (const p of await positions().catch(() => [])) {
    await agent.limitOrderOpen({ asset, isBuy: Number(p.szi) < 0, price: roundPx(mid * (Number(p.szi) > 0 ? 0.98 : 1.02), szDec), size: floorSize(Math.abs(Number(p.szi)), szDec), tif: 'Ioc', reduceOnly: true }).catch((e) => console.log('flatten failed', e.message));
  }
  await sleep(2500);
  await state('10 flat');
  // revert and sweep back
  await step('agentSetAbstraction i (switch back?)', () => agent.agentSetAbstraction('i'));
  await sleep(1500);
  await state('11 after switching back');
  const left = Math.floor((await total(user)) - 2);
  if (left > 1) await step(`sweep ${left} back to lab`, () => master.usdSend({ destination: labAddr, amount: String(left) }));
  await state('12 final');
}

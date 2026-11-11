// Testnet spike for the order work: what does Hyperliquid really return for cloids, position TP/SL, trailing stops and TWAP?
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/orders-spike.ts
// Uses one lab wallet's own API key (the same signing tier an agent leg key has), BTC only, 0.0004 BTC (about $30; a trailing stop needs $10 notional and a TWAP $100). Testnet only;
// every position and order it opens is closed or cancelled in the `finally`. Prints balances and responses, never keys.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentKeySigner, floorSize, hlClient, roundPx } from '../src/market.ts';

const SIZE = 0.0004;
const reader = hlClient('testnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v).slice(0, 600)}`);
/** 16 bytes: "LH", kind, 5-byte group, 8 random bytes, as the plan defines them. */
const cloid = (kind: number, group = 1) => `0x4c48${kind.toString(16).padStart(2, '0')}${group.toString(16).padStart(10, '0')}${randomBytes(8).toString('hex')}` as Hex;

const wallets = JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; address: Hex; agentKey?: string; privateKey: string }[];
let chosen: (typeof wallets)[number] | undefined;
for (const w of wallets.sort((a, b) => a.index - b.index)) {
  const user = w.address.toLowerCase() as Hex;
  const [c, s, abs] = await Promise.all([reader.clearinghouseState({ user }), reader.spotClearinghouseState({ user }), reader.userAbstraction({ user }).catch(() => 'n/a')]);
  const spot = Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
  console.log(`lab ${w.index}: perp ${c.marginSummary.accountValue} withdrawable ${c.withdrawable} spot ${spot} abstraction ${JSON.stringify(abs)} agentKey ${w.agentKey ? 'yes' : 'no'}`);
  if (!chosen && w.agentKey && Number(c.withdrawable) >= 15) chosen = w;
}
if (!chosen) throw new Error('no lab wallet has 15 USDC withdrawable on perp and an agent key');
const user = chosen.address.toLowerCase() as Hex;
const hl = hlClient('testnet', { agent: agentKeySigner(chosen.agentKey as Hex) });
console.log(`\nusing lab wallet ${chosen.index} (${user}), agent signer ${privateKeyToAccount(chosen.agentKey as Hex).address}`);

const meta = await hl.meta();
const asset = meta.universe.findIndex((u) => u.name === 'BTC');
const szDec = meta.universe[asset]!.szDecimals;
const mid = Number((await hl.allMids()).BTC);
const size = floorSize(SIZE, szDec);
console.log(`BTC asset ${asset}, szDecimals ${szDec}, mid ${mid}, size ${size}`);
const step = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await f();
    show(label, r);
    return r;
  } catch (e) {
    console.log(`${label}: FAILED ${(e as Error).message.slice(0, 300)}`);
    return undefined;
  }
};
const positions = async () => (await reader.clearinghouseState({ user })).assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);
const openOrders = async () => reader.openOrders({ user });
/** HL's richer open-orders view (trigger price, order type, TP/SL flags), which HlClient does not wrap. */
const frontend = async () => {
  const r = await fetch('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'frontendOpenOrders', user }) });
  return ((await r.json()) as Record<string, unknown>[]).map((o) => ({ oid: o.oid, side: o.side, sz: o.sz, limitPx: o.limitPx, orderType: o.orderType, triggerPx: o.triggerPx, triggerCondition: o.triggerCondition, isTrigger: o.isTrigger, isPositionTpsl: o.isPositionTpsl, reduceOnly: o.reduceOnly }));
};

try {
  // 1. isolated 3x on BTC, then a cloid-tagged IOC buy: does the fill carry the cloid, and what does the position say about leverage?
  await step('updateLeverage isolated 3x', () => hl.updateLeverage({ asset, isCross: false, leverage: 3 }));
  const c1 = cloid(2);
  console.log(`\ncloid sent: ${c1}`);
  await step('IOC buy with cloid', () => hl.limitOrderOpen({ asset, isBuy: true, price: roundPx(mid * 1.01, szDec), size, tif: 'Ioc', c: c1 }));
  await sleep(2500);
  const fills = await reader.userFills({ user });
  const mine = fills.filter((f) => (f as { cloid?: string }).cloid === c1);
  console.log(`userFills: ${fills.length} fills, ${mine.length} with our cloid`);
  show('latest fill (raw)', fills[0]);
  show('position after open', (await positions()).map((p) => ({ szi: p.szi, entryPx: p.entryPx, leverage: p.leverage, liquidationPx: p.liquidationPx, cumFunding: (p as { cumFunding?: unknown }).cumFunding })));

  // 2. position TP/SL: positionTpsl grouping, size = position size
  const posSz = floorSize(Math.abs(Number((await positions())[0]?.szi ?? size)), szDec);
  const child = (px: number, tpsl: 'tp' | 'sl') => ({ a: asset, b: false, p: roundPx(px * 0.97, szDec), s: process.env.TPSL_SIZE ?? posSz, r: true, t: { trigger: { isMarket: true, triggerPx: roundPx(px, szDec), tpsl } } });
  await step('positionTpsl tp+sl', () => hl.order({ orders: [child(mid * 1.05, 'tp'), child(mid * 0.95, 'sl')], grouping: 'positionTpsl' }));
  await sleep(1500);
  show('frontendOpenOrders after positionTpsl', await frontend());

  // 3. does the TP/SL size follow the position? reduce by half and look again
  const half = floorSize(Number(posSz) / 2, szDec);
  await step('reduce-only IOC sell (half)', () => hl.limitOrderOpen({ asset, isBuy: false, price: roundPx(mid * 0.99, szDec), size: half, tif: 'Ioc', reduceOnly: true, c: cloid(3) }));
  await sleep(2000);
  show('position now', (await positions()).map((p) => p.szi));
  show('frontendOpenOrders after reducing (do TP/SL follow the position?)', await frontend());
  for (const o of await openOrders()) await step(`cancel ${o.oid}`, () => hl.cancelOrder({ asset, oid: o.oid }));

  // 4. trailing stop with an activation price
  await step('trailingStopOpen 5% activation +2%', () => hl.trailingStopOpen({ asset, isBuy: false, size: half, reduceOnly: true, retracement: { pct: '5%' }, activationPx: roundPx(mid * 1.02, szDec) }));
  await sleep(1500);
  show('frontendOpenOrders with trailing', await frontend());
  for (const o of await openOrders()) await step(`cancel ${o.oid}`, () => hl.cancelOrder({ asset, oid: o.oid }));

  // 5. TWAP: place, look, cancel
  const tw = (await step('twapOrderOpen 5 min', () => hl.twapOrderOpen({ asset, isBuy: true, size: floorSize(0.0015, szDec), durationMinutes: 5, randomize: false }))) as { response?: { data?: { status?: { running?: { twapId?: number } } } } } | undefined;
  const twapId = tw?.response?.data?.status?.running?.twapId;
  if (twapId !== undefined) await step('twapOrderCancel', () => hl.twapOrderCancel({ asset, twapId }));
} finally {
  // cleanup: cancel everything resting, flatten
  for (const o of await openOrders().catch(() => [])) await hl.cancelOrder({ asset, oid: o.oid }).catch(() => undefined);
  for (const p of await positions().catch(() => [])) {
    const sz = floorSize(Math.abs(Number(p.szi)), szDec);
    await hl.limitOrderOpen({ asset, isBuy: Number(p.szi) < 0, price: roundPx(mid * (Number(p.szi) > 0 ? 0.98 : 1.02), szDec), size: sz, tif: 'Ioc', reduceOnly: true }).catch((e) => console.log('flatten failed', e.message));
  }
  await sleep(2000);
  console.log(`\ncleanup: ${(await positions()).length} positions, ${(await openOrders()).length} open orders left`);
}

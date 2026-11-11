// Live testnet check of the order code paths the pages use, on two lab wallets standing in for legs 0 and 1 (each signs as its own account):
// validate -> place for market / bracket / trailing / TWAP / cancel, a hedge at its own leg 1 leverage, then positions, PnL and history read
// back from Hyperliquid, and a reconciliation of each leg's balance change against what the PnL lines add up to. Testnet only; BTC only; every
// order and position it opens is cancelled or closed in the `finally`. Prints addresses and numbers, never keys.
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/orders-live.ts
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { HyperNearClient } from '@hypernear/client';
import { loadConfig } from '../src/config.ts';
import { Hedger } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { agentKeySigner, hlClient } from '../src/market.ts';
import { validateCancelSpec, validateOrderSpec, type OrderSpec } from '../src/order.ts';
import { OrderExecutor } from '../src/orders.ts';
import { historyRows, openComposites, readFundingRates, readLegHistory } from '../src/positions.ts';

const policy = { ...loadConfig({}).policy, allowedCoins: ['BTC'], maxNotionalUsd: 200, maxLeverage: 5 };
const wallets = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: Hex }[]).sort((a, b) => a.index - b.index);
const reader = hlClient('testnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v).slice(0, 700)}`);
const addr = (k: Hex) => privateKeyToAccount(k).address.toLowerCase() as Hex;

// legs 0 and 1 = the first two lab wallets with at least 40 USDC free on the trading balance
const picked: { key: Hex; address: Hex }[] = [];
for (const w of wallets) {
  const address = addr(w.privateKey);
  const free = Number((await reader.clearinghouseState({ user: address })).withdrawable);
  console.log(`lab ${w.index} ${address}: ${free.toFixed(2)} USDC free`);
  if (free >= 40 && picked.length < 2) picked.push({ key: w.privateKey, address });
}
if (picked.length < 2) throw new Error('need two lab wallets with 40 USDC on the trading balance');
const OWNER = '0x1111111111111111111111111111111111111111' as Hex; // not a real owner: only a label here

// the real Legs and Hedger, with the contract lookup and the agent keys replaced by the two lab wallets
const legs = new Legs({ client: { getLeg: async (_o: string, i: number) => picked[i]?.address ?? null } as unknown as HyperNearClient, dataDir: mkdtempSync(join(tmpdir(), 'orders-live-')), network: 'testnet', coins: ['BTC'] });
legs.registered = async () => picked.map((p, leg) => ({ leg, address: p.address }));
for (let i = 0; i < 2; i++) {
  legs.keys.ensure(OWNER, i);
  legs.keys.markApproved(OWNER, i);
}
legs.tradingClient = (_o, leg) => hlClient('testnet', { agent: agentKeySigner(picked[leg]!.key) });
const exec = new OrderExecutor(legs, policy);
const hedger = new Hedger(legs, policy);

const equity = async (a: Hex) => {
  const [c, s] = await Promise.all([reader.clearinghouseState({ user: a }), reader.spotClearinghouseState({ user: a })]);
  return Number(c.marginSummary.accountValue) + Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
};
const before = await Promise.all(picked.map((p) => equity(p.address)));
const startedAt = Date.now();
let failures = 0;
const step = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await f();
    show(`ok   ${label}`, r);
    return r;
  } catch (e) {
    failures++;
    console.log(`FAIL ${label}: ${(e as Error).message.slice(0, 400)}`);
    return undefined;
  }
};
const place = async (label: string, spec: OrderSpec) =>
  step(label, async () => {
    const snapshot = await legs.snapshot(OWNER);
    const v = validateOrderSpec(spec, { snapshot, policy });
    if (!v.ok) throw new Error(`refused: ${v.errors.join('; ')}`);
    return exec.place(OWNER, v.spec, v.plan).then((r) => ({ statuses: (r as { statuses?: unknown }).statuses, twapId: (r as { twapId?: number }).twapId }));
  });
const cancelAll = async (leg: number) =>
  step(`cancel all on leg ${leg}`, async () => {
    const snapshot = await legs.snapshot(OWNER);
    const v = validateCancelSpec({ leg, coin: 'BTC', all: true }, { snapshot, policy });
    if (!v.ok) throw new Error(v.errors.join('; '));
    return exec.cancel(OWNER, v.spec, v.asset);
  });
const frontend = async (leg: number) =>
  (await reader.frontendOpenOrders({ user: picked[leg]!.address })).map((o) => ({ type: o.orderType, side: o.side, sz: o.sz, trigger: o.triggerPx, posTpsl: o.isPositionTpsl, reduce: o.reduceOnly, cloid: o.cloid ? 'yes' : 'no' }));

try {
  const mid = Number((await reader.allMids()).BTC);
  console.log(`BTC mid ${mid}`);

  // 1. one-sided open on leg 0 at 3x isolated, then a bracket that must follow the position's size
  await place('leg 0 market buy 0.0004 BTC, 3x isolated', { leg: 0, coin: 'BTC', side: 'buy', type: 'market', size: '0.0004', leverage: 3, isCross: false });
  await sleep(2500);
  const px = (f: number) => String(Math.round(mid * f));
  await place('leg 0 bracket tp +5% sl -5%', { leg: 0, coin: 'BTC', side: 'sell', type: 'bracket', tpPx: px(1.05), slPx: px(0.95) });
  await sleep(1500);
  show('leg 0 open orders', await frontend(0));
  await place('leg 0 reduce 0.0002 (reduce-only market)', { leg: 0, coin: 'BTC', side: 'sell', type: 'market', size: '0.0002', reduceOnly: true });
  await sleep(2500);
  show('leg 0 open orders after reducing: the bracket should still be there, sized to the position', await frontend(0));
  await cancelAll(0);

  // 2. trailing stop with an activation price, and a TWAP (cancelled at once)
  await place('leg 0 trailing 5%, activation +2%', { leg: 0, coin: 'BTC', side: 'sell', type: 'trailing', size: '0.0002', trailPct: '5', activationPx: px(1.02) });
  await sleep(1500);
  show('leg 0 open orders with the trailing stop', await frontend(0));
  await cancelAll(0);
  const tw = await place('leg 0 TWAP buy 0.0015 BTC over 5 min', { leg: 0, coin: 'BTC', side: 'buy', type: 'twap', size: '0.0015', minutes: 5, leverage: 3, isCross: false });
  const twapId = tw && (tw as { twapId?: number }).twapId;
  if (twapId !== undefined) await step('cancel the TWAP', async () => exec.cancel(OWNER, { leg: 0, coin: 'BTC', twapId }, 3));

  // 3. hedge leg 0's remaining position on leg 1 at its own leverage and margin mode
  await step('hedge open at leg 1 5x cross', () => hedger.openHedge(OWNER, 'BTC', 1, { leg1Leverage: 5, leg1IsCross: true }).then((r) => ({ leverage: r.plan.ok && r.plan.leverage, fill: r.fill })));
  await sleep(2500);
  const snapshot = await legs.snapshot(OWNER);
  for (const l of snapshot.legs) show(`leg ${l.leg} position`, l.clearinghouse.assetPositions.map((a) => ({ szi: a.position.szi, lev: a.position.leverage, entry: a.position.entryPx })));

  // 4. positions, PnL and history from Hyperliquid's own records
  const data = await readLegHistory(legs.hl, snapshot);
  const [composite] = openComposites(snapshot, data, await readFundingRates(legs.hl, snapshot));
  show('composite', composite && { kind: composite.kind, netSize: composite.netSize, totals: composite.totals });
  const rows = historyRows(data).filter((r) => r.time >= startedAt - 5000);
  console.log('history since the start of this script:');
  for (const r of rows.reverse()) console.log(`  ${r.kind.padEnd(11)} ${r.label}${r.size ? ` size ${r.size.toFixed(5)}` : ''}${r.closedPnl ? ` closedPnl ${r.closedPnl.toFixed(4)}` : ''}${r.fee ? ` fee ${r.fee.toFixed(4)}` : ''}`);
  const fills = data.flatMap((d) => d.fills).filter((f) => f.time >= startedAt - 5000);
  console.log(`fills since start: ${fills.length}, with our cloid: ${fills.filter((f) => f.cloid?.startsWith('0x4c48')).length}`);
} finally {
  await Promise.all([0, 1].map((l) => cancelAll(l).catch(() => undefined)));
  await step('close the hedge and the rest', async () => {
    const closed = await hedger.closeHedge(OWNER, 'BTC').catch((e) => ({ refused: (e as Error).message }));
    return closed;
  });
  await sleep(3000);

  // 5. reconcile: a leg's balance change must equal realized (closedPnl) - fees + funding of its fills since the start, with nothing open
  const snapshot = await legs.snapshot(OWNER);
  const data = await readLegHistory(legs.hl, snapshot);
  for (const [i, p] of picked.entries()) {
    const d = data[i]!;
    const mine = d.fills.filter((f) => f.time >= startedAt - 5000);
    const pnl = mine.reduce((s, f) => s + Number(f.closedPnl), 0);
    const fees = mine.reduce((s, f) => s + Number(f.fee) + Number(f.builderFee ?? 0), 0);
    const funding = d.funding.filter((f) => f.time >= startedAt - 5000).reduce((s, f) => s + Number(f.delta.usdc), 0);
    const after = await equity(p.address);
    const open = snapshot.legs[i]!.clearinghouse.assetPositions.filter((a) => Number(a.position.szi) !== 0).length;
    console.log(`reconcile leg ${i}: balance change ${(after - before[i]!).toFixed(6)}  vs  closedPnl ${pnl.toFixed(6)} - fees ${fees.toFixed(6)} + funding ${funding.toFixed(6)} = ${(pnl - fees + funding).toFixed(6)}  (open positions left: ${open})`);
  }
  console.log(failures ? `${failures} step(s) FAILED` : 'all steps ok');
}

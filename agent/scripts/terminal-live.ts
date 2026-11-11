// Live testnet check of what the trade terminal added: a market order with attached TP/SL (one normalTpsl group), and moving a resting limit
// order in place (modify keeps oid-for-order, size, side and cloid), plus whether frontendOpenOrders returns `tif`. One lab wallet stands in for leg 0.
// Testnet only; BTC only; everything is cancelled and closed in the `finally`. Prints addresses and numbers, never keys.
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json node agent/scripts/terminal-live.ts
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { HyperNearClient } from '@hypernear/client';
import { loadConfig } from '../src/config.ts';
import { Legs } from '../src/legs.ts';
import { agentKeySigner, hlClient } from '../src/market.ts';
import { validateCancelSpec, validateModifySpec, validateOrderSpec, type OrderSpec, type RestingOrder } from '../src/order.ts';
import { OrderExecutor } from '../src/orders.ts';
import { parseCloid } from '../src/cloid.ts';

const policy = { ...loadConfig({}).policy, allowedCoins: ['BTC'], maxNotionalUsd: 200, maxLeverage: 5 };
const wallets = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: Hex }[]).sort((a, b) => a.index - b.index);
const reader = hlClient('testnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v).slice(0, 900)}`);
const key = wallets[0]!.privateKey;
const address = privateKeyToAccount(key).address.toLowerCase() as Hex;
const OWNER = '0x1111111111111111111111111111111111111111' as Hex;

const legs = new Legs({ client: { getLeg: async () => address } as unknown as HyperNearClient, dataDir: mkdtempSync(join(tmpdir(), 'terminal-live-')), network: 'testnet', coins: ['BTC'] });
legs.registered = async () => [{ leg: 0, address }];
legs.keys.ensure(OWNER, 0);
legs.keys.markApproved(OWNER, 0);
legs.tradingClient = () => hlClient('testnet', { agent: agentKeySigner(key) });
const exec = new OrderExecutor(legs, policy);

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
const place = (label: string, spec: OrderSpec) =>
  step(label, async () => {
    const v = validateOrderSpec(spec, { snapshot: await legs.snapshot(OWNER), policy });
    if (!v.ok) throw new Error(`refused: ${v.errors.join('; ')}`);
    const r = (await exec.place(OWNER, v.spec, v.plan)) as { statuses?: unknown };
    return r.statuses;
  });
const rawOrders = async () => reader.frontendOpenOrders({ user: address });
const slim = (o: Awaited<ReturnType<typeof rawOrders>>[number]) => ({ oid: o.oid, type: o.orderType, side: o.side, sz: o.sz, limitPx: o.limitPx, trigger: o.triggerPx, posTpsl: o.isPositionTpsl, reduce: o.reduceOnly, tif: (o as { tif?: unknown }).tif ?? 'ABSENT', cloid: o.cloid ? parseCloid(o.cloid)?.kind ?? 'foreign' : 'none' });
const cancelAll = () =>
  step('cancel all', async () => {
    const v = validateCancelSpec({ leg: 0, coin: 'BTC', all: true }, { snapshot: await legs.snapshot(OWNER), policy });
    if (!v.ok) throw new Error(v.errors.join('; '));
    return exec.cancel(OWNER, v.spec, v.asset);
  });

try {
  const mid = Number((await reader.allMids()).BTC);
  const px = (f: number) => String(Math.round(mid * f));
  console.log(`lab wallet ${address}, BTC mid ${mid}`);

  // 1. item 4 and 2: a post-only limit far below the market, its raw row (is tif there?), then moved in place
  await place('limit buy 0.0004 post-only at -3%', { leg: 0, coin: 'BTC', side: 'buy', type: 'limit', size: '0.0004', limitPx: px(0.97), tif: 'Alo', leverage: 3, isCross: false });
  await sleep(1500);
  const before = (await rawOrders()).find((o) => o.orderType === 'Limit');
  show('raw frontendOpenOrders row (all keys)', before);
  show('slim before move', before && slim(before));
  if (before) {
    const resting: RestingOrder[] = [{ oid: before.oid, coin: before.coin, side: before.side === 'B' ? 'buy' : 'sell', size: before.sz, limitPx: before.limitPx, orderType: before.orderType, isTrigger: before.isTrigger, reduceOnly: before.reduceOnly, tif: (before as { tif?: RestingOrder['tif'] }).tif ?? null, cloid: before.cloid ?? null }];
    const check = validateModifySpec({ leg: 0, coin: 'BTC', oid: before.oid, limitPx: px(0.975) }, { snapshot: await legs.snapshot(OWNER), policy }, resting);
    await step('modify to -2.5%', async () => {
      if (!check.ok) throw new Error(check.errors.join('; '));
      return exec.modify(OWNER, check);
    });
    await sleep(1500);
    const after = await rawOrders();
    show('orders after move (same size, side, cloid? still Alo?)', after.map(slim));
    const moved = after.find((o) => o.orderType === 'Limit');
    console.log(`  oid ${before.oid} -> ${moved?.oid}; cloid kept: ${moved?.cloid === before.cloid}; size kept: ${moved?.sz === before.sz}; price ${before.limitPx} -> ${moved?.limitPx}; tif field ${(moved as { tif?: unknown } | undefined)?.tif ?? 'ABSENT'}`);
  }
  await cancelAll();

  // 2b. the same normalTpsl group with a post-only entry (works while testnet only takes post-only orders)
  await place('limit buy 0.0004 post-only at -3% with TP at -1% / SL at -6%', { leg: 0, coin: 'BTC', side: 'buy', type: 'limit', size: '0.0004', limitPx: px(0.97), tif: 'Alo', leverage: 3, isCross: false, tpPx: px(0.99), slPx: px(0.94) });
  await sleep(1500);
  show('orders of the group (entry plus two triggers expected)', (await rawOrders()).map(slim));
  await cancelAll();
  show('orders after cancelling (nothing should be left)', (await rawOrders()).map(slim));

  // 3. item 1: a market buy with attached TP and SL
  await place('market buy 0.0004 with TP +5% / SL -5%', { leg: 0, coin: 'BTC', side: 'buy', type: 'market', size: '0.0004', leverage: 3, isCross: false, tpPx: px(1.05), slPx: px(0.95) });
  await sleep(2500);
  show('open orders after the group (two triggers expected)', (await rawOrders()).map(slim));
  const pos = (await reader.clearinghouseState({ user: address })).assetPositions.map((a) => ({ szi: a.position.szi, lev: a.position.leverage }));
  show('position', pos);
  const fills = (await reader.userFills({ user: address })).slice(0, 3).map((f) => ({ dir: f.dir, sz: f.sz, cloid: f.cloid ? parseCloid(f.cloid)?.kind ?? 'foreign' : 'none' }));
  show('latest fills (the entry should carry our cloid)', fills);
} finally {
  const p = (await reader.clearinghouseState({ user: address })).assetPositions.map((a) => a.position).filter((x) => Number(x.szi) !== 0);
  for (const x of p) {
    const isBuy = Number(x.szi) < 0;
    await hlClient('testnet', { agent: agentKeySigner(key) })
      .limitOrderOpen({ asset: 3, isBuy, price: String(Math.round(Number((await reader.allMids()).BTC) * (isBuy ? 1.02 : 0.98))), size: Math.abs(Number(x.szi)).toFixed(5), tif: 'Ioc', reduceOnly: true })
      .catch((e) => console.log('flatten failed', e.message));
  }
  await sleep(2500);
  const left = await rawOrders();
  console.log(`cleanup: ${left.length} open orders left; triggers still resting after the position closed: ${left.filter((o) => o.isTrigger).length}`);
  await cancelAll();
  console.log(failures ? `${failures} step(s) FAILED` : 'all steps ok');
}

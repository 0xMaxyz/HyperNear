import { afterEach, describe, expect, it, vi } from 'vitest';
import { Legs } from '../src/legs.ts';
import { readFundingRates, readLegHistory } from '../src/positions.ts';
import { HL_API_URLS, hlGate } from '@perps-platform/core';

// A counting fake of api.hyperliquid-testnet.xyz behind fetch: how many /info and /exchange requests does each page request cost?
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333' as const;
const meta = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }], marginTables: [] };
const ch = { marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [], time: 1 };
const answers: Record<string, unknown> = {
  meta,
  allMids: { BTC: '100000' },
  clearinghouseState: ch,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '10', hold: '0', entryNtl: '0' }] },
  userRole: { role: 'user' },
  userNonFundingLedgerUpdates: [],
  userAbstraction: 'default',
  userFills: [],
  userFees: { userCrossRate: '0.00045', userAddRate: '0.00015' },
  userFunding: [],
  metaAndAssetCtxs: [meta, [{ funding: '0.0000125' }]],
  frontendOpenOrders: [],
  twapHistory: [],
};
// request weights from HL's rate-limit docs: info requests weigh 20 unless listed
const WEIGHT: Record<string, number> = { allMids: 2, clearinghouseState: 2, spotClearinghouseState: 2, userRole: 60, userAbstraction: 20, frontendOpenOrders: 20 };
const weight = (t: string) => WEIGHT[t] ?? 20;

let seen: string[] = [];
function fakeHl() {
  seen = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const kind = String(url).endsWith('/exchange') ? 'exchange' : 'info';
    seen.push(kind === 'info' ? body.type : 'exchange');
    return new Response(JSON.stringify(kind === 'info' ? answers[body.type] : { status: 'ok', response: { type: 'default' } }), { headers: { 'content-type': 'application/json' } });
  });
}
const tally = () => ({ total: seen.length, weight: seen.reduce((s, t) => s + (t === 'exchange' ? 1 : weight(t)), 0) });
const legs = () => new Legs({ client: { getLeg: async (_o: string, i: number) => [A, B][i] ?? null } as never, dataDir: null, network: 'testnet', coins: ['BTC'] });

let clock = 0;
const gate = hlGate(HL_API_URLS.testnet, { now: () => clock });
const forget = () => gate.write(async () => undefined); // a write drops every cached read: a cold start

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HL /info requests per page request (2 registered legs)', () => {
  // the page: /owner every 10 s, and /positions, /history and /orders refetched on each of those (web/src: snapshot.at changes)
  const owner = (l: Legs) => l.snapshot(OWNER);
  const positions = async (l: Legs) => {
    const s = await l.snapshot(OWNER);
    await readLegHistory(l.hl, s, 'testnet');
    await readFundingRates(l.hl, s);
  };
  const history = async (l: Legs) => readLegHistory(l.hl, await l.snapshot(OWNER), 'testnet');
  const orders = async (l: Legs) => {
    const regs = await l.registered(OWNER);
    await Promise.all(regs.map(({ address }) => Promise.all([l.hl.frontendOpenOrders({ user: address }), l.hl.twapHistory({ user: address })])));
  };

  it('a cold request costs what it did before; one tab polling for a minute stays far below 1200 weight', async () => {
    const l = legs();
    const cold: Record<string, ReturnType<typeof tally>> = {};
    for (const [name, f] of Object.entries({ 'GET /owner': owner, 'GET /positions': positions, 'GET /history': history, 'GET /orders': orders, 'POST /hedge/open (its 2 reads)': async (x: Legs) => (await owner(x), await owner(x)) })) {
      await forget();
      fakeHl();
      await f(l);
      cold[name] = tally();
    }
    // eslint-disable-next-line no-console
    console.log('HL-COLD', JSON.stringify(cold));

    await forget();
    fakeHl();
    clock = 1_000_000;
    let first = { total: 0, weight: 0 };
    for (let t = 0; t < 60; t += 10, clock += 10_000) {
      await Promise.all([owner(l), positions(l), history(l), orders(l)]);
      if (t === 0) {
        first = tally();
        seen = [];
      }
    }
    const steady = tally(); // the other 5 cycles, 50 s
    // eslint-disable-next-line no-console
    console.log('HL-MINUTE', JSON.stringify({ firstCycle: first, next50s: steady, byType: Object.fromEntries([...new Set(seen)].map((t) => [t, seen.filter((x) => x === t).length])) }));
    // before the gate every cycle cost 510 weight (3060 a minute); the budget is 1200 a minute per IP
    expect(first.weight + steady.weight).toBeLessThan(1100);
    expect(steady.weight * (60 / 50)).toBeLessThan(700);
  });
});

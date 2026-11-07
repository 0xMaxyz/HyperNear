// LIVE=1 + TYPESAFE_API_KEY + ANTHROPIC_API_KEY (ci32, testnet): an accepted proposal that executes orders.
//   unbalanced hedge (leg0 long 4 units, leg1 short 1 unit, 3x) -> POST /decision/propose (Jev, then Claude) ->
//   if the models hold (or their action is refused by the policy), propose again with forceAction close_both (HYPERNEAR_TEST=1)
//   -> owner-signed accept -> fills checked against positions -> close everything. Writes agent/results/decision-exec-live.json.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, HyperNearClient, nearAccount, newCommand, type CommandAction } from '@hypernear/client';
import { claudeEscalator } from '../src/claude.ts';
import { ReplayCache } from '../src/commands.ts';
import { loadConfig } from '../src/config.ts';
import { proposeAction } from '../src/decide.ts';
import { Decider, DecisionModes } from '../src/decisions.ts';
import { EventBus } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { fillOf, HedgeRefused, Hedger } from '../src/hedge.ts';
import { jevAsk } from '../src/jev.ts';
import { Legs } from '../src/legs.ts';
import { position, roundPx } from '../src/market.ts';
import { RateLimiter, Relayer, HttpError } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ownerKey = (): Hex =>
  (process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ??
  (process.env.NEAR_NETWORK === 'testnet' ? PUBLIC_TEST_OWNER_KEY : (() => { throw new Error('set HYPERNEAR_TEST_OWNER_KEY or NEAR_NETWORK=testnet'); })());
const live = process.env.LIVE === '1' && Boolean(process.env.TYPESAFE_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)('live: an accepted proposal executes orders', () => {
  it('unbalanced hedge -> propose -> signed accept -> filled, positions moved -> closed', async () => {
    process.env.HYPERNEAR_TEST = '1'; // allows forceAction on this in-process server only
    const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
    const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8')).private_key;
    const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, key, RPC) });
    const owner = privateKeyToAccount(ownerKey());
    const o = owner.address.toLowerCase() as Hex;
    const config = { ...loadConfig({}), contractId, decide: { live: true, intervalSec: 300 } };
    const bus = new EventBus();
    const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
    const hedger = new Hedger(legs, config.policy, bus);
    const clients = { ask: jevAsk(), escalate: claudeEscalator() };
    const d: Deps = {
      config, client, legs, bus, hedger,
      relayer: new Relayer(client, new RateLimiter(100)),
      replay: new ReplayCache(),
      guardConfig: DEFAULT_GUARD_CONFIG,
      pnlData: async () => [],
    };
    d.decider = new Decider({
      legs, bus, policy: config.policy, annualVol: config.guard.annualVol,
      modes: new DecisionModes(mkdtempSync(join(tmpdir(), 'hypernear-dec-'))), // default mode: propose
      propose: (i) => proposeAction(i.state, i.ctx, clients),
      execute: (ow, action, coin, orders) => hedger.runOrders(ow, action, coin, orders),
      checkOwner: async (ow) => {
        const st = await client.getOwner(ow);
        if (!st?.agent || st.frozen) throw new HttpError(403, 'owner not opted in or frozen');
      },
      owners: () => [o],
    });
    const server = createServer(handler(d));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const signed = async (action: CommandAction, coin: string, nonceMs = Date.now()) => {
      const command = newCommand(o, action, coin, '0', 30, nonceMs);
      return { command, sig: await owner.signTypedData(commandTypedData('near-testnet', contractId, command) as never) };
    };
    const positions = async () => {
      const s = await legs.snapshot(o);
      return s.legs.filter((l) => l.leg < 2).map((l) => ({ leg: l.leg, szi: position(l.clearinghouse, 'BTC')?.szi ?? '0', lev: position(l.clearinghouse, 'BTC')?.leverage.value ?? null }));
    };
    const closeAll = () => hedger.closeHedge(o, 'BTC').catch((e) => (e instanceof HedgeRefused ? null : Promise.reject(e)));

    try {
      expect((await client.getOwner(o))?.agent).toBeTruthy();
      await closeAll(); // start flat

      // unbalanced hedge, 4:1. Sizes follow HL's $10 minimum: leg1 and one 25% step must each be >= $10 at this mid
      // (the suggested 0.0004 / 0.0001 BTC is ~$8 on leg1 at ~79k, which HL refuses)
      const s0 = await legs.snapshot(o);
      const btc = s0.market.assets.find((a) => a.name === 'BTC')!;
      const mid = Number(s0.market.mids.BTC);
      const unit = Math.ceil((10.6 / mid) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals;
      const leg0Size = (4 * unit).toFixed(btc.szDecimals);
      const leg0 = legs.tradingClient(o, 0);
      await leg0.updateLeverage({ asset: btc.asset, isCross: true, leverage: 3 });
      const long = fillOf(await leg0.limitOrderOpen({ asset: btc.asset, isBuy: true, price: roundPx(mid * 1.03, btc.szDecimals), size: leg0Size, tif: 'Ioc' }));
      const hedge = await hedger.openHedge(o, 'BTC', 0.25);
      const opened = await positions();

      const proposeOnce = async (forceAction?: string) => {
        const seen = new Set(bus.since().filter((e) => e.type === 'decision.proposed').map((e) => e.data.id));
        const t0 = Date.now();
        const q = await post('/decision/propose', { owner: o, ...(forceAction ? { forceAction } : {}) });
        expect(q.status).toBe(202);
        let p: Record<string, any> | undefined;
        while (!p && Date.now() - t0 < 90_000) {
          p = bus.since().find((e) => e.type === 'decision.proposed' && !seen.has(e.data.id))?.data;
          if (!p) await new Promise((r) => setTimeout(r, 250));
        }
        expect(p).toBeDefined();
        return { proposed: p!, ms: Date.now() - t0 };
      };
      const acceptOnce = async (p: Record<string, any>) => {
        const before = await positions();
        const accept = await post(`/decision/${p.id}/accept`, await signed(p.action, p.coin));
        return { before, accept, after: await positions() };
      };

      const attempts: unknown[] = [];
      let round = await proposeOnce();
      let done = round.proposed.action === 'hold' ? null : await acceptOnce(round.proposed);
      if (!done || done.accept.status !== 200 || !(done.accept.body.orders?.length > 0)) {
        // the models held (or their action was refused by the order policy): force close_both, HYPERNEAR_TEST=1 only
        attempts.push({ proposed: round.proposed, proposeMs: round.ms, ...(done ?? { accept: 'not sent: hold executes nothing' }) });
        round = await proposeOnce('close_both');
        done = await acceptOnce(round.proposed);
      }
      const { before, accept, after } = done;
      expect(accept.status).toBe(200);
      const orders = accept.body.orders as { leg: number; isBuy: boolean; size: string; reduceOnly: boolean; notionalUsd: number }[];
      expect(orders.length).toBeGreaterThan(0);
      // within policy, filled, and each leg moved by exactly its filled size
      const fills = (accept.body.result as { order: { leg: number; isBuy: boolean }; fill: { totalSz?: string; avgPx?: string } }[]).map((r) => ({ leg: r.order.leg, isBuy: r.order.isBuy, totalSz: r.fill.totalSz, avgPx: r.fill.avgPx }));
      for (const x of orders) expect(x.reduceOnly || x.notionalUsd <= config.policy.maxNotionalUsd).toBe(true);
      for (const f of fills) {
        expect(Number(f.totalSz)).toBeGreaterThan(0);
        const delta = Number(after.find((p) => p.leg === f.leg)!.szi) - Number(before.find((p) => p.leg === f.leg)!.szi);
        expect(delta).toBeCloseTo((f.isBuy ? 1 : -1) * Number(f.totalSz), 9);
      }
      for (const p of after) if (p.lev !== null) expect(p.lev).toBeLessThanOrEqual(config.policy.maxLeverage);
      const events = bus.since().filter((e) => e.type.startsWith('decision.')).map((e) => ({ type: e.type, data: e.data }));

      await closeAll();
      const closed = await positions();
      expect(closed.every((p) => Number(p.szi) === 0)).toBe(true);

      mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
      writeFileSync(
        new URL('../results/decision-exec-live.json', import.meta.url),
        JSON.stringify({
          at: new Date().toISOString(), owner: o, contractId, policy: config.policy, mid,
          forced: Boolean(round.proposed.forced), note: round.proposed.forced ? `forceAction close_both (HYPERNEAR_TEST=1): the models proposed ${round.proposed.modelAction}` : 'the models\' own action',
          opened, openFills: { leg0: long, leg1: hedge.fill }, earlierAttempts: attempts,
          proposeMs: round.ms, proposed: round.proposed, before, accept: { status: accept.status, orders, fills }, after, closed, events,
        }, null, 2) + '\n'
      );
    } finally {
      await closeAll().catch(() => undefined);
      server.close();
    }
  }, 300_000);
});

// LIVE=1 + TYPESAFE_API_KEY + ANTHROPIC_API_KEY (ci32, testnet): one proposal from the real models, accepted by the owner.
//   open a small hedge (leg0 long BTC 3x ~$15, leg1 short the same) -> POST /decision/propose (Jev, then Claude) ->
//   decision.proposed -> owner-signed accept -> orders checked against the order policy -> close everything.
// Writes agent/results/decision-live.json.
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
import { floorSize, position, roundPx } from '../src/market.ts';
import { RateLimiter, Relayer, HttpError } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ownerKey = (): Hex =>
  (process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ??
  (process.env.NEAR_NETWORK === 'testnet' ? PUBLIC_TEST_OWNER_KEY : (() => { throw new Error('set HYPERNEAR_TEST_OWNER_KEY or NEAR_NETWORK=testnet'); })());
const live = process.env.LIVE === '1' && Boolean(process.env.TYPESAFE_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)('live: one real proposal, accepted by the owner', () => {
  it('small hedge -> propose (Jev + Claude) -> signed accept -> within policy -> closed', async () => {
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

      // leg0: long BTC at 3x cross, ~$15 (IOC at mid + slippage); leg1: the hedge, ratio 1
      const s0 = await legs.snapshot(o);
      const btc = s0.market.assets.find((a) => a.name === 'BTC')!;
      const mid = Number(s0.market.mids.BTC);
      const leg0 = legs.tradingClient(o, 0);
      await leg0.updateLeverage({ asset: btc.asset, isCross: true, leverage: 3 });
      const long = fillOf(await leg0.limitOrderOpen({ asset: btc.asset, isBuy: true, price: roundPx(mid * 1.03, btc.szDecimals), size: floorSize(15 / mid, btc.szDecimals), tif: 'Ioc' }));
      const hedge = await hedger.openHedge(o, 'BTC', 1);
      const opened = await positions();

      const t0 = Date.now();
      const q = await post('/decision/propose', { owner: o });
      expect(q.status).toBe(202);
      let proposed: Record<string, any> | undefined;
      while (!proposed && Date.now() - t0 < 90_000) {
        proposed = bus.since().find((e) => e.type === 'decision.proposed')?.data;
        if (!proposed) await new Promise((r) => setTimeout(r, 250));
      }
      expect(proposed).toBeDefined();
      const proposeMs = Date.now() - t0;

      const accept = await post(`/decision/${proposed!.id}/accept`, await signed(proposed!.action, proposed!.coin));
      const events = bus.since().filter((e) => e.type.startsWith('decision.')).map((e) => ({ type: e.type, data: e.data }));
      const after = await positions();
      // within policy: every order the accept placed is reduce-only or <= max notional, at <= max leverage
      const orders = (accept.body.orders ?? []) as { reduceOnly: boolean; notionalUsd: number }[];
      for (const x of orders) expect(x.reduceOnly || x.notionalUsd <= config.policy.maxNotionalUsd).toBe(true);
      for (const p of after) if (p.lev !== null) expect(p.lev).toBeLessThanOrEqual(config.policy.maxLeverage);
      expect([200, 422]).toContain(accept.status); // 422 = refused by the order policy (reported as decision.rejected)

      await closeAll();
      const closed = await positions();
      expect(closed.every((p) => Number(p.szi) === 0)).toBe(true);

      mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
      writeFileSync(
        new URL('../results/decision-live.json', import.meta.url),
        JSON.stringify({ at: new Date().toISOString(), owner: o, contractId, policy: config.policy, opened, openFills: { leg0: long, leg1: hedge.fill }, proposeMs, proposed, accept, after, closed, events }, null, 2) + '\n'
      );
    } finally {
      await closeAll().catch(() => undefined);
      server.close();
    }
  }, 240_000);
});

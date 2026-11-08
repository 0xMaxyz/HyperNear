// C20 sweep (LIVE=1, ci32, testnet): the freeze sweep clears resting orders on every leg, with no agent server.
//   fresh agents on legs 0 and 1, one resting BTC order on each; the owner freezes (agents revoked, orders stay);
//   clearFrozen (the code behind agent/scripts/clear-frozen.ts) reads each leg's open orders from HL info, has the
//   contract sign the cancels (cancel_orders, any NEAR account), posts them; both books must end empty.
//   Cleanup: unfreeze, fresh agents on legs 0-2. Writes validation/results/C20-sweep.json (refs.event = the orders.swept payload).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount, ownerIntentTypedData, type OwnerIntent } from '@hypernear/client';
import { runClaim } from '../../validation/src/results.ts';
import { EventBus } from '../src/events.ts';
import { fillOf } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { roundPx } from '../src/market.ts';
import { hlPoster, RateLimiter, Relayer } from '../src/relayer.ts';
import { clearFrozen, sweptEvent } from '../src/sweep.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe.skipIf(process.env.LIVE !== '1')('C20 sweep: clearFrozen after a freeze', () => {
  it('both legs\' resting orders are cancelled by contract-signed L1 cancels', async () => {
    await runClaim('C20-sweep', 'C20', 'after a freeze the sweep clears resting orders on every leg (cancel_orders, no agent server)', async (rec) => {
      const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
      const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8')).private_key;
      const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, key, RPC) });
      const owner = privateKeyToAccount((process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ?? PUBLIC_TEST_OWNER_KEY);
      const o = owner.address.toLowerCase() as Hex;
      const sign = (td: unknown) => owner.signTypedData(td as never);
      const bus = new EventBus();
      const relayer = new Relayer(client, new RateLimiter(100), hlPoster('testnet'), bus);
      const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
      const cfg = await client.getConfig();
      const relayIntent = async (intent: OwnerIntent) => {
        const nonce = await client.getOwnerNonce(o);
        const sig = await sign(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: o, nonce, intent }));
        return relayer.relay('c20s', { owner: o, nonce, intent, sig });
      };
      const openOids = async (user: Hex) => (await legs.hl.openOrders({ user })).map((x) => x.oid);

      if ((await client.getOwner(o))?.frozen) await relayIntent({ type: 'freeze', frozen: false });
      await legs.approveAgents(o, [0, 1], sign as never, { rotate: true });

      const s = await legs.snapshot(o);
      const btc = s.market.assets.find((a) => a.name === 'BTC')!;
      const px = roundPx(Number(s.market.mids.BTC) * 0.5, btc.szDecimals);
      const size = (Math.ceil((11 / Number(px)) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
      const resting: Record<number, { address: Hex; oid: number }> = {};
      for (const leg of [0, 1]) {
        const oid = fillOf(await legs.tradingClient(o, leg).limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' })).oid;
        resting[leg] = { address: s.legs.find((l) => l.leg === leg)!.address, oid };
        expect(await openOids(resting[leg]!.address)).toContain(oid);
      }
      rec.refs.resting = resting;

      const frozen = (await relayIntent({ type: 'freeze', frozen: true })) as { txHash: string };
      rec.refs.freezeTx = frozen.txHash;
      for (const leg of [0, 1]) expect(await openOids(resting[leg]!.address)).toContain(resting[leg]!.oid); // revoked agents do not clear the book

      const t0 = Date.now();
      const swept = await clearFrozen(o, { client, hl: legs.hl, network: 'testnet' });
      const ms = Date.now() - t0;
      const books: Record<number, number[]> = {};
      for (const leg of [0, 1]) books[leg] = await openOids(resting[leg]!.address);
      rec.refs.sweep = swept;
      rec.refs.openOrdersAfter = books;
      rec.refs.event = sweptEvent(o, swept, ms); // the orders.swept payload
      rec.numbers.sweepMs = ms;
      rec.numbers.cancelled = swept.reduce((a, l) => a + l.cancelled, 0);
      for (const leg of [0, 1]) {
        const r = swept.find((l) => l.leg === leg)!;
        expect(r.error).toBeUndefined();
        expect(r.cancelled).toBeGreaterThanOrEqual(1);
        expect(r.hl.every((h) => h === 'ok')).toBe(true);
        expect(books[leg]).toEqual([]);
      }
      rec.notes.push(`Owner ${o} (the public test owner), legs 0 and 1 of leash-spike-1107.testnet. The caller was the contract account (any NEAR account works: cancel_orders only checks that the owner is frozen). Cleanup: unfroze and approved fresh agents on legs 0-2, so the owner ends unfrozen.`);

      await relayIntent({ type: 'freeze', frozen: false });
      await legs.approveAgents(o, [0, 1, 2], sign as never, { rotate: true });
    });
  }, 400_000);
});

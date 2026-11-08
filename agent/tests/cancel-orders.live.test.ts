// C20 part 2 (LIVE=1, ci32, testnet, DEFAULT contract build: no spike methods): `cancel_orders` and the
// `cancelOrders` owner intent clear resting orders without the agent server.
//   1. fresh agent on leg0, resting order; freeze (agents revoked); anyone calls cancel_orders -> POST
//      {action, nonce, signature, vaultAddress: null} -> book empty.
//   2. unfreeze, fresh agent, resting order; owner-signed cancelOrders intent through owner_execute -> book empty.
//   Cleanup: fresh agents on legs 0-2. Writes validation/results/C20-method.json.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HL_API_URLS } from '@perps-platform/core';
import { hypernearDomain, HyperNearClient, nearAccount, ownerIntentTypedData, type OwnerIntent, type SignOut } from '@hypernear/client';
import { runClaim } from '../../validation/src/results.ts';
import { EventBus } from '../src/events.ts';
import { fillOf } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { roundPx } from '../src/market.ts';
import { hlPoster, RateLimiter, Relayer } from '../src/relayer.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

/** The cancelOrders intent as contract/src/auth.rs types it (the @hypernear/client wiring comes later). */
const cancelOrdersTypedData = (chainTag: 'near-testnet' | 'near-mainnet', contractId: string, owner: Hex, nonce: number, leg: number, cancels: { a: number; o: number }[]) => ({
  domain: hypernearDomain(chainTag, contractId),
  types: {
    CancelOrders: [{ name: 'owner', type: 'address' }, { name: 'nonce', type: 'uint64' }, { name: 'leg', type: 'uint32' }, { name: 'cancels', type: 'Cancel[]' }],
    Cancel: [{ name: 'a', type: 'uint32' }, { name: 'o', type: 'uint64' }],
  },
  primaryType: 'CancelOrders',
  message: { owner, nonce, leg, cancels },
});

type CancelOut = SignOut & { nonce: number; action: { type: 'cancel'; cancels: { a: number; o: number }[] } };

describe.skipIf(process.env.LIVE !== '1')('C20 method: cancel_orders / cancelOrders on the default build', () => {
  it('frozen: anyone clears the book; not frozen: the owner intent clears it', async () => {
    await runClaim('C20-method', 'C20', 'cancel_orders (anyone, while frozen) and the cancelOrders intent clear resting orders, default build', async (rec) => {
      const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
      const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8')).private_key;
      const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, key, RPC) });
      const owner = privateKeyToAccount((process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ?? PUBLIC_TEST_OWNER_KEY);
      const o = owner.address.toLowerCase() as Hex;
      const sign = (td: unknown) => owner.signTypedData(td as never);
      const relayer = new Relayer(client, new RateLimiter(100), hlPoster('testnet'), new EventBus());
      const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
      const cfg = await client.getConfig();
      const relayIntent = async (intent: OwnerIntent) => {
        const nonce = await client.getOwnerNonce(o);
        const sig = await sign(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: o, nonce, intent }));
        return relayer.relay('c20m', { owner: o, nonce, intent, sig });
      };
      const openOids = async (user: Hex) => (await legs.hl.openOrders({ user })).map((x) => x.oid);
      /** POSTs a contract-signed L1 cancel; returns HL's answer after checking the signer is the leg. */
      const post = async (out: CancelOut, leg0: Hex) => {
        const signature = { r: `0x${out.big_r.slice(2)}` as Hex, s: `0x${out.s}` as Hex, v: 27 + out.recovery_id };
        const signer = (await recoverAddress({ hash: `0x${out.payload}`, signature: { r: signature.r, s: signature.s, yParity: out.recovery_id } })).toLowerCase();
        expect(signer).toBe(leg0);
        const r = await fetch(`${HL_API_URLS.testnet}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: out.action, nonce: out.nonce, signature, vaultAddress: null }) });
        return (await r.json()) as { status: string; response?: { data?: { statuses?: unknown[] } } };
      };
      const rest = async () => {
        const s = await legs.snapshot(o);
        const btc = s.market.assets.find((a) => a.name === 'BTC')!;
        const px = roundPx(Number(s.market.mids.BTC) * 0.5, btc.szDecimals);
        const size = (Math.ceil((11 / Number(px)) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
        const oid = fillOf(await legs.tradingClient(o, 0).limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' })).oid;
        return { leg0: s.legs.find((l) => l.leg === 0)!.address, asset: btc.asset, oid };
      };

      if ((await client.getOwner(o))?.frozen) await relayIntent({ type: 'freeze', frozen: false });

      // ---- 1. frozen: permissionless cancel_orders
      await legs.approveAgents(o, [0], sign as never, { rotate: true });
      const r1 = await rest();
      expect(await openOids(r1.leg0)).toContain(r1.oid);
      const frozen = (await relayIntent({ type: 'freeze', frozen: true })) as { txHash: string };
      expect(await openOids(r1.leg0)).toContain(r1.oid); // revoked agents do not take orders off the book
      const t0 = Date.now();
      const c1 = await client.backend.call<CancelOut>(contractId, 'cancel_orders', { owner: o, leg: 0, cancels: [{ a: r1.asset, o: r1.oid }] }, { gasTgas: 300 });
      const hl1 = await post(c1.value, r1.leg0);
      const book1 = await openOids(r1.leg0);
      rec.refs.frozenPath = { freezeTx: frozen.txHash, cancelTx: c1.txHash, caller: contractId, order: r1, nonce: c1.value.nonce, hl: hl1, openOrdersAfter: book1 };
      rec.numbers.frozenSignAndPostMs = Date.now() - t0;
      expect(hl1.status).toBe('ok');
      expect(hl1.response?.data?.statuses).toEqual(['success']);
      expect(book1).toEqual([]);

      // ---- 2. not frozen: owner-signed cancelOrders intent
      await relayIntent({ type: 'freeze', frozen: false });
      await legs.approveAgents(o, [0], sign as never, { rotate: true });
      const r2 = await rest();
      const intent = { type: 'cancelOrders', leg: 0, cancels: [{ a: r2.asset, o: r2.oid }] };
      const nonce = await client.getOwnerNonce(o);
      const sig = await sign(cancelOrdersTypedData(cfg.chain_tag, contractId, o, nonce, 0, intent.cancels));
      const c2 = await client.backend.call<CancelOut>(contractId, 'owner_execute', { owner: o, nonce, intent, signature: sig }, { gasTgas: 300, deposit: 10n ** 22n });
      const hl2 = await post(c2.value, r2.leg0);
      const book2 = await openOids(r2.leg0);
      rec.refs.intentPath = { ownerExecuteTx: c2.txHash, order: r2, nonce: c2.value.nonce, hl: hl2, openOrdersAfter: book2 };
      expect(hl2.status).toBe('ok');
      expect(book2).toEqual([]);
      rec.notes.push('Default build (no spike methods) on leash-spike-1107.testnet. Path 1: the owner was frozen and the caller was not the owner. Path 2: the owner signed cancelOrders while not frozen.');

      await legs.approveAgents(o, [0, 1, 2], sign as never, { rotate: true });
    });
  }, 300_000);
});

// C20 (LIVE=1, ci32, testnet, SPIKE contract build): the contract can sign a Hyperliquid L1 `cancel` with a leg's
// master key (MPC), so a freeze can clear resting orders without the agent server.
//   fresh agent on leg0 -> resting order far below the book -> freeze (agent revoked) -> admin sign_raw over the
//   L1 phantom-agent digest for {"type":"cancel","cancels":[{a,o}]} -> POST /exchange -> the order is gone.
//   Cleanup: unfreeze, fresh agents. Writes validation/results/C20.json.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverAddress, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashHlL1Action, HL_API_URLS } from '@perps-platform/core';
import { legPath, HyperNearClient, nearAccount, ownerIntentTypedData, type OwnerIntent, type SignOut } from '@hypernear/client';
import { runClaim } from '../../validation/src/results.ts';
import { EventBus } from '../src/events.ts';
import { fillOf } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { roundPx } from '../src/market.ts';
import { hlPoster, RateLimiter, Relayer } from '../src/relayer.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

/** Hyperliquid L1 signing (phantom agent): EIP-712 Agent{source, connectionId} under the "Exchange" domain. */
export function l1Digest(action: object, nonce: number, mainnet: boolean): { connectionId: Hex; digest: Hex } {
  const connectionId = hashHlL1Action({ action, nonce }) as Hex;
  const digest = hashTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: zeroAddress },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: mainnet ? 'a' : 'b', connectionId },
  });
  return { connectionId, digest };
}

describe.skipIf(process.env.LIVE !== '1')('C20: contract-signed L1 cancel (spike build)', () => {
  it('a master-signed cancel removes a resting order of a frozen owner', async () => {
    await runClaim('C20', 'C20', 'The contract signs a Hyperliquid L1 cancel with the leg master key (MPC); HL accepts it', async (rec) => {
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
        return relayer.relay('c20', { owner: o, nonce, intent, sig });
      };
      const openOids = async (user: Hex) => (await legs.hl.openOrders({ user })).map((x) => x.oid);

      if ((await client.getOwner(o))?.frozen) await relayIntent({ type: 'freeze', frozen: false });
      await legs.approveAgents(o, [0], sign as never, { rotate: true });
      const s = await legs.snapshot(o);
      const leg0 = s.legs.find((l) => l.leg === 0)!.address;
      const btc = s.market.assets.find((a) => a.name === 'BTC')!;
      const px = roundPx(Number(s.market.mids.BTC) * 0.5, btc.szDecimals);
      const size = (Math.ceil((11 / Number(px)) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
      const oid = fillOf(await legs.tradingClient(o, 0).limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' })).oid;
      expect(await openOids(leg0)).toContain(oid);
      rec.refs.restingOrder = { leg0, asset: btc.asset, oid, px, size };

      // revoke the agent: the order stays on the book
      const frozen = (await relayIntent({ type: 'freeze', frozen: true })) as { txHash: string; revoked: { leg: number; ok: boolean }[] };
      rec.refs.freezeTx = frozen.txHash;
      expect(frozen.revoked.find((r) => r.leg === 0)?.ok).toBe(true);
      expect(await openOids(leg0)).toContain(oid);

      // contract signs the L1 cancel digest for leg0's path (spike: admin sign_raw)
      const action = { type: 'cancel', cancels: [{ a: btc.asset, o: oid }] };
      const nonce = Date.now();
      const { connectionId, digest } = l1Digest(action, nonce, cfg.hl_mainnet);
      const t0 = Date.now();
      const { txHash, value: out } = await client.backend.call<SignOut>(contractId, 'sign_raw', { path: legPath(o, 0), payload: digest.slice(2) }, { gasTgas: 300 });
      const signMs = Date.now() - t0;
      const signature = { r: `0x${out.big_r.slice(2)}` as Hex, s: `0x${out.s}` as Hex, v: 27 + out.recovery_id };
      const signer = (await recoverAddress({ hash: digest, signature: { r: signature.r, s: signature.s, yParity: out.recovery_id } })).toLowerCase();
      expect(signer).toBe(leg0);

      const body = { action, nonce, signature, vaultAddress: null };
      const r = await fetch(`${HL_API_URLS.testnet}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const hl = (await r.json()) as { status: string; response?: { data?: { statuses?: unknown[] } } };
      const after = await openOids(leg0);
      rec.refs.signTx = txHash;
      rec.refs.l1 = { action, nonce, connectionId, digest, source: cfg.hl_mainnet ? 'a' : 'b' };
      rec.refs.hl = hl;
      rec.numbers.signMs = signMs;
      rec.numbers.orderGone = !after.includes(oid);
      expect(hl.status).toBe('ok');
      expect(hl.response?.data?.statuses).toEqual(['success']);
      expect(after).not.toContain(oid);
      rec.notes.push('Signed by the leg master key (recovered signer = leg0) after the agent was revoked by freeze; HL accepted the L1 cancel and the order left the book.');

      // cleanup: unfreeze, fresh agents (the revoked ones are never reused)
      await relayIntent({ type: 'freeze', frozen: false });
      await legs.approveAgents(o, [0, 1, 2], sign as never, { rotate: true });
    });
  }, 300_000);
});

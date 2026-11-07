// LIVE=1 only (ci32, testnet): freeze revokes HL trading.
//   approve fresh agents on legs 0-2 (recorded by the contract) -> leg0's agent rests an order -> owner freeze
//   (contract MPC-signs approveAgent(burn) per agent name; the relayer posts them) -> the same agent's next order
//   is refused by HL. Cleanup: unfreeze, rotate agents, cancel the resting order. Writes agent/results/freeze-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount, ownerIntentTypedData, type OwnerIntent } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { fillOf } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { roundPx } from '../src/market.ts';
import { hlPoster, RateLimiter, Relayer } from '../src/relayer.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ownerKey = (): Hex =>
  (process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ??
  (process.env.NEAR_NETWORK === 'testnet' ? PUBLIC_TEST_OWNER_KEY : (() => { throw new Error('set HYPERNEAR_TEST_OWNER_KEY or NEAR_NETWORK=testnet'); })());

describe.skipIf(process.env.LIVE !== '1')('live: freeze revokes the HL agents', () => {
  it('the agent can trade before the freeze and is refused right after it', async () => {
    const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
    const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8')).private_key;
    const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, key, RPC) });
    const owner = privateKeyToAccount(ownerKey());
    const o = owner.address.toLowerCase() as Hex;
    const sign = (td: unknown) => owner.signTypedData(td as never);
    const bus = new EventBus();
    const relayer = new Relayer(client, new RateLimiter(100), hlPoster('testnet'), bus);
    const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
    const cfg = await client.getConfig();
    const relayIntent = async (intent: OwnerIntent) => {
      const nonce = await client.getOwnerNonce(o);
      const sig = await sign(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: o, nonce, intent }));
      return relayer.relay('live-test', { owner: o, nonce, intent, sig });
    };

    if ((await client.getOwner(o))?.frozen) await relayIntent({ type: 'freeze', frozen: false });
    const approved = await legs.approveAgents(o, [0, 1, 2], sign as never, { rotate: true });
    const slots = await client.getAgentSlots(o);
    expect(slots.map((s) => s.leg).sort()).toEqual([0, 1, 2]);

    // the leg0 agent works: a resting order far below the book
    const s = await legs.snapshot(o);
    const btc = s.market.assets.find((a) => a.name === 'BTC')!;
    const mid = Number(s.market.mids.BTC);
    const leg0Addr = s.legs.find((l) => l.leg === 0)!.address;
    const oldAgent = legs.tradingClient(o, 0); // keeps the pre-freeze key
    const px = roundPx(mid * 0.5, btc.szDecimals);
    const size = (Math.ceil((11 / Number(px)) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
    const rest = fillOf(await oldAgent.limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' }));

    // freeze: one NEAR tx signs approveAgent(burn) for every tracked name; the relayer posts them to HL
    const t0 = Date.now();
    const frozen = (await relayIntent({ type: 'freeze', frozen: true })) as { kind: string; txHash: string; revoked: { leg: number; name: string; burn: string; ok: boolean }[] };
    const tPosted = Date.now();
    expect(frozen.kind).toBe('freeze');
    expect(frozen.revoked.every((r) => r.ok)).toBe(true);
    const agentsAfter = await legs.hl.extraAgents({ user: leg0Addr });

    // the same agent tries again
    let refused = '';
    try {
      await oldAgent.limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' });
    } catch (e) {
      refused = (e as Error).message;
    }
    const tRefused = Date.now();
    expect(refused, 'HL should refuse the revoked agent').not.toBe('');
    const stillResting = (await legs.hl.openOrders({ user: leg0Addr })).some((x: { oid: number }) => x.oid === rest.oid);

    // cleanup: unfreeze, fresh agents (the revoked keys are never re-approved), cancel the resting order
    await relayIntent({ type: 'freeze', frozen: false });
    await legs.approveAgents(o, [0, 1, 2], sign as never);
    if (stillResting) await legs.tradingClient(o, 0).cancelOrder({ asset: btc.asset, oid: rest.oid });

    const result = {
      at: new Date(t0).toISOString(),
      owner: o,
      contractId,
      agentsBefore: approved,
      restingOid: rest.oid,
      freezeTx: frozen.txHash,
      revoked: frozen.revoked,
      leg0AgentsAfterFreeze: agentsAfter,
      oldAgentRefused: refused,
      restingOrderStillOpenAfterFreeze: stillResting,
      ms: { freezeNearAndHlPost: tPosted - t0, refusedAfterFreezeStart: tRefused - t0 },
      events: bus.since().map((e) => ({ type: e.type, data: e.data })),
    };
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../results/freeze-live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ freezeTx: result.freezeTx, ms: result.ms, refused, stillResting, revoked: frozen.revoked }, null, 1));
  }, 600_000);
});

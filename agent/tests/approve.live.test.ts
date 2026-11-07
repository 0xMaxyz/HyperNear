// LIVE=1 only (ci32, testnet): the UI's "Approve agent" path through the HTTP API, from a fresh key.
//   fresh key on leg2 -> GET /owner lists it in pendingApprovals -> the owner signs exactly that intent ->
//   POST /relay (owner_execute, MPC signs approveAgent) -> the relayer posts it to HL -> HL lists the agent.
// Writes agent/results/approve-live.json.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HyperNearClient, nearAccount, ownerIntentTypedData } from '@hypernear/client';
import { ReplayCache } from '../src/commands.ts';
import { loadConfig } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { DEFAULT_GUARD_CONFIG } from '../src/guard.ts';
import { Hedger } from '../src/hedge.ts';
import { Legs } from '../src/legs.ts';
import { hlPoster, RateLimiter, Relayer } from '../src/relayer.ts';
import { handler, type Deps } from '../src/server.ts';

const RPC = 'https://test.rpc.fastnear.com';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ownerKey = (): Hex =>
  (process.env.HYPERNEAR_TEST_OWNER_KEY as Hex) ??
  (process.env.NEAR_NETWORK === 'testnet' ? PUBLIC_TEST_OWNER_KEY : (() => { throw new Error('set HYPERNEAR_TEST_OWNER_KEY or NEAR_NETWORK=testnet'); })());

describe.skipIf(process.env.LIVE !== '1')('live: approveAgent end to end through the HTTP API', () => {
  it('a fresh leg2 key: listed by /owner, relayed, posted, listed by HL', async () => {
    const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
    const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8')).private_key;
    const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, key, RPC) });
    const owner = privateKeyToAccount(ownerKey());
    const o = owner.address.toLowerCase() as Hex;
    const config = { ...loadConfig({}), contractId };
    const bus = new EventBus();
    const legs = new Legs({ client, dataDir: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, network: 'testnet', coins: ['BTC'] });
    const d: Deps = {
      config, client, legs, bus,
      hedger: new Hedger(legs, config.policy, bus),
      relayer: new Relayer(client, new RateLimiter(100), hlPoster('testnet'), bus),
      replay: new ReplayCache(),
      guardConfig: DEFAULT_GUARD_CONFIG,
      pnlData: async () => [],
    };
    const server = createServer(handler(d));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await client.getOwner(o))?.frozen).toBe(false);
      legs.keys.ensure(o, 2, true); // a key HL has never seen, as on a fresh leg
      const view = await (await fetch(`${base}/owner/${o}`)).json();
      const intent = view.pendingApprovals.find((p: { leg: number }) => p.leg === 2);
      expect(intent).toMatchObject({ type: 'approveAgent', leg: 2, agentName: 'leash-leg2' });
      const leg2 = view.legs.find((l: { leg: number }) => l.leg === 2).address as Hex;

      const t0 = Date.now();
      const nonce = view.policy.nonce as number;
      const sig = await owner.signTypedData(ownerIntentTypedData({ chainTag: view.config.chainTag, contractId, owner: o, nonce, intent }) as never);
      const out = await (await fetch(`${base}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: o, nonce, intent, sig }) })).json();
      const ms = Date.now() - t0;
      expect(out).toMatchObject({ kind: 'approveAgent', leg: 2, agent: intent.agent, ok: true });

      const listed = await legs.hl.extraAgents({ user: leg2 });
      expect(listed.some((a) => a.address.toLowerCase() === intent.agent)).toBe(true);
      const after = await (await fetch(`${base}/owner/${o}`)).json();
      expect(after.pendingApprovals.some((p: { leg: number }) => p.leg === 2)).toBe(false);
      expect(bus.since().find((e) => e.type === 'agents.approved')?.data).toMatchObject({ owner: o, leg: 2, ok: true });

      mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
      writeFileSync(
        new URL('../results/approve-live.json', import.meta.url),
        JSON.stringify({ at: new Date().toISOString(), owner: o, contractId, leg: 2, leg2, agent: intent.agent, intent, txHash: out.txHash, hl: out.hl, hlListsAgent: true, msRelayAndPost: ms, config: view.config }, null, 2) + '\n'
      );
    } finally {
      server.close();
    }
  }, 120_000);
});

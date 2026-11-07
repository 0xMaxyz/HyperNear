// LIVE=1 only (ci32, testnet). Owner-mode usdClassTransfer through NearMasterSigner + core's HlClient, posted to
// Hyperliquid testnet; records the end-to-end latency (C6): NEAR tx + HL post + HL state change.
// Needs: the hypernear account key in ~/.near-credentials/testnet/<contract>.json (it relays and pays storage),
// and HYPERNEAR_TEST_OWNER_KEY, or NEAR_NETWORK=testnet to use the public test key.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { HlClient, type HlAsyncSigner } from '@perps-platform/core';
import { DEFAULT_RPC, HyperNearClient, NearMasterSigner, nearAccount, signOutToHex, type SignOut } from '../src';

const LIVE = process.env.LIVE === '1';
const HL_API = 'https://api.hyperliquid-testnet.xyz';
// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const PUBLIC_TEST_OWNER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

function ownerKey(): Hex {
  if (process.env.HYPERNEAR_TEST_OWNER_KEY) return process.env.HYPERNEAR_TEST_OWNER_KEY as Hex;
  if (process.env.NEAR_NETWORK === 'testnet') return PUBLIC_TEST_OWNER_KEY;
  throw new Error('set HYPERNEAR_TEST_OWNER_KEY, or NEAR_NETWORK=testnet to use the public test key');
}

async function info(body: object): Promise<any> {
  const r = await fetch(`${HL_API}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function balances(user: string) {
  const [perp, spot] = await Promise.all([info({ type: 'clearinghouseState', user }), info({ type: 'spotClearinghouseState', user })]);
  const spotUsdc = Number(spot.balances?.find((b: any) => b.coin === 'USDC')?.total ?? 0);
  return { perp: Number(perp.marginSummary?.accountValue ?? 0), spot: spotUsdc };
}

async function waitFor<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

describe.skipIf(!LIVE)('live: owner-mode usdClassTransfer on HL testnet (C6 end to end)', () => {
  it('signs through the contract, HL accepts, balances move; 5 runs', async () => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
    const cred = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${contractId}.json`, 'utf8'));
    const relayer = nearAccount(contractId, cred.private_key, DEFAULT_RPC.testnet);
    const client = new HyperNearClient({ contractId, sender: relayer });
    const owner = privateKeyToAccount(ownerKey());
    const ownerEvm = owner.address.toLowerCase() as Hex;

    const leg = await client.registerLeg(ownerEvm, 0);
    expect(leg).toBe(await client.deriveLegAddress(ownerEvm, 0));
    const signer = await NearMasterSigner.create({
      client, owner: ownerEvm, leg: 0, mode: 'owner',
      signOwnerIntent: (td) => owner.signTypedData(td as never),
    });

    // One-time funding of the owner's leg0 from the spike leg test/leg0 (admin_sign_hl exists in spike builds only).
    let bal = await balances(leg);
    if (bal.perp + bal.spot < 1.5) {
      const time = Date.now();
      const action = { type: 'usdSend', destination: leg, amount: '3', time };
      const { value } = await client.backend.call<SignOut>(contractId, 'admin_sign_hl', { path: 'test/leg0', action });
      const sig = signOutToHex(value);
      const res = await fetch(`${HL_API}/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: { ...action, hyperliquidChain: 'Testnet', signatureChainId: '0x66eee' },
          nonce: time,
          signature: { r: sig.slice(0, 66), s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130), 16) },
        }),
      });
      console.log('funding usdSend test/leg0 -> owner leg0:', JSON.stringify(await res.json()));
      bal = await waitFor(() => balances(leg), (b) => b.perp + b.spot >= 1.5);
    }
    console.log(`owner ${ownerEvm} leg0 ${leg} balances`, bal);

    let nearMs = 0;
    const timed: HlAsyncSigner = {
      address: signer.address,
      sign: async (p) => {
        const t = performance.now();
        const s = await signer.sign(p);
        nearMs = performance.now() - t;
        return s;
      },
    };
    const hl = new HlClient({ network: 'testnet', masterSigner: timed, signatureChainId: '0x66eee' });

    const rows: { near: number; post: number; total: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const before = await balances(leg);
      const toPerp = before.spot >= 0.2 && i % 2 === 1; // alternate perp -> spot -> perp
      const t0 = performance.now();
      const res = await hl.usdClassTransfer({ amount: '0.2', toPerp });
      const tPost = performance.now();
      expect(res.status).toBe('ok');
      await waitFor(() => balances(leg), (b) => Math.abs(b.spot - before.spot) >= 0.199);
      const tState = performance.now();
      rows.push({ near: nearMs, post: tPost - t0 - nearMs, total: tState - t0 });
      console.log(`run ${i} toPerp=${toPerp}: NEAR sign ${nearMs.toFixed(0)} ms, HL post ${(tPost - t0 - nearMs).toFixed(0)} ms, ` +
        `state visible after ${(tState - t0).toFixed(0)} ms`);
    }
    const col = (k: keyof (typeof rows)[0]) => rows.map((r) => r[k]);
    console.log(`C6 end-to-end (owner-mode usdClassTransfer, 5 runs): p50 ${pct(col('total'), 50).toFixed(0)} ms, ` +
      `p95 ${pct(col('total'), 95).toFixed(0)} ms; NEAR p50 ${pct(col('near'), 50).toFixed(0)} ms; HL post p50 ${pct(col('post'), 50).toFixed(0)} ms`);
  }, 600_000);
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, newCommand } from '@hypernear/client';
import { buildDryRunDeps, DRY_CONTRACT_ID } from '../src/dryrun.ts';
import { handler } from '../src/server.ts';

// the fixtures' owner is the well-known PUBLIC web3 test key (never funded)
const owner = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const OWNER = owner.address.toLowerCase() as `0x${string}`;

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

async function serve(fixture = 'hedged') {
  server = createServer(handler(buildDryRunDeps(fixture, { replayStartMs: 0, replaySpeed: 1000 })));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const signed = async (action: 'openHedge' | 'closeHedge', ratio = '0') => {
  const command = newCommand(OWNER, action, 'BTC', ratio);
  return { command, sig: await owner.signTypedData(commandTypedData('near-testnet', DRY_CONTRACT_ID, command) as never) };
};

describe('--dry-run --serve', () => {
  it('GET /owner: fixture legs, guard and break-even, marked dryRun', async () => {
    const base = await serve('hedged');
    const r = await (await fetch(`${base}/owner/${OWNER}`)).json();
    expect(r.dryRun).toBe(true);
    expect(r.legs.map((l: any) => l.leg)).toEqual([0, 1, 2]); // leg2 = the flat reserve
    expect(r.policy.agent).toBe('agent.dry-run');
    expect(r.breakeven[0]).toMatchObject({ coin: 'BTC', kind: 'price', feesPaid: 0, netFunding: 0 });
    expect(r.breakeven[0].netSize).toBeCloseTo(0.0002, 12);
  });

  it('commands are verified, then simulated', async () => {
    const base = await serve('hedged');
    const close = await (await post(`${base}/hedge/close`, await signed('closeHedge'))).json();
    expect(close).toMatchObject({ dryRun: true, plan: { ok: true } });
    expect(close.simulatedFills.map((f: any) => f.leg)).toEqual([0, 1]);
    const unsigned = await post(`${base}/hedge/close`, { owner: OWNER, coin: 'BTC' });
    expect(unsigned.status).toBe(401);
    expect((await unsigned.json()).dryRun).toBe(true);
    const refused = await post(`${base}/hedge/open`, await signed('openHedge', '0.5')); // leg1 already hedged in this fixture
    expect(refused.status).toBe(422);
  });

  it('POST /relay validates like the live relayer and simulates', async () => {
    const base = await serve();
    const r = await (await post(`${base}/relay`, { owner: OWNER, intent: { type: 'registerLeg', leg: 0 } })).json();
    expect(r).toMatchObject({ dryRun: true, simulated: true, kind: 'registerLeg' });
    expect((await post(`${base}/relay`, { owner: 'nope' })).status).toBe(400);
  });

  it('/events replays the recorded guard demo sequence', async () => {
    const base = await serve();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: guard.ok\ndata: {"id":1000007')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    const types = [...text.matchAll(/event: (\S+)/g)].map((m) => m[1]);
    expect(types).toEqual(['guard.ok', 'stress.marginMoved', 'stress.posted', 'guard.trigger', 'guard.rebalance.start', 'guard.rebalance.signed', 'guard.rebalance.posted', 'guard.ok']);
    expect(text).toMatch(/"dryRun":true/);
  });
});

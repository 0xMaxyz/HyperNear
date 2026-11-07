import { describe, expect, it } from 'vitest';
import { HyperNearClient, type NearBackend, type Revoked } from '@hypernear/client';
import { EventBus } from '../src/events.ts';
import { RateLimiter, Relayer } from '../src/relayer.ts';
import { OWNER } from './agent-helpers.ts';

const SIG = `0x${'ab'.repeat(65)}`;
const LEG0 = '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac';
const sigOut = (name: string, burn: string) => ({
  payload: '00'.repeat(32), big_r: `02${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id: 0,
  action: { type: 'approveAgent', agentAddress: burn, agentName: name, nonce: 1794000000000 },
});

function setup(revoked: Revoked[]) {
  const backend: NearBackend = {
    async view<T>(_c: string, method: string) {
      if (method === 'get_leg') return LEG0 as T;
      if (method === 'get_config') return { chain_tag: 'near-testnet', hl_mainnet: false } as T;
      throw new Error(method);
    },
    async call<T>() {
      return { txHash: 'txF', value: revoked as T };
    },
  };
  const posted: any[] = [];
  const bus = new EventBus();
  const relayer = new Relayer(new HyperNearClient({ contractId: 'leash.testnet', backend }), new RateLimiter(10), async (b) => {
    posted.push(b);
    return { status: 'ok', response: { type: 'default' } };
  }, bus);
  return { relayer, posted, bus };
}

describe('freeze relay: revoking approveAgent actions go to HL and to /events', () => {
  it('posts one approveAgent(burn) per revoked agent and emits agents.revoked', async () => {
    const burn0 = '0x00000000000000000000000000000000000000b0';
    const burn1 = '0x00000000000000000000000000000000000000b1';
    const { relayer, posted, bus } = setup([
      { leg: 0, name: 'leash-leg0', burn_address: burn0, signature: sigOut('leash-leg0', burn0) as never },
      { leg: 1, name: 'leash-leg1', burn_address: burn1, signature: null },
    ]);
    const out = await relayer.relay('1.2.3.4', { owner: OWNER, nonce: 4, intent: { type: 'freeze', frozen: true }, sig: SIG });
    expect(out).toMatchObject({ kind: 'freeze', txHash: 'txF' });
    expect(posted).toEqual([
      {
        action: { type: 'approveAgent', signatureChainId: '0x66eee', hyperliquidChain: 'Testnet', agentAddress: burn0, agentName: 'leash-leg0', nonce: 1794000000000 },
        nonce: 1794000000000,
        signature: { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27 },
      },
    ]);
    const e = bus.since().find((x) => x.type === 'agents.revoked')!;
    expect(e.data).toMatchObject({ owner: OWNER, legs: [{ leg: 0, ok: true }, { leg: 1, ok: false, hl: 'MPC sign failed' }] });
  });
});

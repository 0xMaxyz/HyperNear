import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { HlClient, testOnlyRawKeySigner, type HlTransport } from '../src';

const KEY = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

describe('HlClient.scheduleCancel', () => {
  it('sends an L1 scheduleCancel action with the agent signature, with and without a time', async () => {
    const bodies: any[] = [];
    const transport: HlTransport = {
      async request(endpoint, payload) {
        if (endpoint === 'exchange') bodies.push(payload);
        return { status: 'ok', response: { type: 'default' } };
      },
    };
    const client = new HlClient({ network: 'testnet', transport, agentSigner: testOnlyRawKeySigner(KEY) });
    await client.scheduleCancel({ time: 1_800_000_000_000 });
    await client.scheduleCancel();
    expect(bodies[0].action).toEqual({ type: 'scheduleCancel', time: 1_800_000_000_000 });
    expect(bodies[1].action).toEqual({ type: 'scheduleCancel' });
    expect(bodies[0].signature).toMatchObject({ r: expect.stringMatching(/^0x[0-9a-f]{64}$/), v: expect.any(Number) });
    expect(privateKeyToAccount(KEY).address).toBeTruthy();
  });

  it('needs an agent signer', async () => {
    const client = new HlClient({ network: 'testnet', transport: { request: async () => ({}) } });
    await expect(client.scheduleCancel({ time: 1 })).rejects.toThrow(/agentSigner/);
  });
});

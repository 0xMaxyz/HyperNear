/**
 * `HlClient.trailingStopOpen`: the SDK has no helper, so the action is hand-built. Its key order is part of the signed
 * hash, and the shape below is the one Hyperliquid testnet accepted (resting order, `orderType: "Trailing Stop Market"`).
 */
import { describe, expect, it } from 'vitest';

import { RelayRejectionError } from '../../src/client/relay-rejection';
import {
  HlClient,
  hashHlL1Action,
  testOnlyRawKeySigner,
  type HlAsyncSigner,
  type HlSignPayload,
  type HlTransport,
} from '../../src/hl';

const KEY = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const NONCE = 1_700_000_000_000;
const OK = { status: 'ok', response: { type: 'trailingStop', data: { oid: 64899131925 } } };

function setup(answer: unknown = OK) {
  const requests: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const transport: HlTransport = {
    request: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload as Record<string, unknown> });
      return answer;
    },
  };
  const base = testOnlyRawKeySigner(KEY);
  const signed: HlSignPayload[] = [];
  const agent: HlAsyncSigner = {
    address: base.address,
    sign: async (payload) => {
      signed.push(payload);
      return base.sign(payload);
    },
  };
  const masterSigned: HlSignPayload[] = [];
  const master: HlAsyncSigner = {
    address: base.address,
    sign: async (payload) => {
      masterSigned.push(payload);
      return base.sign(payload);
    },
  };
  const client = new HlClient({
    network: 'testnet',
    transport,
    agentSigner: agent,
    masterSigner: master,
    nonceSource: () => NONCE,
  });
  return { client, requests, signed, masterSigned };
}

describe('HlClient.trailingStopOpen', () => {
  it('posts the action in the field order the venue accepted, with defaults filled in', async () => {
    const { client, requests } = setup();
    await client.trailingStopOpen({ asset: 3, isBuy: false, size: '0.00021', retracement: { pct: '5%' } });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.endpoint).toBe('exchange');
    const { action, nonce } = requests[0]!.payload;
    expect(nonce).toBe(NONCE);
    expect(Object.keys(action as object)).toEqual([
      'type',
      'asset',
      'isBuy',
      'sz',
      'reduceOnly',
      'retracement',
      'activationPx',
    ]);
    expect(action).toEqual({
      type: 'trailingStop',
      asset: 3,
      isBuy: false,
      sz: '0.00021',
      reduceOnly: false,
      retracement: { pct: '5%' },
      activationPx: null,
    });
  });

  it('carries a price-distance retracement and an activation price through unchanged', async () => {
    const { client, requests } = setup();
    await client.trailingStopOpen({
      asset: 3,
      isBuy: true,
      size: '1',
      reduceOnly: true,
      retracement: { px: '3740' },
      activationPx: '76304',
    });
    expect(requests[0]?.payload.action).toMatchObject({
      isBuy: true,
      reduceOnly: true,
      retracement: { px: '3740' },
      activationPx: '76304',
    });
  });

  it('signs the hash of exactly the action it posts, with the agent signer only', async () => {
    const { client, requests, signed, masterSigned } = setup();
    await client.trailingStopOpen({ asset: 3, isBuy: false, size: '1', retracement: { pct: '5%' } });

    expect(masterSigned).toHaveLength(0);
    expect(signed).toHaveLength(1);
    const message = signed[0]!.message as { connectionId: string; source: string };
    expect(message.source).toBe('b');
    expect(message.connectionId).toBe(hashHlL1Action({ action: requests[0]!.payload.action as object, nonce: NONCE }));
    expect(requests[0]!.payload.signature).toBeDefined();
  });

  it('returns the venue answer', async () => {
    const { client } = setup();
    const result = await client.trailingStopOpen({ asset: 3, isBuy: false, size: '1', retracement: { pct: '5%' } });
    expect(result).toEqual(OK);
  });

  it('turns a venue rejection into a RelayRejectionError', async () => {
    const { client } = setup({ status: 'err', response: 'Trailing stop retracement too small' });
    await expect(
      client.trailingStopOpen({ asset: 3, isBuy: false, size: '1', retracement: { pct: '0.01%' } })
    ).rejects.toBeInstanceOf(RelayRejectionError);
  });
});

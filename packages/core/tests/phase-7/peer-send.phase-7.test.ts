import { describe, expect, it } from 'vitest';

import {
  PeerUsdSendError,
  planPeerUsdSend,
  type HlSpotMetaResult,
} from '../../src/index';

const DEST = '0x1111111111111111111111111111111111111111' as const;

const SPOT_META: HlSpotMetaResult = {
  universe: [],
  tokens: [
    {
      name: 'USDC',
      szDecimals: 8,
      weiDecimals: 8,
      index: 0,
      tokenId: '0xeb62eee3685fc4c43992febcd9e75443',
      isCanonical: true,
      evmContract: null,
      fullName: 'USD Coin',
      deployerTradingFeeShare: '0',
    },
  ],
};

describe('planPeerUsdSend', () => {
  it('uses sendAsset spot/spot on a unified account', () => {
    const plan = planPeerUsdSend({
      mode: 'unifiedAccount',
      destination: DEST,
      amountUsdc: '12.5',
      spotMeta: SPOT_META,
    });
    expect(plan).toEqual({
      action: 'sendAsset',
      params: {
        destination: DEST,
        sourceDex: 'spot',
        destinationDex: 'spot',
        token: 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
        amount: '12.5',
      },
    });
  });

  it('uses usdSend on a split account', () => {
    const plan = planPeerUsdSend({
      mode: 'default',
      destination: DEST,
      amountUsdc: '3',
      spotMeta: SPOT_META,
    });
    expect(plan).toEqual({
      action: 'usdSend',
      params: { destination: DEST, amount: '3' },
    });
  });

  it('refuses when the mode cannot be read', () => {
    expect(() =>
      planPeerUsdSend({
        mode: null,
        destination: DEST,
        amountUsdc: '1',
        spotMeta: SPOT_META,
      })
    ).toThrow(PeerUsdSendError);
  });

  it('refuses when spotMeta has no USDC token', () => {
    expect(() =>
      planPeerUsdSend({
        mode: 'unifiedAccount',
        destination: DEST,
        amountUsdc: '1',
        spotMeta: { universe: [], tokens: [] },
      })
    ).toThrow(PeerUsdSendError);
  });
});

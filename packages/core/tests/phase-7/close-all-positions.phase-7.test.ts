/**
 * Close All (task 7.3.8) at the seam it actually fails at.
 *
 * The panic button was the one order-placing path on `PerpsClient` that never
 * called `ensureApprovals()` — which reads, from a user's seat, as "every other
 * way of closing works, Close All does nothing". Pinned here, along with the
 * refusal path it shares with the rest of the relay:
 *
 *  1. **It approves first.** A batched reduce-only `order` is agent-signed like
 *     any other order, so it needs the same agent approval; without it the
 *     exchange refuses the batch while closing positions one at a time (paths
 *     that do approve) keeps working.
 *  2. **A refused batch is a failure, and says why.** The exchange's per-leg
 *     verdict has to reach the user as a rejection carrying its own reason, not
 *     as a closed confirmation over an account whose positions are all still
 *     open.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PerpsClient,
  RelayRejectionError,
  SdkManager,
  type AgentSignPayload,
  type AgentVaultAdapter,
  type HexAddress,
  type HlTransport,
  type MarketDataAdapter,
  type PerpsHostContext,
  type PreferencesAdapter,
  type WalletAdapter,
} from '../../src';

const MASTER = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const AGENT = privateKeyToAccount(`0x${'d4'.repeat(32)}`);

function hostContext(): PerpsHostContext {
  const wallet: WalletAdapter = {
    getAccount: async () => ({
      address: MASTER.address as HexAddress,
      capabilities: { canSelfSign: false, supportsBatchSign: false },
    }),
    signTypedData: async (request) => {
      const data = request.data as unknown as {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const { EIP712Domain: _omit, ...types } = data.types;
      return (await MASTER.signTypedData({
        domain: data.domain,
        types,
        primaryType: data.primaryType,
        message: data.message,
      } as never)) as HexAddress;
    },
    sendTransaction: async () => {
      throw new Error('not used');
    },
  };
  const agentVault: AgentVaultAdapter = {
    getOrCreateAgentSigner: async () => ({
      signer: {
        agentAddress: AGENT.address as HexAddress,
        sign: async (payload: AgentSignPayload) => {
          const { EIP712Domain: _omit, ...types } = payload.types as Record<string, unknown>;
          return (await AGENT.signTypedData({
            domain: payload.domain,
            types,
            primaryType: payload.primaryType,
            message: payload.message,
          } as never)) as HexAddress;
        },
      },
      isNew: false,
    }),
    getApproveSignatures: async () => [],
    saveApproveSignatures: async () => {},
  };
  const marketData: MarketDataAdapter = {
    getTopTokenList: async () => [],
    getBridgeQuote: async () => ({ tx: {} as never }),
    getPermission: async () => ({ is_support: true }),
  };
  const preferences: PreferencesAdapter = {
    getFavorites: async () => [],
    setFavorites: async () => {},
    getMarketSlippage: async () => 0.05,
    setMarketSlippage: async () => {},
    getSelectedCoin: async () => 'BTC',
    setSelectedCoin: async () => {},
    getQuoteUnit: async () => 'usd' as const,
    setQuoteUnit: async () => {},
    getLocale: async () => 'en',
    setLocale: async () => {},
  };
  return { wallet, agentVault, marketData, preferences };
}

interface ClientOptions {
  /** Open positions the clearinghouse reports, as `coin -> signed size`. */
  positions?: Array<[string, string]>;
  /** Per-leg outcome of the batched `order`, in request order. */
  orderStatuses?: Array<{ resting?: { oid: number } } | { error: string }>;
}

function makeClient(opts: ClientOptions = {}) {
  const positions = opts.positions ?? [['BTC', '0.5']];
  const exchangeActions: string[] = [];
  const orderBatches: Array<Array<Record<string, unknown>>> = [];

  const transport: HlTransport = {
    async request(endpoint, payload) {
      if (endpoint === 'exchange') {
        const action = (payload as { action: { type: string; orders?: Array<Record<string, unknown>> } })
          .action;
        exchangeActions.push(action.type);
        if (action.type === 'order') {
          orderBatches.push(action.orders ?? []);
          const statuses =
            opts.orderStatuses ?? (action.orders ?? []).map((_, i) => ({ resting: { oid: 100 + i } }));
          return { status: 'ok', response: { type: 'order', data: { statuses } } };
        }
        return { status: 'ok', response: { type: 'default' } };
      }
      const { type } = payload as { type: string };
      switch (type) {
        case 'meta':
          return {
            universe: [
              { name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 1 },
              { name: 'ETH', szDecimals: 4, maxLeverage: 50, marginTableId: 1 },
            ],
          };
        case 'allMids':
          return { BTC: '65000', ETH: '3200' };
        case 'extraAgents':
          return [];
        case 'clearinghouseState':
          return {
            marginSummary: { accountValue: '1000', totalMarginUsed: '100' },
            withdrawable: '900',
            assetPositions: positions.map(([coin, szi]) => ({
              type: 'oneWay',
              position: { coin, szi, entryPx: '64000', unrealizedPnl: '10', marginUsed: '100' },
            })),
          };
        default:
          throw new Error(`unexpected info request "${type}"`);
      }
    },
  };

  const client = new PerpsClient(hostContext(), new SdkManager({ isTestnet: true, transport }));
  return { client, exchangeActions, orderBatches };
}

describe('[7.3.8] Close All goes through the same approvals as every other order', () => {
  it('approves the agent before relaying the batched reduce-only close', async () => {
    const { client, exchangeActions, orderBatches } = makeClient();
    await client.connect();

    const result = await client.closeAllPositions();

    expect(exchangeActions).toEqual(['approveAgent', 'order']);
    expect(result.closedCoins).toEqual(['BTC']);
    // Reduce-only, opposite side of a long, at a market-crossing price.
    expect(orderBatches[0][0]).toMatchObject({ b: false, r: true, s: '0.5' });
  });

  it('relays nothing at all when the account is already flat', async () => {
    const { client, exchangeActions } = makeClient({ positions: [] });
    await client.connect();

    await expect(client.closeAllPositions()).resolves.toMatchObject({ closedCoins: [] });
    // No order — and no signature ceremony for one.
    expect(exchangeActions).not.toContain('order');
  });
});

describe('[7.3.8] a batch the exchange refused is not a success', () => {
  it('rejects with the exchange’s own reason rather than resolving ok', async () => {
    const { client } = makeClient({
      positions: [['BTC', '0.5']],
      orderStatuses: [{ error: 'Order has invalid size.' }],
    });
    await client.connect();

    const failure = await client.closeAllPositions().then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(RelayRejectionError);
    expect((failure as RelayRejectionError).reason).toContain('Order has invalid size.');
  });

  it('rejects when only one leg of the batch is refused, so a partial close is never silent', async () => {
    const { client } = makeClient({
      positions: [
        ['BTC', '0.5'],
        ['ETH', '-2'],
      ],
      orderStatuses: [{ resting: { oid: 1 } }, { error: 'Insufficient margin.' }],
    });
    await client.connect();

    await expect(client.closeAllPositions()).rejects.toBeInstanceOf(RelayRejectionError);
  });
});

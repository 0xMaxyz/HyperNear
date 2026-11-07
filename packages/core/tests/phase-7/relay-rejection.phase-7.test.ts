/**
 * [#789] Phase 7 · Task 7.10.4 — the exchange's own rejection reaches
 * `PerpsClient`'s caller as `RelayRejectionError`, not a bare thrown
 * `ApiRequestError` swallowed into a generic relay failure.
 *
 * `@nktkas/hyperliquid` throws `ApiRequestError` — carrying the exchange's own
 * sentence — for any order, cancel, modify or withdrawal Hyperliquid answers
 * with an error response. `HlClient` is the only file allowed to import that
 * SDK type (`tests/phase-1/sdk-adoption.phase-1.test.ts`'s boundary), so it
 * catches it and rethrows this package's own `RelayRejectionError` — the same
 * seam `AgentApprovalError` (#689) uses for the agent-approval leg, and the
 * type the relay routes in `apps/api` match against.
 *
 * What this suite pins:
 *
 *  - a rejected order (agent tier) and a rejected withdrawal (master tier)
 *    both throw `RelayRejectionError` carrying the exchange's sanitized
 *    reason, never the raw SDK error;
 *  - an oversized / control-char-laden upstream message is truncated and
 *    stripped by `sanitizeRelayRejectionReason` before it reaches `.reason`.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PERPS_AGENT_NAME,
  PerpsClient,
  RelayRejectionError,
  SdkManager,
  sanitizeRelayRejectionReason,
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

/** The agent is already approved and unexpired, so `ensureApprovals()` relays
 * nothing ahead of the order — the rejection under test is the order's own,
 * not an approval failure. */
function makeClient(options: { orderResponse?: unknown; withdrawResponse?: unknown } = {}) {
  const transport: HlTransport = {
    async request(endpoint, payload) {
      if (endpoint === 'exchange') {
        const action = (payload as { action: { type: string } }).action;
        if (action.type === 'order') {
          return options.orderResponse ?? { status: 'ok', response: { type: 'default' } };
        }
        if (action.type === 'withdraw3') {
          return options.withdrawResponse ?? { status: 'ok', response: { type: 'default' } };
        }
        return { status: 'ok', response: { type: 'default' } };
      }
      const { type } = payload as { type: string };
      switch (type) {
        case 'meta':
          return { universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 1 }] };
        case 'extraAgents':
          return [
            {
              address: AGENT.address,
              name: PERPS_AGENT_NAME,
              validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
            },
          ];
        default:
          throw new Error(`unexpected info request "${type}"`);
      }
    },
  };

  return new PerpsClient(hostContext(), new SdkManager({ isTestnet: true, transport }));
}

describe('[#789] a rejected order throws RelayRejectionError, carrying the exchange’s reason', () => {
  it('an upstream error on the bulk order response throws RelayRejectionError, not a raw SDK error', async () => {
    const upstreamReason = 'order 0: Order has invalid size.';
    const client = makeClient({
      orderResponse: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ error: 'Order has invalid size.' }] } },
      },
    });
    await client.connect();

    const failure = await client
      .placeMarketOrder({ coin: 'BTC', isBuy: true, size: '0.0001', midPx: '65000' })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayRejectionError);
    const rejection = failure as RelayRejectionError;
    expect(rejection.code).toBe('RELAY_REJECTED');
    expect(rejection.reason).toBe(upstreamReason);
  });

  it('places the order normally when the exchange accepts it', async () => {
    const client = makeClient();
    await client.connect();

    await expect(
      client.placeMarketOrder({ coin: 'BTC', isBuy: true, size: '0.0001', midPx: '65000' })
    ).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('[#789] a rejected withdrawal throws RelayRejectionError, carrying the exchange’s reason', () => {
  it('a top-level error withdraw3 response throws RelayRejectionError, not a raw SDK error', async () => {
    const upstreamReason = 'Error withdrawing from bridge';
    const client = makeClient({
      withdrawResponse: { status: 'err', response: upstreamReason },
    });
    await client.connect();

    const failure = await client
      .withdraw({ amount: '5', destination: MASTER.address as HexAddress })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayRejectionError);
    const rejection = failure as RelayRejectionError;
    expect(rejection.code).toBe('RELAY_REJECTED');
    expect(rejection.reason).toBe(upstreamReason);
  });
});

describe('[#789] the upstream reason is sanitized before it reaches .reason', () => {
  it('an oversized, control-char-laden message is truncated and stripped, not echoed raw', async () => {
    const escape = String.fromCharCode(0x1b);
    const nul = String.fromCharCode(0);
    const raw = `Order has invalid size.${nul}${escape}[31m ${'x'.repeat(300)}`;
    const client = makeClient({
      orderResponse: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ error: raw }] } },
      },
    });
    await client.connect();

    const failure = await client
      .placeMarketOrder({ coin: 'BTC', isBuy: true, size: '0.0001', midPx: '65000' })
      .then(() => null, (error: unknown) => error);

    const rejection = failure as RelayRejectionError;
    expect(rejection.reason.length).toBeLessThanOrEqual(240);
    expect(rejection.reason).not.toContain(nul);
    expect(rejection.reason).not.toContain(escape);
    expect(rejection.reason.endsWith('…')).toBe(true);
    expect(rejection.reason.startsWith('order 0: Order has invalid size.')).toBe(true);
  });

  it('collapses whitespace and strips control characters', () => {
    const escape = String.fromCharCode(0x1b);
    expect(sanitizeRelayRejectionReason(new Error('Order has\r\n  invalid\tsize'))).toBe(
      'Order has invalid size'
    );
    expect(sanitizeRelayRejectionReason(`log forged${escape}[31m line`)).toBe(
      'log forged [31m line'
    );
  });

  it('caps the length at 240 and falls back to a generic reason', () => {
    const long = sanitizeRelayRejectionReason(new Error('x'.repeat(500)));
    expect(long).toHaveLength(240);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizeRelayRejectionReason(undefined)).toMatch(/exchange rejected/);
    expect(sanitizeRelayRejectionReason(new Error('   '))).toMatch(/exchange rejected/);
  });
});

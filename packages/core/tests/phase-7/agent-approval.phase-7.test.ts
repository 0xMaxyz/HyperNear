/**
 * [#689] Phase 7 · Epic 7.8 · Task 7.8.8 — `ensureApprovals()` at the seam.
 *
 * Two things about the approval leg, pinned where they live rather than three
 * layers up in the relay:
 *
 *  1. **A failed approval is its own failure.** The `approveAgent` that
 *     precedes a session's first order can be refused on its own terms — an
 *     unfunded master account cannot approve an agent — and the whole 7.8.4
 *     walk read that refusal as "order relay failed" because it arrived
 *     wearing the same clothes as an order rejection. It now arrives as
 *     `AgentApprovalError`, carrying the exchange's own words, and the order
 *     is never built.
 *  2. **`approveBuilderFee` is inert, not missing.** It is the other half of
 *     `ensureApprovals` and shares the "no caller" shape #689 was filed over,
 *     but `PERPS_BUILD_FEE` is 0 by decision (ADR 1.6.1), so there is no
 *     builder to approve — and no reason to spend a `maxBuilderFee` read per
 *     order asking. Configuring a real builder re-activates both.
 */
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AgentApprovalError,
  PERPS_AGENT_NAME,
  PERPS_BUILDER_FEE_ENABLED,
  PerpsClient,
  SdkManager,
  sanitizeApprovalReason,
  type AgentSignPayload,
  type AgentVaultAdapter,
  type HexAddress,
  type HlTransport,
  type MarketDataAdapter,
  type PerpsHostContext,
  type PreferencesAdapter,
  type WalletAdapter,
} from '../../src';

const MASTER = privateKeyToAccount(`0x${'a7'.repeat(32)}`);
const AGENT = privateKeyToAccount(`0x${'b8'.repeat(32)}`);

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
  /** Refuse `approveAgent` the way the exchange refuses an unfunded account. */
  refuseApprovalWith?: string;
}

function makeClient(opts: ClientOptions = {}) {
  const infoRequests: string[] = [];
  const exchangeActions: string[] = [];

  const transport: HlTransport = {
    async request(endpoint, payload) {
      if (endpoint === 'exchange') {
        const action = (payload as { action: { type: string } }).action;
        exchangeActions.push(action.type);
        if (action.type === 'approveAgent' && opts.refuseApprovalWith) {
          return { status: 'err', response: opts.refuseApprovalWith };
        }
        if (action.type === 'order') {
          return {
            status: 'ok',
            response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }] } },
          };
        }
        return { status: 'ok', response: { type: 'default' } };
      }
      const { type } = payload as { type: string };
      infoRequests.push(type);
      switch (type) {
        case 'meta':
          return { universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 1 }] };
        // Never approved — the state the 7.8.4 walk found on-chain.
        case 'extraAgents':
          return [];
        default:
          throw new Error(`unexpected info request "${type}"`);
      }
    },
  };

  const client = new PerpsClient(
    hostContext(),
    new SdkManager({ isTestnet: true, transport })
  );
  return { client, infoRequests, exchangeActions };
}

const placeOrder = (client: PerpsClient) =>
  client.placeMarketOrder({ coin: 'BTC', isBuy: true, size: '0.01', midPx: '65000' });

describe('[7.8.8] a refused agent approval is reported as an approval failure', () => {
  it('throws AgentApprovalError carrying the exchange’s reason, and relays no order', async () => {
    const refusal = `Must deposit before performing actions. User: ${MASTER.address}`;
    const { client, exchangeActions } = makeClient({ refuseApprovalWith: refusal });
    await client.connect();

    const failure = await placeOrder(client).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AgentApprovalError);
    const approval = failure as AgentApprovalError;
    expect(approval.code).toBe('AGENT_APPROVAL_FAILED');
    expect(approval.reason).toBe(refusal);
    expect(approval.agentName).toBe(PERPS_AGENT_NAME);
    expect(approval.agentAddress.toLowerCase()).toBe(AGENT.address.toLowerCase());
    // The order was never built: the approval is a precondition, not a retry.
    expect(exchangeActions).toEqual(['approveAgent']);
  });

  it('relays the approval, then the order, when the exchange accepts it', async () => {
    const { client, exchangeActions } = makeClient();
    await client.connect();

    await expect(placeOrder(client)).resolves.toMatchObject({ status: 'ok' });
    expect(exchangeActions).toEqual(['approveAgent', 'order']);
  });
});

describe('[7.8.8] approveBuilderFee: inert by configuration, not missing', () => {
  it('ships with no builder configured, so nothing is approved or asked', async () => {
    // If this flips, the probe comes back and the recorded transport needs a
    // `maxBuilderFee` answer — which is the point of asserting it here.
    expect(PERPS_BUILDER_FEE_ENABLED).toBe(false);

    const { client, infoRequests, exchangeActions } = makeClient();
    await client.connect();
    await placeOrder(client);

    expect(exchangeActions).not.toContain('approveBuilderFee');
    expect(infoRequests).not.toContain('maxBuilderFee');
  });
});

describe('[7.8.8] the upstream reason is sanitized before it travels', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(sanitizeApprovalReason(new Error('Must deposit\r\n  before\tacting'))).toBe(
      'Must deposit before acting'
    );
    expect(sanitizeApprovalReason('log forged\u001B[31m line')).toBe('log forged [31m line');
  });

  it('caps the length and falls back to a generic reason', () => {
    const long = sanitizeApprovalReason(new Error('x'.repeat(500)));
    expect(long).toHaveLength(240);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizeApprovalReason(undefined)).toMatch(/refused the agent approval/);
    expect(sanitizeApprovalReason(new Error('   '))).toMatch(/refused the agent approval/);
  });

  it('keeps the cause chain intact for the relay’s error mapping', () => {
    const cause = new Error('upstream said no');
    const error = new AgentApprovalError({
      agentAddress: AGENT.address as HexAddress,
      agentName: PERPS_AGENT_NAME,
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('upstream said no');
  });
});

describe('[7.8.8] the approval never signs on the agent tier', () => {
  it('asks the MASTER wallet for the approval signature', async () => {
    const context = hostContext();
    const masterSign = vi.spyOn(context.wallet, 'signTypedData');
    const transport: HlTransport = {
      async request(endpoint, payload) {
        if (endpoint === 'exchange') {
          return { status: 'ok', response: { type: 'default' } };
        }
        const { type } = payload as { type: string };
        if (type === 'extraAgents') return [];
        throw new Error(`unexpected info request "${type}"`);
      },
    };
    const client = new PerpsClient(context, new SdkManager({ isTestnet: true, transport }));
    await client.connect();

    await client.ensureApprovals();

    expect(masterSign).toHaveBeenCalledTimes(1);
    const [request] = masterSign.mock.calls[0];
    expect(request.from.toLowerCase()).toBe(MASTER.address.toLowerCase());
    const payload = request.data as unknown as { primaryType: string };
    expect(payload.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
  });
});

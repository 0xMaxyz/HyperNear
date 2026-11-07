/**
 * [Phase 16 · Epic B.4/B.5] The API-key agent on the wire.
 *
 * Two failures these prevent, both of which pass every existing test:
 *
 *  - **an expiry request that never leaves.** `approveAgent` has no
 *    `validUntil` field, so a caller that sets one and never checks the wire
 *    gets Hyperliquid's default validity and a UI confidently reporting 180
 *    days. The assertion is on the relayed action, not on the parameter.
 *  - **an API-key agent nothing can revoke.** `revokeAgentByAddress`
 *    authorizes by NAME, and the API-key agent's on-chain name may carry the
 *    ` valid_until <ms>` suffix. An exact-string ownership check answers
 *    `foreign` about our own agent — an address that is genuinely ours, with
 *    nothing left that can take it off-chain. Exactly the bug the backup agent
 *    hit before `planAgentRevocation` learned a second name.
 *
 * What is deliberately NOT asserted: the resulting expiry. Whether Hyperliquid
 * honours 180 days, clamps it, or ignores the suffix is unmeasured until spike
 * 16.1.1(d). These tests pin what we SEND.
 *
 * Harness mirrors `backup-agent-approval.phase-4.test.ts`: a real `PerpsClient`
 * over a fake `HlTransport`, so the assertions are about the wire.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PERPS_AGENT_NAME,
  PERPS_API_AGENT_NAME,
  PERPS_MAX_AGENT_VALIDITY_MS,
  PerpsClient,
  SdkManager,
  type AgentSignPayload,
  type AgentVaultAdapter,
  type ExtraAgent,
  type HexAddress,
  type HlTransport,
  type MarketDataAdapter,
  type PerpsHostContext,
  type PreferencesAdapter,
  type SignTypedDataRequest,
  type WalletAdapter,
} from '../../src';

const MASTER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const API_AGENT = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const BROWSER_AGENT = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${'d4'.repeat(32)}`);

const DAY = 24 * 60 * 60 * 1000;

function agent(address: string, name: string, validUntil = Date.now() + 7 * DAY): ExtraAgent {
  return { address: address as HexAddress, name, validUntil };
}

interface Harness {
  client: PerpsClient;
  relayed: Array<{ type: string } & Record<string, unknown>>;
}

function makeHarness(agents: readonly ExtraAgent[]): Harness {
  const relayed: Harness['relayed'] = [];

  const wallet: WalletAdapter = {
    getAccount: async () => ({
      address: MASTER.address as HexAddress,
      capabilities: { canSelfSign: false, supportsBatchSign: false },
    }),
    signTypedData: async (request: SignTypedDataRequest) => {
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
        agentAddress: BROWSER_AGENT.address as HexAddress,
        sign: async (payload: AgentSignPayload) => {
          const { EIP712Domain: _omit, ...types } = payload.types as Record<string, unknown>;
          return (await BROWSER_AGENT.signTypedData({
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

  const transport: HlTransport = {
    async request(endpoint, payload) {
      const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      if (endpoint === 'exchange') {
        relayed.push(wire.action as { type: string } & Record<string, unknown>);
        return { status: 'ok', response: { type: 'default' } };
      }
      const typed = wire as { type: string };
      if (typed.type !== 'extraAgents') {
        throw new Error(`api-agent suite: unexpected info request "${typed.type}"`);
      }
      return agents.map((entry) => ({ ...entry }));
    },
  };

  const context: PerpsHostContext = { wallet, agentVault, marketData, preferences };
  return {
    client: new PerpsClient(context, new SdkManager({ isTestnet: true, transport })),
    relayed,
  };
}

async function connected(agents: readonly ExtraAgent[]): Promise<Harness> {
  const harness = makeHarness(agents);
  await harness.client.connect();
  return harness;
}

describe('[16.B.4] the expiry request reaches the wire, inside the name', () => {
  it('relays `perps-api valid_until <ms>` when an expiry is requested', async () => {
    const harness = await connected([]);
    const validUntil = Date.now() + PERPS_MAX_AGENT_VALIDITY_MS;

    const result = await harness.client.approveNamedAgent(
      API_AGENT.address as HexAddress,
      PERPS_API_AGENT_NAME,
      validUntil,
    );

    expect(result.status).toBe('approved');
    expect(harness.relayed).toHaveLength(1);
    // What we SEND. Not what Hyperliquid grants — unmeasured (spike 16.1.1(d)).
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: `${PERPS_API_AGENT_NAME} valid_until ${validUntil}`,
    });
  });

  it('relays the bare name when no expiry is requested, rather than a suffix of nothing', async () => {
    const harness = await connected([]);

    await harness.client.approveNamedAgent(API_AGENT.address as HexAddress, PERPS_API_AGENT_NAME);

    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: PERPS_API_AGENT_NAME,
    });
  });
});

describe('[16.B.5] an API-key agent can be taken off-chain', () => {
  it('revokes one whose on-chain name carries the expiry suffix', async () => {
    // The regression: an exact-string ownership check reports `foreign` here,
    // and a `foreign` refusal signs nothing — so a compromised API key would
    // stay approved for its full validity with no lever anywhere.
    const onChainName = `${PERPS_API_AGENT_NAME} valid_until ${Date.now() + 90 * DAY}`;
    const harness = await connected([agent(API_AGENT.address, onChainName)]);

    const result = await harness.client.revokeAgentByAddress(API_AGENT.address as HexAddress);

    expect(result).toEqual({
      status: 'revoked',
      agentAddress: API_AGENT.address,
      agentName: onChainName,
    });
    // Deleted under the name Hyperliquid REPORTED, not the base name: the
    // delete primitive is keyed on the registered string.
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: onChainName,
      agentAddress: '0x0000000000000000000000000000000000000000',
    });
  });

  it('still refuses another app’s agent, suffix or not', async () => {
    const harness = await connected([
      agent(STRANGER.address, `another-app valid_until ${Date.now() + 30 * DAY}`),
    ]);

    const result = await harness.client.revokeAgentByAddress(STRANGER.address as HexAddress);

    expect(result).toMatchObject({ status: 'foreign' });
    expect(harness.relayed).toEqual([]);
  });

  it('refuses when the API name has more than one holder, rather than guessing', async () => {
    // A name-keyed delete cannot say WHICH holder it removes ([#933]), and the
    // suffix must not hide that two entries are under the same base name.
    const other = privateKeyToAccount(`0x${'e5'.repeat(32)}`);
    const harness = await connected([
      agent(API_AGENT.address, `${PERPS_API_AGENT_NAME} valid_until ${Date.now() + 90 * DAY}`),
      agent(other.address, PERPS_API_AGENT_NAME),
    ]);

    const result = await harness.client.revokeAgentByAddress(API_AGENT.address as HexAddress);

    expect(result).toMatchObject({ status: 'ambiguous', agentsUnderName: 2 });
    expect(harness.relayed).toEqual([]);
  });

  it('leaves the browser agent alone — the names never collide', async () => {
    const harness = await connected([
      agent(API_AGENT.address, `${PERPS_API_AGENT_NAME} valid_until ${Date.now() + 90 * DAY}`),
      agent(BROWSER_AGENT.address, PERPS_AGENT_NAME),
    ]);

    const result = await harness.client.revokeAgentByAddress(API_AGENT.address as HexAddress);

    expect(result).toMatchObject({ status: 'revoked' });
    expect(harness.relayed).toHaveLength(1);
    expect(harness.relayed[0].agentName).not.toBe(PERPS_AGENT_NAME);
  });
});

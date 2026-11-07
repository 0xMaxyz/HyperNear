/**
 * ADR 0.7.1 option 3 — `PerpsClient.approveNamedAgent`, the missing on-chain
 * half of the trading-only backup passkey. Registering the credential
 * (`apps/api`, `credential_role = 'backup-agent'`) is a database row; this is
 * what makes Hyperliquid actually accept orders signed by its derived key —
 * a master-signed `approveAgent` naming the backup credential's own agent
 * address under `PERPS_BACKUP_AGENT_NAME`, distinct from the primary
 * session's own `PERPS_AGENT_NAME` slot ([#933]'s same-name collision note).
 *
 * Mirrors `agent-revoke.phase-7.test.ts`'s harness: a real `PerpsClient`
 * wired to a fake `HlTransport` that records what actually reached the
 * `exchange` endpoint and which tier (master vs. agent) signed it, so the
 * assertions are about the wire, not about a mocked method call.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AgentApprovalError,
  PERPS_AGENT_NAME,
  PERPS_BACKUP_AGENT_NAME,
  PERPS_MAX_AGENTS,
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
/** The backup credential's own PRF-derived agent-tier address. */
const BACKUP_AGENT = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
/** The primary session's random per-browser agent (ADR 7.14.3 decision 1). */
const PRIMARY_AGENT = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
/** An API wallet another app registered against the same account. */
const STRANGER = privateKeyToAccount(`0x${'d4'.repeat(32)}`);

const DAY = 24 * 60 * 60 * 1000;

function withName(address: string, name: string, validUntil = Date.now() + 7 * DAY): ExtraAgent {
  return { address: address as HexAddress, name, validUntil };
}

interface TypedDataPayload {
  primaryType?: string;
  message?: Record<string, unknown>;
}

interface Harness {
  client: PerpsClient;
  relayed: Array<{ type: string } & Record<string, unknown>>;
  info: Array<{ type: string; user?: string }>;
  masterSigned: TypedDataPayload[];
  agentSigned: AgentSignPayload[];
}

function makeHarness(agents: readonly ExtraAgent[], approveFails = false): Harness {
  const relayed: Harness['relayed'] = [];
  const info: Harness['info'] = [];
  const masterSigned: TypedDataPayload[] = [];
  const agentSigned: AgentSignPayload[] = [];

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
      masterSigned.push({ primaryType: data.primaryType, message: data.message });
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
        agentAddress: PRIMARY_AGENT.address as HexAddress,
        sign: async (payload: AgentSignPayload) => {
          agentSigned.push(payload);
          const { EIP712Domain: _omit, ...types } = payload.types as Record<string, unknown>;
          return (await PRIMARY_AGENT.signTypedData({
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
  const context: PerpsHostContext = { wallet, agentVault, marketData, preferences };

  const transport: HlTransport = {
    async request(endpoint, payload) {
      const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      if (endpoint === 'exchange') {
        const action = wire.action as { type: string } & Record<string, unknown>;
        if (action.type === 'approveAgent' && approveFails) {
          throw new Error('Must deposit before performing actions');
        }
        relayed.push(action);
        return { status: 'ok', response: { type: 'default' } };
      }
      const typed = wire as { type: string; user?: string };
      info.push({ type: typed.type, ...(typed.user ? { user: typed.user } : {}) });
      if (typed.type !== 'extraAgents') {
        throw new Error(`backup-agent-approval suite: unexpected info request "${typed.type}"`);
      }
      return agents.map((agent) => ({ ...agent }));
    },
  };

  return {
    client: new PerpsClient(context, new SdkManager({ isTestnet: true, transport })),
    relayed,
    info,
    masterSigned,
    agentSigned,
  };
}

async function connected(agents: readonly ExtraAgent[], approveFails = false): Promise<Harness> {
  const harness = makeHarness(agents, approveFails);
  await harness.client.connect();
  return harness;
}

describe('ADR 0.7.1 option 3 — approveNamedAgent registers the backup credential as a distinct agent', () => {
  it('relays exactly one master-signed approveAgent under PERPS_BACKUP_AGENT_NAME', async () => {
    const harness = await connected([]);

    const result = await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(result).toEqual({
      status: 'approved',
      agentAddress: BACKUP_AGENT.address,
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(harness.relayed).toHaveLength(1);
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(String(harness.relayed[0]!.agentAddress).toLowerCase()).toBe(
      BACKUP_AGENT.address.toLowerCase(),
    );
  });

  it('signs with the MASTER, never with the agent being approved', async () => {
    const harness = await connected([]);

    await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(harness.masterSigned).toHaveLength(1);
    expect(harness.masterSigned[0]!.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(harness.masterSigned[0]!.message).toMatchObject({
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(String(harness.masterSigned[0]!.message!.agentAddress).toLowerCase()).toBe(
      BACKUP_AGENT.address.toLowerCase(),
    );
    expect(harness.agentSigned).toHaveLength(0);
  });

  it('asks Hyperliquid about the master account, not the address being approved', async () => {
    const harness = await connected([]);

    await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    const reads = harness.info.filter((call) => call.type === 'extraAgents');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.user?.toLowerCase()).toBe(MASTER.address.toLowerCase());
  });

  it('does not disturb an existing PERPS_AGENT_NAME slot — the two names are independent', async () => {
    const harness = await connected([withName(PRIMARY_AGENT.address, PERPS_AGENT_NAME)]);

    await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(harness.relayed).toHaveLength(1);
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
  });

  it('is a no-op when the backup address already holds the slot and is not expiring', async () => {
    const harness = await connected([withName(BACKUP_AGENT.address, PERPS_BACKUP_AGENT_NAME)]);

    const result = await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(result).toEqual({
      status: 'already-approved',
      agentAddress: BACKUP_AGENT.address,
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('re-approves when the existing slot is inside the reapproval window', async () => {
    const soon = withName(
      BACKUP_AGENT.address,
      PERPS_BACKUP_AGENT_NAME,
      Date.now() + 12 * 60 * 60 * 1000,
    );
    const harness = await connected([soon]);

    const result = await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(result.status).toBe('approved');
    expect(harness.relayed).toHaveLength(1);
  });

  it('reports "blocked" without signing when the cap is full of foreign agents', async () => {
    // [#928] The cap is per ACCOUNT and shared with every app the wallet
    // touches — a full cap of strangers' API wallets must never be freed by
    // silently deleting one on the backup credential's behalf.
    const strangers = Array.from({ length: PERPS_MAX_AGENTS }, (_, i) => {
      const byte = (0x90 + i).toString(16).padStart(2, '0');
      const key = privateKeyToAccount(`0x${byte.repeat(32)}`);
      return withName(key.address, `stranger-${i}`);
    });
    const harness = await connected(strangers);

    const result = await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(result).toEqual({
      status: 'blocked',
      agentAddress: BACKUP_AGENT.address,
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('does not count a foreign agent toward the cap check for our own name', async () => {
    const harness = await connected([withName(STRANGER.address, 'app.hyperliquid.xyz')]);

    const result = await harness.client.approveNamedAgent(
      BACKUP_AGENT.address as HexAddress,
      PERPS_BACKUP_AGENT_NAME,
    );

    expect(result.status).toBe('approved');
    expect(harness.relayed).toHaveLength(1);
  });

  it('wraps an exchange rejection in AgentApprovalError, distinguishable from a relay failure', async () => {
    const harness = await connected([], /* approveFails */ true);

    await expect(
      harness.client.approveNamedAgent(BACKUP_AGENT.address as HexAddress, PERPS_BACKUP_AGENT_NAME),
    ).rejects.toThrow(AgentApprovalError);
  });

  it('throws when called before connect()', async () => {
    const harness = makeHarness([]);

    await expect(
      harness.client.approveNamedAgent(BACKUP_AGENT.address as HexAddress, PERPS_BACKUP_AGENT_NAME),
    ).rejects.toThrow('Not connected');
  });
});

/**
 * [#941] Phase 7 — "log out of this device": revoke THIS browser's agent, and
 * nothing else.
 *
 * The hazard this suite exists for is a mismatch between what we want to say
 * and what Hyperliquid can be told. **The delete primitive is name-keyed:**
 * `approveAgent(0x0, name)` unregisters whoever currently holds `name`, and
 * under ADR 7.14.3 every browser approves its own random key under the same
 * `PERPS_AGENT_NAME` (decisions 1 and 5). So the obvious implementation — reuse
 * `deleteOldestAgent` — signs a device out, just not necessarily *this* one:
 * the oldest agent under our name belongs to whichever browser approved first.
 * That is the exact inverse of #941's acceptance criterion, "end a session on
 * one device without affecting others", and it would be invisible until a user
 * on a second device found themselves logged out.
 *
 * `revokeAgentByAddress` therefore names its target by ADDRESS and refuses
 * whenever the name-keyed delete cannot be shown to land on exactly it. Three of
 * its four outcomes sign nothing, so the assertions below are mostly about
 * silence: what did NOT reach the exchange endpoint, and what the master was
 * NOT asked to sign.
 *
 *  - `not-registered` — the normal case, not an error. Another device replaced
 *    us in the name slot, or the cap rotated us out; there is nothing of ours
 *    on-chain, so there is nothing to revoke and no ceremony to spend.
 *  - `foreign` — the address is registered under someone else's name. #928's
 *    guarantee, restated for the address-targeted path.
 *  - `ambiguous` — ours, but sharing our name with another agent. This is the
 *    #933 uncertainty guard: while it is unverified whether a second address
 *    under one name replaces that slot or consumes another, a name-keyed delete
 *    cannot say which holder it removes.
 *  - `revoked` — exactly one master-signed `approveAgent(0x0, our name)`.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  DELETE_AGENT_EMPTY_ADDRESS,
  PERPS_AGENT_NAME,
  PERPS_BACKUP_AGENT_NAME,
  PerpsClient,
  SdkManager,
  planAgentRevocation,
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

const MASTER = privateKeyToAccount(`0x${'c1'.repeat(32)}`);
/** The random per-browser agent this device holds (ADR 7.14.3 decision 1). */
const THIS_DEVICE = privateKeyToAccount(`0x${'d2'.repeat(32)}`);
/** The same user's other browser — a different random key, the same name. */
const OTHER_DEVICE = privateKeyToAccount(`0x${'e3'.repeat(32)}`);
/** An API wallet another app registered against the same Hyperliquid account. */
const STRANGER = privateKeyToAccount(`0x${'f4'.repeat(32)}`);
/** A trading-only backup passkey's agent (ADR 0.7.1 option 3). */
const BACKUP_KEY = privateKeyToAccount(`0x${'a5'.repeat(32)}`);

const DAY = 24 * 60 * 60 * 1000;

/** Registered under OUR name, with a week of validity left. */
function ours(address: string, validUntil = Date.now() + 7 * DAY): ExtraAgent {
  return { address: address as HexAddress, name: PERPS_AGENT_NAME, validUntil };
}

/** Registered under somebody else's — the cap is per account, not per app. */
function theirs(address: string, name = 'app.hyperliquid.xyz'): ExtraAgent {
  return { address: address as HexAddress, name, validUntil: Date.now() + 30 * DAY };
}

/** Also ours, under our OTHER name — a trading-only backup passkey's agent. */
function backup(address: string, validUntil = Date.now() + 30 * DAY): ExtraAgent {
  return { address: address as HexAddress, name: PERPS_BACKUP_AGENT_NAME, validUntil };
}

interface TypedDataPayload {
  primaryType?: string;
  message?: Record<string, unknown>;
}

interface Harness {
  client: PerpsClient;
  /** Every action that reached the `exchange` endpoint, as it went on the wire. */
  relayed: Array<{ type: string } & Record<string, unknown>>;
  /** Every `info` request, so "which user did we ask about" is checkable. */
  info: Array<{ type: string; user?: string }>;
  /** What the MASTER wallet was asked to sign, in order. */
  masterSigned: TypedDataPayload[];
  /** What the AGENT tier was asked to sign — must stay empty here. */
  agentSigned: AgentSignPayload[];
}

function makeHarness(agents: readonly ExtraAgent[]): Harness {
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
        agentAddress: THIS_DEVICE.address as HexAddress,
        sign: async (payload: AgentSignPayload) => {
          agentSigned.push(payload);
          const { EIP712Domain: _omit, ...types } = payload.types as Record<string, unknown>;
          return (await THIS_DEVICE.signTypedData({
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
        relayed.push(wire.action as { type: string } & Record<string, unknown>);
        return { status: 'ok', response: { type: 'default' } };
      }
      const typed = wire as { type: string; user?: string };
      info.push({ type: typed.type, ...(typed.user ? { user: typed.user } : {}) });
      if (typed.type !== 'extraAgents') {
        throw new Error(`agent-revoke suite: unexpected info request "${typed.type}"`);
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

async function connected(agents: readonly ExtraAgent[]): Promise<Harness> {
  const harness = makeHarness(agents);
  await harness.client.connect();
  return harness;
}

describe('[#941] revokeAgentByAddress revokes this device’s agent', () => {
  it('relays exactly one master-signed approveAgent for the zero address under our name', async () => {
    const harness = await connected([ours(THIS_DEVICE.address)]);

    const result = await harness.client.revokeAgentByAddress(
      THIS_DEVICE.address as HexAddress
    );

    expect(result).toEqual({
      status: 'revoked',
      agentAddress: THIS_DEVICE.address,
      agentName: PERPS_AGENT_NAME,
    });

    // One action, and it is the delete: the zero address IS the delete verb.
    expect(harness.relayed).toHaveLength(1);
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: PERPS_AGENT_NAME,
      hyperliquidChain: 'Testnet',
    });
    expect(String(harness.relayed[0]!.agentAddress).toLowerCase()).toBe(
      DELETE_AGENT_EMPTY_ADDRESS
    );
  });

  it('signs the delete with the MASTER, never with the agent being revoked', async () => {
    // The sentinel-signer pattern `deleteOldestAgent` established: the agent
    // tier is re-seated on a signer that cannot sign at all, and the approval
    // is master-signed. An agent signing its own revocation would be a key we
    // are trying to retire authorizing its retirement.
    const harness = await connected([ours(THIS_DEVICE.address)]);

    await harness.client.revokeAgentByAddress(THIS_DEVICE.address as HexAddress);

    expect(harness.masterSigned).toHaveLength(1);
    expect(harness.masterSigned[0]!.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(harness.masterSigned[0]!.message).toMatchObject({
      agentName: PERPS_AGENT_NAME,
      agentAddress: DELETE_AGENT_EMPTY_ADDRESS,
    });
    expect(harness.agentSigned).toHaveLength(0);
  });

  it('asks Hyperliquid about the master, not about the agent it is revoking', async () => {
    // An agent wallet holds no agents of its own (#786), so asking about one
    // answers `[]` — indistinguishable from "already revoked", which would turn
    // every revoke into a silent no-op that leaves the key approved.
    const harness = await connected([ours(THIS_DEVICE.address)]);

    await harness.client.revokeAgentByAddress(THIS_DEVICE.address as HexAddress);

    const reads = harness.info.filter((call) => call.type === 'extraAgents');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.user?.toLowerCase()).toBe(MASTER.address.toLowerCase());
    expect(reads[0]!.user?.toLowerCase()).not.toBe(THIS_DEVICE.address.toLowerCase());
  });

  it('matches the stored address case-insensitively', async () => {
    // The browser stores a checksummed address; Hyperliquid answers lowercase.
    // A case-sensitive match would report `not-registered` for a live agent and
    // leave an approved key behind on a shared machine — a silent failure of
    // the exact protection this route provides.
    const harness = await connected([ours(THIS_DEVICE.address.toLowerCase())]);

    const result = await harness.client.revokeAgentByAddress(
      THIS_DEVICE.address.toUpperCase().replace('0X', '0x') as HexAddress
    );

    expect(result.status).toBe('revoked');
    expect(harness.relayed).toHaveLength(1);
  });
});

describe('[#941] a revoke that cannot be shown to hit this device signs nothing', () => {
  it('reports an unregistered agent as "not-registered" without erroring', async () => {
    // The ordinary state of a browser another device has since replaced. It has
    // to be an outcome, not a throw: a sign-out has already decided to end, and
    // a rejected promise here would surface as a failed logout.
    const harness = await connected([ours(OTHER_DEVICE.address)]);

    const result = await harness.client.revokeAgentByAddress(
      THIS_DEVICE.address as HexAddress
    );

    expect(result).toEqual({
      status: 'not-registered',
      agentAddress: THIS_DEVICE.address,
    });
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('reports an empty agent list as "not-registered", not as an error', async () => {
    const harness = await connected([]);

    await expect(
      harness.client.revokeAgentByAddress(THIS_DEVICE.address as HexAddress)
    ).resolves.toMatchObject({ status: 'not-registered' });
    expect(harness.relayed).toHaveLength(0);
  });

  it('refuses to revoke an agent registered under another app’s name', async () => {
    // [#928] The cap is per ACCOUNT and shared with every app the wallet
    // touches. Deleting under a stranger's name would sign the user out of a
    // product we have nothing to do with.
    const harness = await connected([theirs(STRANGER.address)]);

    const result = await harness.client.revokeAgentByAddress(STRANGER.address as HexAddress);

    expect(result).toEqual({
      status: 'foreign',
      agentAddress: STRANGER.address,
      agentName: 'app.hyperliquid.xyz',
    });
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('refuses as ambiguous when a second agent shares our name', async () => {
    // The #941 core criterion, at the only place it can be enforced. Both
    // entries are ours by name; the delete can only name the NAME, so it cannot
    // be shown to remove this device rather than the other one.
    const harness = await connected([
      ours(THIS_DEVICE.address),
      ours(OTHER_DEVICE.address, Date.now() + 3 * DAY),
    ]);

    const result = await harness.client.revokeAgentByAddress(
      THIS_DEVICE.address as HexAddress
    );

    expect(result).toEqual({
      status: 'ambiguous',
      agentAddress: THIS_DEVICE.address,
      agentName: PERPS_AGENT_NAME,
      agentsUnderName: 2,
    });
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('stays ambiguous no matter which of the shared-name agents is asked about', async () => {
    // Symmetry matters: if either device could revoke while the other could
    // not, the guard would depend on approval order rather than on the
    // ambiguity itself.
    const agents = [ours(THIS_DEVICE.address), ours(OTHER_DEVICE.address)];
    for (const target of [THIS_DEVICE.address, OTHER_DEVICE.address]) {
      const harness = await connected(agents);
      const result = await harness.client.revokeAgentByAddress(target as HexAddress);
      expect(result.status).toBe('ambiguous');
      expect(harness.relayed).toHaveLength(0);
    }
  });

  it('counts only agents under OUR name toward the ambiguity', async () => {
    // A stranger's API wallet in another slot is not a reason to refuse — it
    // cannot be what a delete under our name would hit.
    const harness = await connected([ours(THIS_DEVICE.address), theirs(STRANGER.address)]);

    const result = await harness.client.revokeAgentByAddress(
      THIS_DEVICE.address as HexAddress
    );

    expect(result.status).toBe('revoked');
    expect(harness.relayed).toHaveLength(1);
  });
});

describe('[#941] why this is not deleteOldestAgent', () => {
  it('deleteOldestAgent would revoke the OTHER device where revokeAgentByAddress refuses', async () => {
    // Same on-chain state, same account, two methods. `deleteOldestAgent` picks
    // by age and happily signs — with two devices under one name, the agent it
    // unregisters is the other browser's, ending a session on a machine the
    // user is not sitting at. That is the failure #941 forbids, so the
    // address-targeted path must NOT be able to reach the same outcome.
    const state = [
      ours(OTHER_DEVICE.address, Date.now() + 1 * DAY),
      ours(THIS_DEVICE.address, Date.now() + 9 * DAY),
    ];

    const cap = await connected(state);
    await cap.client.deleteOldestAgent();
    expect(cap.relayed).toHaveLength(1);

    const revoke = await connected(state);
    const result = await revoke.client.revokeAgentByAddress(
      THIS_DEVICE.address as HexAddress
    );
    expect(result.status).toBe('ambiguous');
    expect(revoke.relayed).toHaveLength(0);
  });
});

describe('[#941] planAgentRevocation is the decision, independent of the client', () => {
  it('honours a caller-supplied agent name on both sides of the check', async () => {
    const agents = [ours(THIS_DEVICE.address)];

    // Under the default name the entry is ours; under a different one the very
    // same entry is somebody else's — the name is the whole of the ownership
    // test, so it has to be a parameter rather than a hardcode.
    expect(
      planAgentRevocation({ agents, agentAddress: THIS_DEVICE.address as HexAddress })
    ).toMatchObject({ status: 'revocable' });
    expect(
      planAgentRevocation({
        agents,
        agentAddress: THIS_DEVICE.address as HexAddress,
        agentName: 'some-other-product',
      })
    ).toMatchObject({ status: 'foreign' });
  });

  it('reports how many agents share the name it refused on', async () => {
    const plan = planAgentRevocation({
      agents: [ours(THIS_DEVICE.address), ours(OTHER_DEVICE.address), theirs(STRANGER.address)],
      agentAddress: THIS_DEVICE.address as HexAddress,
    });

    expect(plan).toMatchObject({ status: 'ambiguous', agentsUnderName: 2 });
  });
});

// [ADR 0.7.1 option 3] A trading-only backup passkey is approved as an agent
// under `PERPS_BACKUP_AGENT_NAME`, deliberately distinct from the per-browser
// `PERPS_AGENT_NAME` so approving one never displaces the other ([#933]).
// That distinctness is exactly what broke revocation: this product owns TWO
// names now, and a revoke that knew only the first answered `foreign` for an
// address that is unambiguously ours. Nothing else can retire that key —
// removing the credential row deletes the sign-in path, not the on-chain
// approval — so a lost backup security key would have stayed able to trade
// for its full validity window with no shipped lever to stop it.
describe('[ADR 0.7.1] a trading-only backup passkey’s agent can be revoked', () => {
  it('revokes an agent registered under the backup name', async () => {
    const harness = await connected([backup(BACKUP_KEY.address)]);

    const result = await harness.client.revokeAgentByAddress(BACKUP_KEY.address as HexAddress);

    expect(result).toEqual({
      status: 'revoked',
      agentAddress: BACKUP_KEY.address,
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
  });

  it('deletes under the BACKUP name, so the per-browser agent survives', async () => {
    // Hyperliquid's delete primitive is name-keyed: `approveAgent(0x0, name)`
    // unregisters whoever holds `name`. Naming `PERPS_AGENT_NAME` here would
    // revoke this browser's own trading key and leave the stolen backup one
    // approved — the precise inverse of what the user asked for.
    const harness = await connected([ours(THIS_DEVICE.address), backup(BACKUP_KEY.address)]);

    await harness.client.revokeAgentByAddress(BACKUP_KEY.address as HexAddress);

    expect(harness.relayed).toHaveLength(1);
    expect(harness.relayed[0]).toMatchObject({
      type: 'approveAgent',
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
    expect(String(harness.relayed[0]!.agentAddress).toLowerCase()).toBe(DELETE_AGENT_EMPTY_ADDRESS);
    expect(harness.masterSigned[0]!.message).toMatchObject({
      agentName: PERPS_BACKUP_AGENT_NAME,
    });
  });

  it('does not make our two names ambiguous with each other', async () => {
    // Ambiguity is counted under the target's OWN name, because only another
    // holder of that same name can make the name-keyed delete land on the
    // wrong agent. Counting across both owned names would have deadlocked the
    // ordinary state — one browser agent plus one backup passkey — into
    // refusing to revoke either.
    const agents = [ours(THIS_DEVICE.address), backup(BACKUP_KEY.address)];
    const owned = [PERPS_AGENT_NAME, PERPS_BACKUP_AGENT_NAME];

    expect(
      planAgentRevocation({ agents, agentAddress: BACKUP_KEY.address as HexAddress, agentName: owned })
    ).toMatchObject({ status: 'revocable' });
    expect(
      planAgentRevocation({ agents, agentAddress: THIS_DEVICE.address as HexAddress, agentName: owned })
    ).toMatchObject({ status: 'revocable' });
  });

  it('still refuses another app’s agent when both our names are owned', async () => {
    // Widening `agentName` to a list must not widen what counts as ours.
    const harness = await connected([theirs(STRANGER.address)]);

    const result = await harness.client.revokeAgentByAddress(STRANGER.address as HexAddress);

    expect(result.status).toBe('foreign');
    expect(harness.relayed).toHaveLength(0);
    expect(harness.masterSigned).toHaveLength(0);
  });

  it('stays ambiguous when two agents share the backup name', async () => {
    const plan = planAgentRevocation({
      agents: [backup(BACKUP_KEY.address), backup(OTHER_DEVICE.address)],
      agentAddress: BACKUP_KEY.address as HexAddress,
      agentName: [PERPS_AGENT_NAME, PERPS_BACKUP_AGENT_NAME],
    });

    expect(plan).toMatchObject({ status: 'ambiguous', agentsUnderName: 2 });
  });
});

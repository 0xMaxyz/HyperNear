/**
 * [#949] Phase 7 — every agent-tier action ensures its agent is approved.
 *
 * `updateLeverage`, `adjustIsolatedMargin`, `cancelOrder(s)` and
 * `modifyOrder(s)` now `await ensureApprovals()`, joining the order paths that
 * always did. Adding that call to six methods left the whole suite green —
 * which is the finding, not the reassurance: **nothing observed these paths**,
 * so the approval could be dropped from any of them again without a single
 * test going red. This file is what holds it.
 *
 * What was wrong, per the [#949] amendment to
 * [ADR 7.8.8](../../../../docs/roadmap/adr/7.8.8-agent-approval.md)
 * § *What this does not cover*:
 *
 *  - **Cancel/modify** were excluded because "reaching them requires an order
 *    to have been placed, which is what establishes the approval". That was
 *    true while the agent was PRF-derived and therefore the same address on
 *    every device. [ADR 7.14.3](../../../../docs/roadmap/adr/7.14.3-unified-random-agent.md)
 *    decision 1 made the agent **random and per-browser**, and the sentence
 *    quietly stopped being true: a second device can see and cancel an order
 *    the first one placed while holding an agent this account never approved.
 *  - **The risk-config pair** were excluded as "risk config that moves no
 *    funds out of the account". That conflates two questions — moving no funds
 *    decides whether a *master step-up* is needed; it says nothing about
 *    whether the *agent* signing the action is registered on-chain.
 *
 * Either way the action was signed by a key Hyperliquid does not recognise and
 * refused upstream, so skipping the check never saved a prompt — it converted
 * a prompt into a rejection.
 *
 * The harness is the one `agent-approval.phase-7.test.ts` and
 * `close-all-positions.phase-7.test.ts` use: a real `PerpsClient` over a fake
 * `HlTransport`, asserting on what reaches the wire. All six methods drive the
 * identical seam (`ensureApprovals` → `checkAgentExpiry` → `extraAgents`), so
 * they share one harness; only the wire action they end with differs.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AgentApprovalError,
  PERPS_AGENT_NAME,
  PERPS_MAX_AGENTS,
  PerpsClient,
  SdkManager,
  type AgentSignPayload,
  type AgentVaultAdapter,
  type HexAddress,
  type HlExtraAgent,
  type HlTransport,
  type MarketDataAdapter,
  type PerpsHostContext,
  type PreferencesAdapter,
  type WalletAdapter,
} from '../../src';

const MASTER = privateKeyToAccount(`0x${'19'.repeat(32)}`);
/** This browser's agent — random per browser since ADR 7.14.3 decision 1. */
const AGENT = privateKeyToAccount(`0x${'2a'.repeat(32)}`);
/** The *other* device's agent for the same account: same name, different key. */
const OTHER_DEVICE_AGENT = privateKeyToAccount(`0x${'3b'.repeat(32)}`);

const DAY_MS = 24 * 60 * 60 * 1000;

function hostContext(canSelfSign: boolean): PerpsHostContext {
  const wallet: WalletAdapter = {
    getAccount: async () => ({
      address: MASTER.address as HexAddress,
      capabilities: { canSelfSign, supportsBatchSign: false },
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

/** An agent registered on-chain and comfortably outside the <24h re-approval window. */
function registeredAgent(address: HexAddress, name = PERPS_AGENT_NAME): HlExtraAgent {
  return { address, name, validUntil: Date.now() + 7 * DAY_MS };
}

interface ClientOptions {
  /**
   * What `extraAgents` reports for the master. Defaults to `[]` — never
   * approved, the state every new browser is in.
   */
  extraAgents?: HlExtraAgent[];
  /** A wallet that is its own agent (ADR 7.8.8 decision 5 / ADR 7.13). */
  canSelfSign?: boolean;
}

function makeClient(opts: ClientOptions = {}) {
  const exchangeActions: string[] = [];
  const infoRequests: string[] = [];
  const approvals: Array<{ agentAddress: string; agentName: string }> = [];

  const transport: HlTransport = {
    async request(endpoint, payload) {
      if (endpoint === 'exchange') {
        const action = (payload as {
          action: { type: string; agentAddress?: string; agentName?: string };
        }).action;
        exchangeActions.push(action.type);
        if (action.type === 'approveAgent') {
          approvals.push({
            agentAddress: action.agentAddress ?? '',
            agentName: action.agentName ?? '',
          });
        }
        if (action.type === 'cancel') {
          return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
        }
        if (action.type === 'order' || action.type === 'batchModify') {
          return {
            status: 'ok',
            response: { type: 'order', data: { statuses: [{ resting: { oid: 42 } }] } },
          };
        }
        return { status: 'ok', response: { type: 'default' } };
      }
      const { type } = payload as { type: string };
      infoRequests.push(type);
      switch (type) {
        case 'meta':
          return { universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 1 }] };
        case 'extraAgents':
          return opts.extraAgents ?? [];
        default:
          throw new Error(`unexpected info request "${type}"`);
      }
    },
  };

  const client = new PerpsClient(
    hostContext(opts.canSelfSign ?? false),
    new SdkManager({ isTestnet: true, transport })
  );
  return { client, exchangeActions, infoRequests, approvals };
}

/**
 * The six methods [#949] added `ensureApprovals()` to. `wireAction` is the
 * action type each one puts on the exchange endpoint — `cancelOrder` is a
 * one-entry `batchCancel` upstream, so both cancel paths sign a `cancel`.
 */
const AGENT_TIER_ACTIONS = [
  {
    method: 'updateLeverage',
    wireAction: 'updateLeverage',
    run: (client: PerpsClient) => client.updateLeverage({ coin: 'BTC', leverage: 5, isCross: true }),
  },
  {
    method: 'adjustIsolatedMargin',
    wireAction: 'updateIsolatedMargin',
    run: (client: PerpsClient) =>
      client.adjustIsolatedMargin({ coin: 'BTC', isBuy: true, usd: '25' }),
  },
  {
    method: 'cancelOrder',
    wireAction: 'cancel',
    run: (client: PerpsClient) => client.cancelOrder({ coin: 'BTC', oid: 42 }),
  },
  {
    method: 'cancelOrders',
    wireAction: 'cancel',
    run: (client: PerpsClient) => client.cancelOrders({ cancels: [{ coin: 'BTC', oid: 42 }] }),
  },
  {
    method: 'modifyOrder',
    wireAction: 'modify',
    run: (client: PerpsClient) =>
      client.modifyOrder({ coin: 'BTC', oid: 42, isBuy: true, size: '0.01', px: '64000' }),
  },
  {
    method: 'modifyOrders',
    wireAction: 'batchModify',
    run: (client: PerpsClient) =>
      client.modifyOrders({
        modifies: [{ coin: 'BTC', oid: 42, isBuy: true, size: '0.01', px: '64000' }],
      }),
  },
] as const;

describe.each(AGENT_TIER_ACTIONS)(
  '[#949] $method ensures its agent is approved',
  ({ wireAction, run }) => {
    it('relays approveAgent BEFORE the action when the agent is not registered', async () => {
      // Order is the whole assertion. Both actions happening is not enough:
      // an approval that lands after the action leaves the action itself
      // signed by a key Hyperliquid does not recognise, which is the upstream
      // rejection this task exists to remove. Asserting the exact sequence is
      // what fails if the `await ensureApprovals()` line is dropped.
      const { client, exchangeActions } = makeClient();
      await client.connect();

      await expect(run(client)).resolves.toMatchObject({ status: 'ok' });

      expect(exchangeActions).toEqual(['approveAgent', wireAction]);
    });

    it('relays no approveAgent when the agent is already registered and not near expiry', async () => {
      // The added call must be a *check*, not an unconditional prompt: a
      // session whose agent is already good pays no master ceremony. Without
      // this, `ensureApprovals()` could be replaced by an unconditional
      // `approveAgent` and the test above would still pass — while every
      // cancel cost the user a biometric.
      const { client, exchangeActions, infoRequests } = makeClient({
        extraAgents: [registeredAgent(AGENT.address as HexAddress)],
      });
      await client.connect();

      await expect(run(client)).resolves.toMatchObject({ status: 'ok' });

      expect(exchangeActions).toEqual([wireAction]);
      // The short-circuit is `planAgentApproval`'s, downstream of the read —
      // so the read still happens. Pinning it here means removing the
      // `ensureApprovals()` call fails this case too, not just the one above.
      expect(infoRequests).toContain('extraAgents');
    });
  }
);

describe('[#949] the cross-device case ADR 7.8.8 was amended for', () => {
  it('a second device that has placed NO order can still cancel one the first device placed', async () => {
    // The scenario the amendment names: sign in on a second device, see the
    // orders the first one placed, cancel one. ADR 7.8.8 excluded cancel
    // because "reaching it requires an order to have been placed" — true only
    // while the agent was PRF-derived and identical everywhere. Since ADR
    // 7.14.3 decision 1 the agent is random per browser, so the account's
    // named slot is held by the OTHER device's key and this browser's agent is
    // unregistered. It must approve, not fail.
    const { client, exchangeActions, infoRequests, approvals } = makeClient({
      extraAgents: [registeredAgent(OTHER_DEVICE_AGENT.address as HexAddress)],
    });
    await client.connect();

    await expect(client.cancelOrder({ coin: 'BTC', oid: 42 })).resolves.toMatchObject({
      status: 'ok',
    });

    // Nothing was traded in this session — the cancel is the first action, so
    // no order path could have established the approval on its behalf.
    expect(exchangeActions).toEqual(['approveAgent', 'cancel']);
    expect(infoRequests).toContain('extraAgents');
    // And it approved THIS browser's agent. Another device holding the same
    // named slot does not make this key signable: matching is by address, and
    // treating the name as sufficient would relay a cancel signed by a key the
    // exchange has never seen.
    expect(approvals).toHaveLength(1);
    expect(approvals[0].agentAddress.toLowerCase()).toBe(AGENT.address.toLowerCase());
    expect(approvals[0].agentName).toBe(PERPS_AGENT_NAME);
    expect(approvals[0].agentAddress.toLowerCase()).not.toBe(
      OTHER_DEVICE_AGENT.address.toLowerCase()
    );
  });
});

describe('[#949] a cap full of other apps’ agents fails before anything is relayed', () => {
  it('raises AgentApprovalError instead of signing a doomed action, on every one of the six', async () => {
    // `PERPS_MAX_AGENTS` is Hyperliquid's PER-ACCOUNT cap, shared with every
    // app the wallet uses. When it is full and no slot is ours, there is
    // nothing of ours to delete and the approval cannot proceed — so the
    // action must fail here, with a reason the user can act on, rather than be
    // signed by an unregistered agent and refused upstream as a generic relay
    // failure. One test over all six: the failure is `ensureApprovals`'s and
    // is identical on each path, so six copies would assert one thing.
    const foreignAgents = Array.from({ length: PERPS_MAX_AGENTS }, (_, i) =>
      registeredAgent(`0x${String(i + 1).repeat(40)}` as HexAddress, `other-app-${i}`)
    );

    for (const { method, run } of AGENT_TIER_ACTIONS) {
      const { client, exchangeActions } = makeClient({ extraAgents: foreignAgents });
      await client.connect();

      const failure = await run(client).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure, `${method} should refuse`).toBeInstanceOf(AgentApprovalError);
      expect((failure as AgentApprovalError).code).toBe('AGENT_APPROVAL_FAILED');
      expect((failure as AgentApprovalError).reason).toContain('revoke one of them');
      // Nothing reached the exchange: not the approval (it would be refused),
      // and above all not the action itself.
      expect(exchangeActions, `${method} should relay nothing`).toEqual([]);
    }
  });
});

describe('[#949] a self-signing wallet pays no read for the check', () => {
  it('reads extraAgents on none of the six when the account can self-sign', async () => {
    // `canSelfSign` accounts are their own agent, so `checkAgentExpiry`
    // returns before any upstream read (ADR 7.8.8 decision 5). That short
    // circuit is what makes the accepted cost of #949 — one `extraAgents` read
    // per cancel, against a per-IP rate limit with a recorded storm behind it
    // (#690) — land only on sessions that actually need it. Without this, a
    // wallet session that signs for itself would pay a read per cancel to
    // re-learn a fact that is true by construction.
    for (const { method, wireAction, run } of AGENT_TIER_ACTIONS) {
      const { client, exchangeActions, infoRequests } = makeClient({ canSelfSign: true });
      await client.connect();

      await expect(run(client)).resolves.toMatchObject({ status: 'ok' });

      expect(infoRequests, `${method} should not read extraAgents`).not.toContain('extraAgents');
      expect(exchangeActions, `${method} should relay only its own action`).toEqual([wireAction]);
    }
  });
});

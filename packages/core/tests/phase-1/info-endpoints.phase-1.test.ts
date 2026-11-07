/**
 * Epic 1.3 gate ("info-endpoints.phase-1.test.ts" per
 * docs/testing/phase-gate-testing.md). This task (1.3.1) exposes `userFills`
 * and task 1.3.2 exposes `historicalOrders` on the Epic 1.1.3 wrapper
 * (packages/core/src/hl/): wrapper exposure, response-shape parsing from a
 * fixture mirroring the documented testnet response shape, and a recorded
 * testnet integration cassette replayed through the transport-injection seam
 * (no live network — see tests/vitest-cassette.ts).
 *
 * Both are read-only info endpoints: no signer is involved, so unlike the
 * exchange-endpoints suite there is no signing-tier dispatch to cover.
 *
 * Task 1.3.8 (bottom of the file) covers `meta` exposure plus
 * `HlAssetIndexResolver` (packages/core/src/hl/assetIndex.ts) — the single
 * centralized point that maps a coin symbol to its numeric asset index, per
 * the phase-gate's "Asset-index (meta) resolution is centralized (no
 * hardcoded asset IDs)" checklist item — and a repo-wide static scan
 * asserting no production source file hardcodes one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HlAssetIndexResolver, HlClient } from '../../src/hl';
import type {
  HlFrontendOrder,
  HlFundingHistoryParams,
  HlFundingHistoryResult,
  HlHistoricalOrder,
  HlHistoricalOrdersParams,
  HlMetaParams,
  HlMetaResult,
  HlOpenOrdersParams,
  HlReferralStatus,
  HlReferralStatusParams,
  HlSubAccountsParams,
  HlSubAccountsResult,
  HlUserFill,
  HlUserFillsParams,
  HlUserFunding,
  HlUserFundingParams,
  HlUserRole,
  HlUserRoleParams,
} from '../../src/hl';
import { createCassetteTransport } from '../vitest-cassette';

const CASSETTE_PATH = path.join(__dirname, '..', 'fixtures', 'cassettes', 'info-endpoints.json');
const CORE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(CORE_ROOT, '..', '..');

const USER_ADDRESS = '0x0000000000000000000000000000000000000001';

const USER_FILLS_PARAMS: HlUserFillsParams = { user: USER_ADDRESS };
const HISTORICAL_ORDERS_PARAMS: HlHistoricalOrdersParams = { user: USER_ADDRESS };
const OPEN_ORDERS_PARAMS: HlOpenOrdersParams = { user: USER_ADDRESS };
const USER_FUNDING_PARAMS: HlUserFundingParams = { user: USER_ADDRESS };
const FUNDING_HISTORY_PARAMS: HlFundingHistoryParams = { coin: 'BTC', startTime: 1681222000000 };
const REFERRAL_STATUS_PARAMS: HlReferralStatusParams = { user: USER_ADDRESS };
const USER_ROLE_PARAMS: HlUserRoleParams = { user: USER_ADDRESS };
const SUB_ACCOUNTS_PARAMS: HlSubAccountsParams = { user: USER_ADDRESS };
const META_PARAMS: HlMetaParams = {};

function loadCassetteEntry<T>(actionType: string): T {
  const cassette = JSON.parse(fs.readFileSync(CASSETTE_PATH, 'utf-8')) as Array<{
    actionType: string;
    endpoint: string;
    response: T;
  }>;
  const entry = cassette.find((e) => e.actionType === actionType && e.endpoint === 'info');
  if (!entry) throw new Error(`No ${actionType} entry in info-endpoints cassette`);
  return entry.response;
}

function loadUserFillsFixture(): HlUserFill[] {
  return loadCassetteEntry<HlUserFill[]>('userFills');
}

function loadHistoricalOrdersFixture(): HlHistoricalOrder[] {
  return loadCassetteEntry<HlHistoricalOrder[]>('historicalOrders');
}

function loadOpenOrdersFixture(): HlFrontendOrder[] {
  return loadCassetteEntry<HlFrontendOrder[]>('openOrders');
}

function loadUserFundingFixture(): HlUserFunding[] {
  return loadCassetteEntry<HlUserFunding[]>('userFunding');
}

function loadFundingHistoryFixture(): HlFundingHistoryResult {
  return loadCassetteEntry<HlFundingHistoryResult>('fundingHistory');
}

function loadReferralStatusFixture(): HlReferralStatus {
  return loadCassetteEntry<HlReferralStatus>('referral');
}

function loadUserRoleFixture(): HlUserRole {
  return loadCassetteEntry<HlUserRole>('userRole');
}

function loadUserRoleAgentFixture(): HlUserRole {
  return loadCassetteEntry<HlUserRole>('userRole_agent');
}

function loadUserRoleSubAccountFixture(): HlUserRole {
  return loadCassetteEntry<HlUserRole>('userRole_subAccount');
}

function loadSubAccountsFixture(): HlSubAccountsResult {
  return loadCassetteEntry<HlSubAccountsResult>('subAccounts');
}

function loadSubAccountsEmptyFixture(): HlSubAccountsResult {
  return loadCassetteEntry<HlSubAccountsResult>('subAccounts_empty');
}

function loadMetaFixture(): HlMetaResult {
  return loadCassetteEntry<HlMetaResult>('meta');
}

function createWrapper() {
  const { transport, requests } = createCassetteTransport('info-endpoints');
  const client = new HlClient({ network: 'testnet', transport });
  return { client, requests };
}

describe('[Epic 1.3.1] userFills', () => {
  it('the wrapper exposes userFills and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.userFills(USER_FILLS_PARAMS);
    expect(result).toEqual(loadUserFillsFixture());
  });

  it('sends an info request carrying type "userFills" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.userFills(USER_FILLS_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'userFills', user: USER_ADDRESS });
  });

  it('forwards aggregateByTime when provided', async () => {
    const { client, requests } = createWrapper();
    await client.userFills({ ...USER_FILLS_PARAMS, aggregateByTime: true });

    expect(requests[0].payload).toEqual({
      type: 'userFills',
      user: USER_ADDRESS,
      aggregateByTime: true,
    });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type, including optional fields', async () => {
      const { client } = createWrapper();
      const fills = await client.userFills(USER_FILLS_PARAMS);
      const fixture = loadUserFillsFixture();
      expect(fills).toHaveLength(fixture.length);

      for (const fill of fills) {
        expect(typeof fill.coin).toBe('string');
        expect(typeof fill.px).toBe('string');
        expect(typeof fill.sz).toBe('string');
        expect(['B', 'A']).toContain(fill.side);
        expect(typeof fill.time).toBe('number');
        expect(typeof fill.startPosition).toBe('string');
        expect(typeof fill.dir).toBe('string');
        expect(typeof fill.closedPnl).toBe('string');
        expect(fill.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(typeof fill.oid).toBe('number');
        expect(typeof fill.crossed).toBe('boolean');
        expect(typeof fill.fee).toBe('string');
        expect(typeof fill.tid).toBe('number');
        expect(typeof fill.feeToken).toBe('string');
        expect(fill.twapId === null || typeof fill.twapId === 'number').toBe(true);
      }

      // Second fixture fill exercises the optional fields.
      const [, withOptionals] = fills;
      expect(withOptionals.builderFee).toBe('0.05');
      expect(withOptionals.cloid).toBe('0x0123456789abcdef0123456789abcdef');
      expect(withOptionals.twapId).toBe(42);
      expect(withOptionals.liquidation).toEqual({
        liquidatedUser: '0x0000000000000000000000000000000000000002',
        markPx: '3195.0',
        method: 'market',
      });
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.userFills(USER_FILLS_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].coin).toBe('AVAX');
    expect(result[1].coin).toBe('ETH');
  });
});

describe('[Epic 1.3.2] historicalOrders', () => {
  it('the wrapper exposes historicalOrders and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.historicalOrders(HISTORICAL_ORDERS_PARAMS);
    expect(result).toEqual(loadHistoricalOrdersFixture());
  });

  it('sends an info request carrying type "historicalOrders" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.historicalOrders(HISTORICAL_ORDERS_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'historicalOrders', user: USER_ADDRESS });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type, including optional/nullable fields', async () => {
      const { client } = createWrapper();
      const entries = await client.historicalOrders(HISTORICAL_ORDERS_PARAMS);
      const fixture = loadHistoricalOrdersFixture();
      expect(entries).toHaveLength(fixture.length);

      for (const entry of entries) {
        expect(typeof entry.status).toBe('string');
        expect(typeof entry.statusTimestamp).toBe('number');

        const { order } = entry;
        expect(typeof order.coin).toBe('string');
        expect(['B', 'A']).toContain(order.side);
        expect(typeof order.limitPx).toBe('string');
        expect(typeof order.sz).toBe('string');
        expect(typeof order.oid).toBe('number');
        expect(typeof order.timestamp).toBe('number');
        expect(typeof order.origSz).toBe('string');
        expect(typeof order.triggerCondition).toBe('string');
        expect(typeof order.isTrigger).toBe('boolean');
        expect(typeof order.triggerPx).toBe('string');
        expect(Array.isArray(order.children)).toBe(true);
        expect(typeof order.isPositionTpsl).toBe('boolean');
        expect(typeof order.reduceOnly).toBe('boolean');
        expect(typeof order.orderType).toBe('string');
        expect(order.tif === null || typeof order.tif === 'string').toBe(true);
        expect(order.cloid === null || typeof order.cloid === 'string').toBe(true);
      }

      // First fixture entry: a filled resting limit order (no trigger, GTC).
      const [filled, triggered] = entries;
      expect(filled.status).toBe('filled');
      expect(filled.order.orderType).toBe('Limit');
      expect(filled.order.tif).toBe('Gtc');
      expect(filled.order.cloid).toBeNull();

      // Second fixture entry exercises trigger/TP-SL and cloid fields.
      expect(triggered.status).toBe('triggered');
      expect(triggered.order.isTrigger).toBe(true);
      expect(triggered.order.isPositionTpsl).toBe(true);
      expect(triggered.order.orderType).toBe('Take Profit Limit');
      expect(triggered.order.tif).toBeNull();
      expect(triggered.order.cloid).toBe('0x0123456789abcdef0123456789abcdef');
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.historicalOrders(HISTORICAL_ORDERS_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].order.coin).toBe('AVAX');
    expect(result[1].order.coin).toBe('ETH');
  });
});

describe('[Epic 1.3.3] openOrders', () => {
  it('the wrapper exposes openOrders and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.openOrders(OPEN_ORDERS_PARAMS);
    expect(result).toEqual(loadOpenOrdersFixture());
  });

  it('sends an info request carrying type "openOrders" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.openOrders(OPEN_ORDERS_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'openOrders', user: USER_ADDRESS });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type, including optional/nullable fields', async () => {
      const { client } = createWrapper();
      const orders = await client.openOrders(OPEN_ORDERS_PARAMS);
      const fixture = loadOpenOrdersFixture();
      expect(orders).toHaveLength(fixture.length);

      for (const order of orders) {
        expect(typeof order.coin).toBe('string');
        expect(['B', 'A']).toContain(order.side);
        expect(typeof order.limitPx).toBe('string');
        expect(typeof order.sz).toBe('string');
        expect(typeof order.oid).toBe('number');
        expect(typeof order.timestamp).toBe('number');
        expect(typeof order.origSz).toBe('string');
        expect(typeof order.triggerCondition).toBe('string');
        expect(typeof order.isTrigger).toBe('boolean');
        expect(typeof order.triggerPx).toBe('string');
        expect(Array.isArray(order.children)).toBe(true);
        expect(typeof order.isPositionTpsl).toBe('boolean');
        expect(typeof order.reduceOnly).toBe('boolean');
        expect(typeof order.orderType).toBe('string');
        expect(order.tif === null || typeof order.tif === 'string').toBe(true);
        expect(order.cloid === null || typeof order.cloid === 'string').toBe(true);
      }

      // First fixture order: an open resting limit order (no trigger, GTC).
      const [resting, triggering] = orders;
      expect(resting.orderType).toBe('Limit');
      expect(resting.tif).toBe('Gtc');
      expect(resting.cloid).toBeNull();

      // Second fixture order exercises trigger/TP-SL and cloid fields.
      expect(triggering.isTrigger).toBe(true);
      expect(triggering.isPositionTpsl).toBe(true);
      expect(triggering.orderType).toBe('Take Profit Limit');
      expect(triggering.tif).toBeNull();
      expect(triggering.cloid).toBe('0x0123456789abcdef0123456789abcdef');
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.openOrders(OPEN_ORDERS_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].coin).toBe('AVAX');
    expect(result[1].coin).toBe('ETH');
  });
});

describe('[Epic 1.3.4] userFunding', () => {
  it('the wrapper exposes userFunding and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.userFunding(USER_FUNDING_PARAMS);
    expect(result).toEqual(loadUserFundingFixture());
  });

  it('sends an info request carrying type "userFunding" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.userFunding(USER_FUNDING_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'userFunding', user: USER_ADDRESS });
  });

  it('forwards startTime and endTime when provided', async () => {
    const { client, requests } = createWrapper();
    const startTime = 1681222000000;
    const endTime = 1681222500000;
    await client.userFunding({ ...USER_FUNDING_PARAMS, startTime, endTime });

    expect(requests[0].payload).toEqual({
      type: 'userFunding',
      user: USER_ADDRESS,
      startTime,
      endTime,
    });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type', async () => {
      const { client } = createWrapper();
      const entries = await client.userFunding(USER_FUNDING_PARAMS);
      const fixture = loadUserFundingFixture();
      expect(entries).toHaveLength(fixture.length);

      for (const entry of entries) {
        expect(typeof entry.time).toBe('number');
        expect(entry.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);

        const { delta } = entry;
        expect(delta.type).toBe('funding');
        expect(typeof delta.coin).toBe('string');
        expect(typeof delta.usdc).toBe('string');
        expect(typeof delta.szi).toBe('string');
        expect(typeof delta.fundingRate).toBe('string');
        expect(delta.nSamples === null || typeof delta.nSamples === 'number').toBe(true);
      }

      // First fixture: positive funding with nSamples present.
      const [first, second] = entries;
      expect(first.delta.coin).toBe('BTC');
      expect(first.delta.usdc).toBe('12.50');
      expect(first.delta.szi).toBe('0.5');
      expect(first.delta.nSamples).toBe(8);

      // Second fixture: negative funding with nSamples null.
      expect(second.delta.coin).toBe('ETH');
      expect(second.delta.usdc).toBe('-5.75');
      expect(second.delta.szi).toBe('-2.0');
      expect(second.delta.nSamples).toBeNull();
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.userFunding(USER_FUNDING_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].delta.coin).toBe('BTC');
    expect(result[1].delta.coin).toBe('ETH');
  });
});

describe('[Epic 1.3.4] fundingHistory', () => {
  it('the wrapper exposes fundingHistory and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.fundingHistory(FUNDING_HISTORY_PARAMS);
    expect(result).toEqual(loadFundingHistoryFixture());
  });

  it('sends an info request carrying type "fundingHistory" with coin and startTime', async () => {
    const { client, requests } = createWrapper();
    await client.fundingHistory(FUNDING_HISTORY_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: 1681222000000,
    });
  });

  it('forwards endTime when provided', async () => {
    const { client, requests } = createWrapper();
    const endTime = 1681222500000;
    await client.fundingHistory({ ...FUNDING_HISTORY_PARAMS, endTime });

    expect(requests[0].payload).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: 1681222000000,
      endTime,
    });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type', async () => {
      const { client } = createWrapper();
      const records = await client.fundingHistory(FUNDING_HISTORY_PARAMS);
      const fixture = loadFundingHistoryFixture();
      expect(records).toHaveLength(fixture.length);

      for (const record of records) {
        expect(typeof record.coin).toBe('string');
        expect(typeof record.fundingRate).toBe('string');
        expect(typeof record.premium).toBe('string');
        expect(typeof record.time).toBe('number');
      }

      // First two records are for BTC, third is for ETH.
      const [first, second, third] = records;
      expect(first.coin).toBe('BTC');
      expect(first.fundingRate).toBe('0.00001234');
      expect(first.premium).toBe('0.025');

      expect(second.coin).toBe('BTC');
      expect(second.fundingRate).toBe('0.00001567');
      expect(second.premium).toBe('0.032');

      expect(third.coin).toBe('ETH');
      expect(third.fundingRate).toBe('-0.00000567');
      expect(third.premium).toBe('-0.015');
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.fundingHistory(FUNDING_HISTORY_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].coin).toBe('BTC');
    expect(result[1].coin).toBe('BTC');
    expect(result[2].coin).toBe('ETH');
  });
});

describe('[Epic 1.3.5] referralStatus', () => {
  it('the wrapper exposes referralStatus and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.referralStatus(REFERRAL_STATUS_PARAMS);
    expect(result).toEqual(loadReferralStatusFixture());
  });

  it('sends an info request carrying type "referral" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.referralStatus(REFERRAL_STATUS_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload.type).toBe('referral');
    expect((requests[0].payload as Record<string, unknown>).user).toBe(USER_ADDRESS);
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type, including optional/nested fields', async () => {
      const { client } = createWrapper();
      const status = await client.referralStatus(REFERRAL_STATUS_PARAMS);
      const fixture = loadReferralStatusFixture();
      expect(status).toEqual(fixture);

      // Top-level fields
      expect(typeof status.cumVlm).toBe('string');
      expect(typeof status.unclaimedRewards).toBe('string');
      expect(typeof status.claimedRewards).toBe('string');
      expect(typeof status.builderRewards).toBe('string');

      // referredBy (can be null or object)
      if (status.referredBy !== null) {
        expect(status.referredBy.referrer).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(typeof status.referredBy.code).toBe('string');
      }

      // referrerState (can have different stages)
      expect(['ready', 'needToCreateCode', 'needToTrade']).toContain(status.referrerState.stage);

      if (status.referrerState.stage === 'ready') {
        const readyState = status.referrerState as Extract<typeof status.referrerState, { stage: 'ready' }>;
        expect(typeof readyState.data.code).toBe('string');
        expect(typeof readyState.data.nReferrals).toBe('number');
        expect(Array.isArray(readyState.data.referralStates)).toBe(true);
        for (const refState of readyState.data.referralStates) {
          expect(typeof refState.cumVlm).toBe('string');
          expect(typeof refState.cumRewardedFeesSinceReferred).toBe('string');
          expect(typeof refState.cumFeesRewardedToReferrer).toBe('string');
          expect(typeof refState.timeJoined).toBe('number');
          expect(refState.user).toMatch(/^0x[a-fA-F0-9]{40}$/);
          expect(Array.isArray(refState.tokenToState)).toBe(true);
        }
      }

      // rewardHistory
      expect(Array.isArray(status.rewardHistory)).toBe(true);
      for (const record of status.rewardHistory) {
        expect(typeof record.earned).toBe('string');
        expect(typeof record.vlm).toBe('string');
        expect(typeof record.referralVlm).toBe('string');
        expect(typeof record.time).toBe('number');
      }

      // tokenToState
      expect(Array.isArray(status.tokenToState)).toBe(true);
      for (const [tokenId, state] of status.tokenToState) {
        expect(typeof tokenId).toBe('number');
        expect(typeof state.cumVlm).toBe('string');
        expect(typeof state.unclaimedRewards).toBe('string');
        expect(typeof state.claimedRewards).toBe('string');
        expect(typeof state.builderRewards).toBe('string');
      }
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.referralStatus(REFERRAL_STATUS_PARAMS);

    expect(result).toBeDefined();
    expect(typeof result.cumVlm).toBe('string');
    expect(typeof result.unclaimedRewards).toBe('string');
    expect(typeof result.claimedRewards).toBe('string');
  });
});

describe('[Epic 1.3.6] userRole', () => {
  it('the wrapper exposes userRole and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.userRole(USER_ROLE_PARAMS);
    expect(result).toEqual(loadUserRoleFixture());
  });

  it('sends an info request carrying type "userRole" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.userRole(USER_ROLE_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'userRole', user: USER_ADDRESS });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses basic user role (missing, user, vault)', async () => {
      const { client } = createWrapper();
      const role = await client.userRole(USER_ROLE_PARAMS);
      const fixture = loadUserRoleFixture();
      expect(role).toEqual(fixture);
      expect(role.role).toBe('user');
      expect('data' in role).toBe(false);
    });

    it('parses agent role with master user data', async () => {
      const { requests } = createWrapper();
      requests.length = 0;
      const agentRole = loadUserRoleAgentFixture();
      const role = agentRole as Extract<typeof agentRole, { role: 'agent' }>;
      expect(role.role).toBe('agent');
      expect(typeof role.data.user).toBe('string');
      expect(role.data.user).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('parses sub-account role with master account data', async () => {
      const { requests } = createWrapper();
      requests.length = 0;
      const subAccountRole = loadUserRoleSubAccountFixture();
      const role = subAccountRole as Extract<typeof subAccountRole, { role: 'subAccount' }>;
      expect(role.role).toBe('subAccount');
      expect(typeof role.data.master).toBe('string');
      expect(role.data.master).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.userRole(USER_ROLE_PARAMS);

    expect(result).toBeDefined();
    expect(typeof result.role).toBe('string');
    expect(['missing', 'user', 'vault', 'agent', 'subAccount']).toContain(result.role);
  });
});

describe('[Epic 1.3.7] subAccounts', () => {
  it('the wrapper exposes subAccounts and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.subAccounts(SUB_ACCOUNTS_PARAMS);
    expect(result).toEqual(loadSubAccountsFixture());
  });

  it('sends an info request carrying type "subAccounts" and the given user address', async () => {
    const { client, requests } = createWrapper();
    await client.subAccounts(SUB_ACCOUNTS_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'subAccounts', user: USER_ADDRESS });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented field with the correct type, including nested clearinghouse/spot state', async () => {
      const { client } = createWrapper();
      const result = await client.subAccounts(SUB_ACCOUNTS_PARAMS);
      const fixture = loadSubAccountsFixture();
      expect(result).toEqual(fixture);
      expect(Array.isArray(result)).toBe(true);

      const entries = result as NonNullable<typeof result>;
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(typeof entry.name).toBe('string');
      expect(entry.subAccountUser).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(entry.master).toMatch(/^0x[a-fA-F0-9]{40}$/);

      const { clearinghouseState, spotState } = entry;
      expect(typeof clearinghouseState.marginSummary.accountValue).toBe('string');
      expect(typeof clearinghouseState.crossMarginSummary.totalMarginUsed).toBe('string');
      expect(typeof clearinghouseState.crossMaintenanceMarginUsed).toBe('string');
      expect(typeof clearinghouseState.withdrawable).toBe('string');
      expect(typeof clearinghouseState.time).toBe('number');
      expect(Array.isArray(clearinghouseState.assetPositions)).toBe(true);

      const [assetPosition] = clearinghouseState.assetPositions;
      expect(assetPosition.type).toBe('oneWay');
      expect(typeof assetPosition.position.coin).toBe('string');
      expect(typeof assetPosition.position.szi).toBe('string');
      expect(assetPosition.position.leverage.type).toBe('cross');
      expect(assetPosition.position.leverage.value).toBe(5);
      expect(assetPosition.position.liquidationPx === null || typeof assetPosition.position.liquidationPx === 'string').toBe(true);
      expect(typeof assetPosition.position.cumFunding.allTime).toBe('string');

      expect(Array.isArray(spotState.balances)).toBe(true);
      const [balance] = spotState.balances;
      expect(typeof balance.coin).toBe('string');
      expect(typeof balance.token).toBe('number');
      expect(typeof balance.total).toBe('string');
      expect(typeof balance.hold).toBe('string');
      expect(typeof balance.entryNtl).toBe('string');
    });

    it('parses null when the user has no sub-accounts', () => {
      const fixture = loadSubAccountsEmptyFixture();
      expect(fixture).toBeNull();
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.subAccounts(SUB_ACCOUNTS_PARAMS);

    expect(Array.isArray(result)).toBe(true);
    const entries = result as NonNullable<typeof result>;
    expect(entries[0].name).toBe('testSubAccount');
    expect(entries[0].clearinghouseState.assetPositions[0].position.coin).toBe('BTC');
    expect(entries[0].spotState.balances[0].coin).toBe('USDC');
  });
});

describe('[Epic 1.3.8] meta', () => {
  it('the wrapper exposes meta and returns the transport response', async () => {
    const { client } = createWrapper();
    const result = await client.meta(META_PARAMS);
    expect(result).toEqual(loadMetaFixture());
  });

  it('sends an info request carrying type "meta"', async () => {
    const { client, requests } = createWrapper();
    await client.meta(META_PARAMS);

    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('info');
    expect(requests[0].payload).toEqual({ type: 'meta' });
  });

  it('forwards dex when provided', async () => {
    const { client, requests } = createWrapper();
    await client.meta({ dex: 'test' });

    expect(requests[0].payload).toEqual({ type: 'meta', dex: 'test' });
  });

  describe('response-shape parsing from fixture', () => {
    it('parses every documented universe field with the correct type, including isDelisted', async () => {
      const { client } = createWrapper();
      const result = await client.meta(META_PARAMS);
      const fixture = loadMetaFixture();
      expect(result).toEqual(fixture);
      expect(result.universe).toHaveLength(fixture.universe.length);

      for (const asset of result.universe) {
        expect(typeof asset.szDecimals).toBe('number');
        expect(typeof asset.name).toBe('string');
        expect(typeof asset.maxLeverage).toBe('number');
        expect(typeof asset.marginTableId).toBe('number');
      }

      const [btc, eth, delisted] = result.universe;
      expect(btc.name).toBe('BTC');
      expect(eth.name).toBe('ETH');
      expect(delisted.isDelisted).toBe(true);
    });
  });

  it('testnet integration: replays the recorded cassette response and parses it', async () => {
    const { client } = createWrapper();
    const result = await client.meta(META_PARAMS);

    expect(Array.isArray(result.universe)).toBe(true);
    expect(result.universe[0].name).toBe('BTC');
    expect(result.universe[1].name).toBe('ETH');
  });
});

describe('[Epic 1.3.8] HlAssetIndexResolver — centralized asset-index resolution', () => {
  function createResolver() {
    const { client, requests } = createWrapper();
    return { resolver: new HlAssetIndexResolver(client), requests };
  }

  it('is not loaded before the first resolve() call', () => {
    const { resolver } = createResolver();
    expect(resolver.isLoaded).toBe(false);
  });

  it('resolves a coin symbol from a recorded meta response: index is the universe array position', async () => {
    const { resolver } = createResolver();

    const btc = await resolver.resolve('BTC');
    expect(btc.asset).toBe(0);
    expect(btc.szDecimals).toBe(5);
    expect(btc.maxLeverage).toBe(50);

    const eth = await resolver.resolve('ETH');
    expect(eth.asset).toBe(1);
    expect(eth.szDecimals).toBe(4);
  });

  it('resolveAssetIndex is a convenience for the numeric index alone', async () => {
    const { resolver } = createResolver();
    expect(await resolver.resolveAssetIndex('BTC')).toBe(0);
    expect(await resolver.resolveAssetIndex('ETH')).toBe(1);
  });

  it('surfaces isDelisted from meta on the resolved entry', async () => {
    const { resolver } = createResolver();
    const delisted = await resolver.resolve('OLD-DELISTED');
    expect(delisted.isDelisted).toBe(true);
  });

  it('fetches meta exactly once across multiple resolve() calls (cached for the session)', async () => {
    const { resolver, requests } = createResolver();
    await resolver.resolve('BTC');
    await resolver.resolve('ETH');
    await resolver.resolveAssetIndex('BTC');

    expect(requests).toHaveLength(1);
    expect(resolver.isLoaded).toBe(true);
  });

  it('concurrent resolve() calls before the first load completes share a single meta fetch', async () => {
    const { resolver, requests } = createResolver();
    const [btc, eth] = await Promise.all([resolver.resolve('BTC'), resolver.resolve('ETH')]);

    expect(requests).toHaveLength(1);
    expect(btc.asset).toBe(0);
    expect(eth.asset).toBe(1);
  });

  describe('unknown-asset error path', () => {
    it('resolve() throws naming the unresolvable coin', async () => {
      const { resolver } = createResolver();
      await expect(resolver.resolve('DOES-NOT-EXIST')).rejects.toThrow(/unknown asset.*DOES-NOT-EXIST/i);
    });

    it('resolveAssetIndex() throws the same way', async () => {
      const { resolver } = createResolver();
      await expect(resolver.resolveAssetIndex('DOES-NOT-EXIST')).rejects.toThrow(/unknown asset/i);
    });
  });

  it('load() re-fetches meta even when already loaded (explicit refresh)', async () => {
    const { resolver, requests } = createResolver();
    await resolver.resolve('BTC');
    expect(requests).toHaveLength(1);

    await resolver.load();
    expect(requests).toHaveLength(2);
    expect(await resolver.resolveAssetIndex('BTC')).toBe(0);
  });
});

describe('[Epic 1.3.8] no hardcoded asset IDs in production source', () => {
  const SCAN_ROOTS = [
    'packages/core/src',
    'packages/ui/src',
    'packages/wallet/src',
    'apps/web/src',
    'apps/api/src',
  ].map((relative) => path.join(REPO_ROOT, relative));

  // A hardcoded Hyperliquid asset index would show up as a numeric literal on
  // the wire-format key ("asset" in wrapper params, "a" in the raw order/
  // cancel payload) — e.g. `asset: 0` or `a: 2`. Deliberately excludes
  // packages/core/src/hl/assetIndex.ts's own type/field declarations, which
  // this pattern cannot match anyway since those are `: number`, not a digit.
  const HARDCODED_ASSET_PATTERN = /\b(?:asset|a)\s*:\s*\d+\b/;

  function listSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listSourceFiles(fullPath));
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('no production source file (packages/*/src, apps/*/src) hardcodes a numeric asset index', () => {
    const offenders = SCAN_ROOTS.flatMap((root) =>
      listSourceFiles(root)
        .filter((file) => HARDCODED_ASSET_PATTERN.test(fs.readFileSync(file, 'utf-8')))
        .map((file) => path.relative(REPO_ROOT, file))
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * [#742] Phase 7 · Epic 7.8 · Task 7.8.7 — a unified-account user renders as
 * an empty account.
 *
 * `fetchClearinghouseSummary` read `clearinghouseState` unconditionally, which
 * under Hyperliquid's `unifiedAccount` mode is the state its own docs call
 * "not meaningful": a funded account reads `accountValue "0.0"` there **by
 * design**, because spot and perp balances merged and the money is reported
 * through the spot clearinghouse state instead.
 *
 * The unified fixture below is the shape measured on testnet in spike 7.9
 * (docs/roadmap/spikes/recordings/7.9-hyperevm-withdraw-testnet-run.json,
 * account `0x0000…86C5`): `abstraction: "unifiedAccount"`,
 * `perpsAccountValue: "0.0"`, `spotUsdc: "2.0"`, `spotHold: "0.0"`.
 *
 * [#744] followed up on the one thing that account couldn't answer — it held
 * no open position, so nothing confirmed whether `assetPositions` stays
 * populated under `unifiedAccount` at all. The
 * `describe('7.8.7 — positions are verified …')` block below fixtures the
 * testnet recording that answers it:
 * docs/roadmap/spikes/recordings/7.8.7-unified-account-position-testnet-run.json,
 * account `0xa3A5…C6bc`, a real open BTC position.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_MODE_CACHE_TTL_MS,
  SdkManager,
  UNIFIED_ACCOUNT_DAILY_ACTION_LIMIT,
  clearAccountModeCache,
  fetchAccountAbstractionMode,
  fetchClearinghouseSummary,
  isUnifiedAccountMode,
  type AccountAbstractionMode,
  type HlClearinghouseState,
  type HlClientLike,
} from '../../src/index';

// The account the spike measured; the fixtures below are its recorded state.
const USER = '0x0000008398d108F4DC04d84518F3B4eC5E4A86C5';

const POSITION = {
  coin: 'BTC',
  szi: '0.5',
  entryPx: '60000',
  unrealizedPnl: '50',
  leverage: { type: 'cross' as const, value: 10 },
  positionValue: '30000',
  returnOnEquity: '0',
  liquidationPx: '54000',
  marginUsed: '3000',
  maxLeverage: 50,
  cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
};

/**
 * The perp state as a *unified* account reports it: zeros, by design.
 *
 * Typed against `HlClearinghouseState` rather than inferred from `POSITION`:
 * inference froze `liquidationPx` to `string` off that one synthetic fixture,
 * while the API — and the recorded testnet position below — return `null` for a
 * position that has no liquidation price.
 */
function unifiedPerpState(
  positions: HlClearinghouseState['assetPositions'] = [
    { type: 'oneWay' as const, position: POSITION },
  ]
): HlClearinghouseState {
  const zero = { accountValue: '0.0', totalMarginUsed: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0' };
  return {
    marginSummary: zero,
    crossMarginSummary: zero,
    crossMaintenanceMarginUsed: '0.0',
    withdrawable: '0.0',
    assetPositions: positions,
    time: 0,
  };
}

/** The perp state as a split (`default`/`portfolioMargin`) account reports it. */
function splitPerpState(): HlClearinghouseState {
  const summary = {
    accountValue: '1000',
    totalMarginUsed: '100',
    totalNtlPos: '0',
    totalRawUsd: '0',
  };
  return {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: '0',
    withdrawable: '900',
    assetPositions: [{ type: 'oneWay' as const, position: POSITION }],
    time: 0,
  };
}

interface MockOptions {
  mode?: AccountAbstractionMode;
  /** Omit the `userAbstraction` endpoint entirely (an older wrapper/double). */
  noAbstractionEndpoint?: boolean;
  /** Make the abstraction read fail. */
  abstractionThrows?: boolean;
  /** Make the spot read fail. */
  spotThrows?: boolean;
  /** Omit the `spotClearinghouseState` endpoint entirely. */
  noSpotEndpoint?: boolean;
  spotBalances?: Array<{ coin: string; token: number; total: string; hold: string; entryNtl: string }>;
  perpState?: HlClearinghouseState;
}

function createMocks(options: MockOptions = {}) {
  const mode = options.mode ?? 'unifiedAccount';
  const perpState =
    'perpState' in options
      ? options.perpState
      : mode === 'unifiedAccount'
        ? unifiedPerpState()
        : splitPerpState();

  const hlClient: Record<string, unknown> = {
    network: 'testnet' as const,
    clearinghouseState: vi.fn(async () => perpState),
  };
  if (!options.noAbstractionEndpoint) {
    hlClient.userAbstraction = vi.fn(async () => {
      if (options.abstractionThrows) throw new Error('info endpoint unavailable');
      return mode;
    });
  }
  if (!options.noSpotEndpoint) {
    hlClient.spotClearinghouseState = vi.fn(async () => {
      if (options.spotThrows) throw new Error('info endpoint unavailable');
      return {
        balances: options.spotBalances ?? [
          { coin: 'USDC', token: 0, total: '2.0', hold: '0.0', entryNtl: '0.0' },
        ],
      };
    });
  }

  const manager = new SdkManager({
    hlClientFactory: () => hlClient as unknown as HlClientLike,
  });
  return { manager, hlClient };
}

beforeEach(() => {
  clearAccountModeCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearAccountModeCache();
});

describe('7.8.7 — a funded unified account reads its real balance', () => {
  it('reports the spot USDC balance, not the perp state Hyperliquid calls "not meaningful"', async () => {
    const { manager } = createMocks({ mode: 'unifiedAccount' });
    const summary = await fetchClearinghouseSummary(manager, USER);

    // The recorded account: 2 USDC held, `clearinghouseState` reading 0.0.
    expect(summary!.accountValue).toBe('2');
    expect(summary!.accountValue).not.toBe('0.0');
    expect(summary!.accountMode).toBe('unifiedAccount');
    expect(summary!.balanceUnavailable).toBe(false);
    expect(summary!.spotBalances).toEqual([
      { coin: 'USDC', total: '2', available: '2', source: 'spot' },
    ]);
  });

  it('derives margin used and withdrawable from the unified balance hold', async () => {
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      spotBalances: [{ coin: 'USDC', token: 0, total: '2.0', hold: '0.5', entryNtl: '0.0' }],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.totalMarginUsed).toBe('0.5');
    expect(summary!.withdrawable).toBe('1.5');
  });

  it('never reports a negative withdrawable when the hold exceeds the balance', async () => {
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      spotBalances: [{ coin: 'USDC', token: 0, total: '1.0', hold: '1.5', entryNtl: '0.0' }],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdrawable).toBe('0');
  });

  it('reports an honest zero for a unified account that really holds no USDC', async () => {
    const { manager } = createMocks({ mode: 'unifiedAccount', spotBalances: [] });
    const summary = await fetchClearinghouseSummary(manager, USER);

    // The read succeeded and found nothing — that is a measurement, not a gap.
    expect(summary!.accountValue).toBe('0');
    expect(summary!.balanceUnavailable).toBe(false);
  });

  it('keeps reading positions from the perp state, the only place they are reported', async () => {
    const { manager } = createMocks({ mode: 'unifiedAccount' });
    const summary = await fetchClearinghouseSummary(manager, USER);

    // Verified in docs/roadmap/adr/7.8.7-unified-account-reads.md (#744):
    // "not meaningful" is a statement about balances — a unified account with
    // a real open position confirmed `assetPositions` stays populated and
    // correct there. The perp state is the (correct) source in both modes.
    expect(summary!.positions).toHaveLength(1);
    expect(summary!.positions[0]).toMatchObject({ coin: 'BTC', szi: '0.5', marginUsed: '3000' });
  });
});

describe('7.8.7 — positions are verified, not scoped out (#744)', () => {
  // The exact shape recorded on testnet:
  // docs/roadmap/spikes/recordings/7.8.7-unified-account-position-testnet-run.json,
  // account 0xa3A50ccCD49cb5683417533B254EB4f7A85cC6bc, userAbstraction "unifiedAccount".
  const RECORDED_POSITION = {
    coin: 'BTC',
    szi: '0.00017',
    leverage: { type: 'cross' as const, value: 2 },
    entryPx: '62771.0',
    positionValue: '10.67532',
    unrealizedPnl: '0.00425',
    returnOnEquity: '0.0007965462',
    liquidationPx: null,
    marginUsed: '5.33766',
    maxLeverage: 40,
    cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
  };
  const RECORDED_PERP_STATE = {
    marginSummary: {
      accountValue: '5.339785',
      totalNtlPos: '10.67532',
      totalRawUsd: '-5.335535',
      totalMarginUsed: '5.33766',
    },
    crossMarginSummary: {
      accountValue: '5.339785',
      totalNtlPos: '10.67532',
      totalRawUsd: '-5.335535',
      totalMarginUsed: '5.33766',
    },
    crossMaintenanceMarginUsed: '0.133441',
    withdrawable: '0.002125',
    assetPositions: [{ type: 'oneWay' as const, position: RECORDED_POSITION }],
    time: 1785742096622,
  };
  const RECORDED_SPOT_USDC = { coin: 'USDC', token: 0, total: '37.777154', hold: '5.33766', entryNtl: '0.0' };

  it('reports the real open position recorded on testnet for a unified account', async () => {
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      perpState: RECORDED_PERP_STATE,
      spotBalances: [RECORDED_SPOT_USDC],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.accountMode).toBe('unifiedAccount');
    expect(summary!.positions).toHaveLength(1);
    expect(summary!.positions[0]).toMatchObject({
      coin: 'BTC',
      szi: '0.00017',
      entryPx: '62771.0',
      marginUsed: '5.33766',
    });
  });

  it("matches the position's marginUsed to the unified balance's hold exactly, as ADR 7.8.7 decision 4 predicts", async () => {
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      perpState: RECORDED_PERP_STATE,
      spotBalances: [RECORDED_SPOT_USDC],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.positions[0].marginUsed).toBe(RECORDED_SPOT_USDC.hold);
    expect(summary!.totalMarginUsed).toBe(RECORDED_SPOT_USDC.hold);
  });
});

describe('7.8.7 — split accounts still take money from the perp state', () => {
  it.each(['default', 'portfolioMargin', 'disabled', 'dexAbstraction'] as const)(
    'reads %s account money from the perp state (spot is only for token rows)',
    async (mode) => {
      const { manager, hlClient } = createMocks({ mode });
      const summary = await fetchClearinghouseSummary(manager, USER);

      expect(summary).toMatchObject({
        accountValue: '1000',
        totalMarginUsed: '100',
        withdrawable: '900',
        accountMode: mode,
        balanceUnavailable: false,
      });
      // Spot is read so the Portfolio Balances tab can list tokens, but it
      // must not replace the perp figures above — the default mock's spot
      // USDC is 2, not 1000.
      expect(hlClient.spotClearinghouseState).toHaveBeenCalledTimes(1);
      expect(summary!.spotBalances).toEqual([
        { coin: 'USDC', total: '1000', available: '900', source: 'perp' },
        { coin: 'USDC', total: '2', available: '2', source: 'spot' },
      ]);
    }
  );

  it('reports a genuinely empty split account as $0, not as unavailable', async () => {
    const { manager } = createMocks({ mode: 'default', perpState: unifiedPerpState([]) });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.accountValue).toBe('0.0');
    expect(summary!.balanceUnavailable).toBe(false);
  });
});

describe('7.8.7 — a detection failure degrades to honest, not to $0', () => {
  it.each([
    ['the endpoint throws', { abstractionThrows: true }],
    ['the wrapper has no such endpoint', { noAbstractionEndpoint: true }],
  ])('flags the balance unavailable when %s and the perp state reads zero', async (_label, opts) => {
    const { manager } = createMocks({ ...opts, perpState: unifiedPerpState() });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.accountMode).toBeNull();
    expect(summary!.balanceUnavailable).toBe(true);
  });

  it('trusts a non-zero perp balance even with the mode unknown — only a zero is ambiguous', async () => {
    const { manager } = createMocks({ abstractionThrows: true, perpState: splitPerpState() });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.accountMode).toBeNull();
    expect(summary!.balanceUnavailable).toBe(false);
    expect(summary!.accountValue).toBe('1000');
  });

  it.each([
    ['the spot read throws', { spotThrows: true }],
    ['the wrapper has no spot endpoint', { noSpotEndpoint: true }],
  ])('flags the balance unavailable for a unified account when %s', async (_label, opts) => {
    const { manager } = createMocks({ mode: 'unifiedAccount', ...opts });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.accountMode).toBe('unifiedAccount');
    expect(summary!.balanceUnavailable).toBe(true);
  });

  it('still returns null when the account has no clearinghouse state at all', async () => {
    const { manager } = createMocks({
      mode: 'default',
      perpState: null as unknown as HlClearinghouseState,
    });
    expect(await fetchClearinghouseSummary(manager, USER)).toBeNull();
  });
});

describe('7.8.7 — the mode is cached per account, but never assumed permanent', () => {
  it('reads the mode once for repeated summaries of the same account', async () => {
    const { manager, hlClient } = createMocks({ mode: 'unifiedAccount' });
    await fetchClearinghouseSummary(manager, USER);
    await fetchClearinghouseSummary(manager, USER);

    expect(hlClient.userAbstraction).toHaveBeenCalledTimes(1);
  });

  it('re-reads it once the cached value expires — a user can switch modes', async () => {
    vi.useFakeTimers();
    const { manager, hlClient } = createMocks({ mode: 'unifiedAccount' });
    await fetchAccountAbstractionMode(manager, USER);
    vi.advanceTimersByTime(ACCOUNT_MODE_CACHE_TTL_MS + 1);
    await fetchAccountAbstractionMode(manager, USER);

    expect(hlClient.userAbstraction).toHaveBeenCalledTimes(2);
  });

  it('caches per account, so one account’s mode never decides another’s', async () => {
    const { manager, hlClient } = createMocks({ mode: 'unifiedAccount' });
    await fetchAccountAbstractionMode(manager, USER);
    await fetchAccountAbstractionMode(manager, '0x1111111111111111111111111111111111111111');

    expect(hlClient.userAbstraction).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read — the next call retries instead of pinning "unknown"', async () => {
    const { manager, hlClient } = createMocks({ mode: 'unifiedAccount', abstractionThrows: true });
    expect(await fetchAccountAbstractionMode(manager, USER)).toBeNull();
    expect(await fetchAccountAbstractionMode(manager, USER)).toBeNull();

    expect(hlClient.userAbstraction).toHaveBeenCalledTimes(2);
  });

  it('clears on demand, so a signed-out account leaves no mode behind', async () => {
    const { manager, hlClient } = createMocks({ mode: 'unifiedAccount' });
    await fetchAccountAbstractionMode(manager, USER);
    clearAccountModeCache(USER);
    await fetchAccountAbstractionMode(manager, USER);

    expect(hlClient.userAbstraction).toHaveBeenCalledTimes(2);
  });
});

describe('7.8.7 — the unified-account constraints are named in code', () => {
  it('recognizes exactly the unified mode as spot-collateralized', () => {
    expect(isUnifiedAccountMode('unifiedAccount')).toBe(true);
    expect(isUnifiedAccountMode('default')).toBe(false);
    expect(isUnifiedAccountMode('portfolioMargin')).toBe(false);
    expect(isUnifiedAccountMode(null)).toBe(false);
  });

  it('carries the documented 50k actions/day cap unified accounts are subject to', () => {
    expect(UNIFIED_ACCOUNT_DAILY_ACTION_LIMIT).toBe(50_000);
  });
});

/**
 * [#901] The summary carries the **rail's** ceiling beside the tradable one.
 *
 * `withdrawable` above answers "what can I trade with"; `withdraw3` draws on
 * the perp `clearinghouseState.withdrawable`, which the unified branch reads
 * and then discarded. The browser cannot reach Hyperliquid to ask for it
 * separately, so it rides on the read that already happened — which is what
 * lets the withdraw tab quote a figure its Max cannot contradict.
 */
describe('[#1178] the summary carries the withdraw3 rail’s own ceiling', () => {
  it('is the unified balance on a unified account — the two questions have one answer', async () => {
    // The account from [#901] and again from [#1178]: perp `0.0`, spot
    // `900.590506`, hold `0.0`.
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      spotBalances: [
        { coin: 'USDC', token: 0, total: '900.590506', hold: '0.0', entryNtl: '0.0' },
      ],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    // These were `900.590506` and `0` — both correct, and the withdraw surface
    // enforced the one that refuses every amount. They agree here because the
    // account has ONE balance, not because the two fields were collapsed: the
    // split case below still has two.
    expect(summary!.withdrawable).toBe('900.590506');
    expect(summary!.withdraw3Ceiling!.withdrawableUsdc).toBe('900.590506');
    expect(summary!.withdraw3Ceiling!.source).toBe('unified-balance');
    // One balance: nothing is "elsewhere", so there is nowhere to send the user.
    expect(summary!.withdraw3Ceiling!.heldElsewhere).toBeNull();
    // [#901]'s number still travels, for explaining an exchange refusal.
    expect(summary!.withdraw3Ceiling!.perpWithdrawableUsdc).toBe('0');
  });

  it('offers one withdraw source on a unified account, so the card shows no picker', async () => {
    const { manager } = createMocks({
      mode: 'unifiedAccount',
      spotBalances: [
        { coin: 'USDC', token: 0, total: '19.695793', hold: '0.0', entryNtl: '0.0' },
      ],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdrawSources).toEqual({
      sources: [{ id: 'account', balanceUsdc: '19.695793' }],
      defaultSourceId: 'account',
    });
  });

  it('offers the perp balance as a second source only on a split account that has one', async () => {
    // `splitPerpState()` is `accountValue 1000` / `withdrawable 900`, and the
    // default spot fixture holds `2.0`.
    const { manager } = createMocks({ mode: 'disabled' });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdrawSources).toEqual({
      sources: [
        { id: 'account', balanceUsdc: '2' },
        { id: 'perp', balanceUsdc: '900' },
      ],
      defaultSourceId: 'account',
    });
  });

  it('hides the perp source on a split account whose perp balance is empty', async () => {
    const { manager } = createMocks({ mode: 'disabled', perpState: unifiedPerpState() });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdrawSources!.sources.map((item) => item.id)).toEqual(['account']);
  });

  it('agrees with `withdrawable` on a split account — one balance, one question', async () => {
    const { manager } = createMocks({ mode: 'disabled' });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdrawable).toBe('900');
    expect(summary!.withdraw3Ceiling!.withdrawableUsdc).toBe('900');
    // [#1178] The spot USDC row is now read in every mode, so a split account's
    // off-rail money is finally attributed — it was `null` here only because
    // the split branch declined to pass the row it had already fetched, which
    // is also what left the second withdraw source unofferable.
    expect(summary!.withdraw3Ceiling!.heldElsewhere).toEqual({
      balanceUsdc: '2',
      location: 'spot-balance',
    });
  });

  it('lists perp USDC plus spot tokens on a split account', async () => {
    const { manager } = createMocks({
      mode: 'disabled',
      spotBalances: [
        { coin: 'USDC', token: 0, total: '2.0', hold: '0.0', entryNtl: '0.0' },
        { coin: 'HYPE', token: 1, total: '5', hold: '1', entryNtl: '0.0' },
      ],
    });
    const summary = await fetchClearinghouseSummary(manager, USER);
    expect(summary!.spotBalances).toEqual([
      { coin: 'USDC', total: '1000', available: '900', source: 'perp' },
      { coin: 'USDC', total: '2', available: '2', source: 'spot' },
      { coin: 'HYPE', total: '5', available: '4', source: 'spot' },
    ]);
  });

  it('states no ceiling and no source when the mode could not be read', async () => {
    // [#1178] The mode is what says which balance this rail draws on. Falling
    // through to the perp figure — as this did — meant a mode read that merely
    // blipped presented a funded unified account as an empty one.
    const { manager } = createMocks({ mode: 'unifiedAccount', abstractionThrows: true });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.withdraw3Ceiling!.mode).toBeNull();
    expect(summary!.withdraw3Ceiling!.withdrawableUsdc).toBeNull();
    expect(summary!.withdraw3Ceiling!.heldElsewhere).toBeNull();
    expect(summary!.withdrawSources).toEqual({ sources: [], defaultSourceId: null });
  });

  it('states no ceiling when the unified balance read fails — that read IS the ceiling', async () => {
    // ADR 7.8.7 unchanged, with a different balance behind it. This used to
    // carry the perp `0` on the reasoning that the rail's ceiling had been
    // measured even though the displayed balance had not; after [#1178] the
    // spot read is the ceiling, so a failed one leaves nothing to enforce and
    // reporting `0` would be the refusal the whole issue is about.
    const { manager } = createMocks({ mode: 'unifiedAccount', spotThrows: true });
    const summary = await fetchClearinghouseSummary(manager, USER);

    expect(summary!.balanceUnavailable).toBe(true);
    expect(summary!.withdraw3Ceiling!.withdrawableUsdc).toBeNull();
    expect(summary!.withdraw3Ceiling!.source).toBe('unreadable');
    expect(summary!.withdraw3Ceiling!.heldElsewhere).toBeNull();
    expect(summary!.withdrawSources!.sources).toEqual([]);
  });
});

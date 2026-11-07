/**
 * [#743] Phase 7 · ADR 7.9 task 2 — the HyperEVM withdrawal rail.
 *
 * Spike 7.9 executed this leg on testnet with real funds, so the numbers below
 * are measurements rather than expectations
 * (docs/roadmap/spikes/recordings/7.9-hyperevm-withdraw-testnet-run.json):
 *
 *   sendAsset({ destination: 0x2000…0000, sourceDex: 'spot',
 *               destinationDex: 'spot', token: 'USDC:0xeb62…5443', amount: '1' })
 *
 *   Core spot USDC   2.0 → 0.99912      (debited 1.00088)
 *   Paid on HyperEVM 1.0                (balanceOf, chain 998)
 *   Fee              0.00088            against withdraw3's flat $1
 *
 * [#902] That fee is one observation, and the rail read it as a 0.088% RATE
 * until 16 payouts spanning 1 → 999 USDC showed it flat. The quote is now a
 * flat `0.001` ceiling over the measured band, so the debits below are
 * `amount + 0.001`; the fee's own shape is asserted in
 * `hyperevm-withdrawal-fee-shape.phase-7.test.ts`.
 *
 * The traps the spike hit are asserted here so they cannot be rediscovered:
 * `sourceDex: ''` is the *perp* dex (refused on a unified account, not
 * "unset"), the token reference is a runtime read of `spotMeta`, and the mode
 * decides the route — a mode we could not read refuses rather than guessing.
 */
import { describe, expect, it } from 'vitest';

import {
  HYPERCORE_EVM_SYSTEM_ADDRESS,
  HYPEREVM_NETWORKS,
  HYPEREVM_WITHDRAWAL_FAILURES,
  HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC,
  HyperEvmWithdrawalError,
  WITHDRAW3_FLAT_FEE_USDC,
  confirmHyperEvmPayout,
  describeHyperEvmStepUp,
  formatUsdcAmount,
  parseUsdcAmount,
  planHyperEvmWithdrawal,
  quoteHyperEvmWithdrawal,
  resolveUsdcSpotToken,
  type AccountAbstractionMode,
  type HexAddress,
  type HlSpotMetaResult,
} from '../../src/index';

/** The account spike 7.9 measured, and its `spotMeta` USDC row. */
const USER = '0x0000008398d108F4DC04d84518F3B4eC5E4A86C5' as HexAddress;

const USDC_TOKEN = {
  name: 'USDC',
  szDecimals: 2,
  weiDecimals: 8,
  index: 0,
  tokenId: '0xeb62eee3685fc4c43992febcd9e75443' as `0x${string}`,
  isCanonical: true,
  evmContract: {
    // [#788] What testnet `spotMeta` ACTUALLY answers: HyperCore's
    // CoreDepositWallet, not the USDC ERC-20. The old fixture pinned the ERC-20
    // here, which is why the whole suite stayed green while the live rail called
    // `balanceOf` on a contract that reverts. The hop from this address to the
    // token is covered by hyperevm-payout-token.phase-7.test.ts.
    address: '0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206' as `0x${string}`,
    // 8 + (-2) = 6 decimals on the EVM side.
    evm_extra_wei_decimals: -2,
  },
  fullName: 'USD Coin',
  deployerTradingFeeShare: '0',
};

const SPOT_META: HlSpotMetaResult = {
  universe: [{ tokens: [0, 1], name: 'USDC/USDT', index: 0, isCanonical: true }],
  tokens: [
    USDC_TOKEN,
    {
      name: 'PURR',
      szDecimals: 2,
      weiDecimals: 5,
      index: 1,
      tokenId: '0xc1fb593aeffbeb02f85e0308e9956a90' as `0x${string}`,
      isCanonical: true,
      evmContract: null,
      fullName: null,
      deployerTradingFeeShare: '0',
    },
  ],
};

function plan(overrides: {
  mode?: AccountAbstractionMode | null;
  amountUsdc?: string;
  spotUsdc?: string;
  perpWithdrawable?: string;
  network?: 'mainnet' | 'testnet';
  spotMeta?: HlSpotMetaResult;
} = {}) {
  return planHyperEvmWithdrawal({
    mode: overrides.mode === undefined ? 'unifiedAccount' : overrides.mode,
    network: overrides.network ?? 'testnet',
    payoutAddress: USER,
    amountUsdc: overrides.amountUsdc ?? '1',
    spotMeta: overrides.spotMeta ?? SPOT_META,
    balances: {
      spotUsdc: overrides.spotUsdc ?? '2.0',
      perpWithdrawable: overrides.perpWithdrawable ?? '0.0',
    },
  });
}

describe('[#743] USDC amounts are exact', () => {
  it('parses and formats at 6 decimals without floating-point drift', () => {
    expect(parseUsdcAmount('1')).toBe(1_000_000n);
    expect(parseUsdcAmount('1.00088')).toBe(1_000_880n);
    expect(parseUsdcAmount('0.00088')).toBe(880n);
    expect(formatUsdcAmount(1_000_880n)).toBe('1.00088');
    expect(formatUsdcAmount(880n)).toBe('0.00088');
    expect(formatUsdcAmount(1_000_000n)).toBe('1');
  });

  it('refuses anything that is not a positive plain decimal', () => {
    for (const bad of ['', ' ', '-1', '0', '1e6', '0x10', 'abc', '1.2.3']) {
      expect(() => parseUsdcAmount(bad)).toThrow(HyperEvmWithdrawalError);
    }
  });
});

describe('[#743] the fee is quoted before the ceremony, absolutely and as a proportion', () => {
  it('quotes the flat fee and the debit it makes', () => {
    const quote = quoteHyperEvmWithdrawal('1');
    expect(quote.payoutUsdc).toBe('1');
    expect(quote.feeUsdc).toBe(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);
    expect(quote.feeShape).toBe('flat');
    expect(quote.debitUsdc).toBe('1.001');
  });

  it('does not punish a small withdrawal the way withdraw3’s flat $1 does', () => {
    // [#902] The rail's argument survives the re-modelling and gets stronger:
    // it was "0.088% beats a flat $1 below ~1,136 USDC", it is now "0.001 beats
    // 1 everywhere". At 5 USDC the Arbitrum rail costs 20% and this one 0.02%.
    const small = quoteHyperEvmWithdrawal('5');
    const large = quoteHyperEvmWithdrawal('5000');
    expect(small.feeUsdc).toBe('0.001');
    expect(large.feeUsdc).toBe('0.001');
    expect(small.withdraw3FeeUsdc).toBe(WITHDRAW3_FLAT_FEE_USDC);
    expect(Math.round(quoteHyperEvmWithdrawal('1').timesCheaperThanWithdraw3)).toBe(1000);
  });

  it('carries its own provenance — the quote is an estimate until the payout is observed', () => {
    const quote = quoteHyperEvmWithdrawal('1');
    expect(quote.recording).toContain('7.10.6-hyperevm-withdrawal-fee-run.json');
    expect(quote.estimated).toBe(true);
  });
});

describe('[#743] the USDC token reference is a runtime read, never a constant', () => {
  it('resolves `USDC:<tokenId>` and the linked EVM contract from spotMeta', () => {
    const token = resolveUsdcSpotToken(SPOT_META);
    expect(token.ref).toBe('USDC:0xeb62eee3685fc4c43992febcd9e75443');
    expect(token.linkedEvmContract).toBe('0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206');
    // weiDecimals 8 + evm_extra_wei_decimals -2 — derived, not assumed.
    expect(token.evmDecimals).toBe(6);
  });

  it('refuses when spotMeta carries no USDC row, or no EVM contract for it', () => {
    expect(() => resolveUsdcSpotToken({ universe: [], tokens: [] })).toThrow(
      /usdc-token-unresolved/
    );
    expect(() =>
      resolveUsdcSpotToken({
        universe: [],
        tokens: [{ ...USDC_TOKEN, evmContract: null }],
      })
    ).toThrow(/usdc-token-unresolved/);
  });
});

describe('[#743] the route is chosen from userAbstraction, never assumed', () => {
  it('a unified account takes the one-action sendAsset route, both dexes "spot"', () => {
    const p = plan({ mode: 'unifiedAccount' });
    expect(p.route).toBe('send-asset');
    expect(p.ceremonies).toBe(1);
    expect(p.actions).toHaveLength(1);
    const [action] = p.actions;
    expect(action.type).toBe('sendAsset');
    expect(action.params).toEqual({
      destination: HYPERCORE_EVM_SYSTEM_ADDRESS,
      sourceDex: 'spot',
      destinationDex: 'spot',
      token: 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
      amount: '1',
    });
  });

  it('never passes the SDK default "" — that is the perp dex, and a unified account refuses it', () => {
    const [action] = plan({ mode: 'unifiedAccount' }).actions;
    const params = action.params as { sourceDex: string; destinationDex: string };
    expect(params.sourceDex).not.toBe('');
    expect(params.destinationDex).not.toBe('');
  });

  it.each<AccountAbstractionMode>(['default', 'portfolioMargin', 'disabled', 'dexAbstraction'])(
    'a split account (%s) takes the documented usdClassTransfer + spotSend pair',
    (mode) => {
      const p = plan({ mode, spotUsdc: '0.0', perpWithdrawable: '5.0' });
      expect(p.route).toBe('class-transfer-spot-send');
      expect(p.ceremonies).toBe(2);
      expect(p.actions.map((a) => a.type)).toEqual(['usdClassTransfer', 'spotSend']);
      expect(p.actions[0].params).toEqual({ amount: '1.001', toPerp: false });
      expect(p.actions[1].params).toEqual({
        destination: HYPERCORE_EVM_SYSTEM_ADDRESS,
        token: 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
        amount: '1',
      });
    }
  );

  it('skips the perp→spot hop on a split account whose spot balance already covers it', () => {
    const p = plan({ mode: 'default', spotUsdc: '5.0', perpWithdrawable: '5.0' });
    expect(p.actions.map((a) => a.type)).toEqual(['spotSend']);
    expect(p.ceremonies).toBe(1);
  });

  it('flags the split route’s fee as unmeasured — only the sendAsset leg was executed on testnet', () => {
    expect(plan({ mode: 'unifiedAccount' }).feeMeasured).toBe(true);
    expect(plan({ mode: 'default', spotUsdc: '5' }).feeMeasured).toBe(false);
  });

  it('refuses a mode it could not read rather than guessing a route', () => {
    expect(() => plan({ mode: null })).toThrow(HyperEvmWithdrawalError);
    try {
      plan({ mode: null });
    } catch (err) {
      expect((err as HyperEvmWithdrawalError).code).toBe('account-mode-unknown');
      // Nothing was signed and nothing moved — the refusal is before the ceremony.
      expect((err as HyperEvmWithdrawalError).failure.fundsMoved).toBe('no');
    }
  });
});

describe('[#743] every doomed withdrawal is refused before a biometric prompt is spent', () => {
  it('refuses when the balance cannot cover amount + fee', () => {
    // 1.001 is needed; 1.0 is held. The fee is what makes this fail, which is
    // exactly the case a quote that ignored the fee would sign and lose.
    expect(() => plan({ spotUsdc: '1.0' })).toThrow(/insufficient-balance/);
    expect(() => plan({ spotUsdc: '1.001' })).not.toThrow();
  });

  it('refuses a split account whose perp + spot together fall short', () => {
    expect(() => plan({ mode: 'default', spotUsdc: '0.5', perpWithdrawable: '0.5' })).toThrow(
      /insufficient-balance/
    );
  });

  it('refuses a non-positive or malformed amount', () => {
    expect(() => plan({ amountUsdc: '0' })).toThrow(/invalid-amount/);
    expect(() => plan({ amountUsdc: 'all of it' })).toThrow(/invalid-amount/);
  });
});

describe('[#743] the plan names where the money lands', () => {
  it('sends to the pinned system address and pays out at the user’s own HyperEVM address', () => {
    const p = plan({ network: 'testnet' });
    expect(p.systemAddress).toBe('0x2000000000000000000000000000000000000000');
    expect(p.payoutAddress).toBe(USER);
    expect(p.chainId).toBe(998);
    expect(HYPEREVM_NETWORKS.mainnet.chainId).toBe(999);
    expect(plan({ network: 'mainnet' }).chainId).toBe(999);
  });

  it('the step-up summary names the destination and the amount', () => {
    const rows = describeHyperEvmStepUp(plan());
    expect(rows.action).toBe('sendAsset');
    expect(rows.amountUsdc).toBe('1');
    expect(rows.feeUsdc).toBe('0.001');
    expect(rows.debitUsdc).toBe('1.001');
    expect(rows.destination).toBe(HYPERCORE_EVM_SYSTEM_ADDRESS);
    expect(rows.payoutAddress).toBe(USER);
    expect(rows.chainId).toBe(998);
  });

  it('summarises each action of the two-ceremony split route', () => {
    const p = plan({ mode: 'default', spotUsdc: '0', perpWithdrawable: '5' });
    expect(p.actions.map((a) => a.summary.action)).toEqual(['usdClassTransfer', 'spotSend']);
    expect(p.actions[1].summary.destination).toBe(HYPERCORE_EVM_SYSTEM_ADDRESS);
    expect(p.actions[1].summary.amountUsdc).toBe('1');
  });
});

describe('[#743] success is observed on HyperEVM, never inferred from status: ok', () => {
  /** A balance reader that answers with the next value on each call. */
  function reader(values: bigint[]) {
    let i = 0;
    return async () => values[Math.min(i++, values.length - 1)];
  }

  it('confirms only once the payout is actually credited on chain', async () => {
    const result = await confirmHyperEvmPayout({
      readBalance: reader([0n, 0n, 1_000_000n]),
      balanceBefore: 0n,
      expectedUnits: 1_000_000n,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.confirmed).toBe(true);
    expect(result.creditedUsdc).toBe('1');
    expect(result.balanceAfter).toBe(1_000_000n);
  });

  it('a partial credit is not a payout', async () => {
    await expect(
      confirmHyperEvmPayout({
        readBalance: reader([0n, 999_999n]),
        balanceBefore: 0n,
        expectedUnits: 1_000_000n,
        pollIntervalMs: 10,
        timeoutMs: 30,
        sleep: async () => {},
      })
    ).rejects.toThrow(/payout-unconfirmed/);
  });

  it('an action that answered ok but never paid out fails as unconfirmed, and stays resumable', async () => {
    let thrown: HyperEvmWithdrawalError | null = null;
    try {
      await confirmHyperEvmPayout({
        readBalance: reader([5n]),
        balanceBefore: 5n,
        expectedUnits: 1_000_000n,
        pollIntervalMs: 10,
        timeoutMs: 30,
        sleep: async () => {},
      });
    } catch (err) {
      thrown = err as HyperEvmWithdrawalError;
    }
    expect(thrown?.code).toBe('payout-unconfirmed');
    // #693: the action was dispatched, so this is NOT "nothing happened" — and
    // it must be resumable rather than a stall, because the money may still land.
    expect(thrown?.failure.resumable).toBe(true);
    expect(thrown?.failure.resumeFrom).toBe('confirming');
    expect(thrown?.failure.fundsMoved).toBe('unknown');
  });

  it('a chain read that throws is retried inside the window rather than failing the flow', async () => {
    let call = 0;
    const result = await confirmHyperEvmPayout({
      readBalance: async () => {
        call += 1;
        if (call < 3) throw new Error('rpc down');
        return 1_000_000n;
      },
      balanceBefore: 0n,
      expectedUnits: 1_000_000n,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.confirmed).toBe(true);
  });
});

describe('[#743] failure states are named, and none of them is a silent stall', () => {
  it('classifies every failure with a resume point and whether funds moved', () => {
    const codes = Object.keys(HYPEREVM_WITHDRAWAL_FAILURES);
    expect(codes).toEqual(
      expect.arrayContaining([
        'account-mode-unknown',
        'usdc-token-unresolved',
        'invalid-amount',
        'insufficient-balance',
        'sign-declined',
        'action-rejected',
        'payout-unconfirmed',
        'payout-check-unavailable',
        'payout-token-unreadable',
      ])
    );
    for (const [code, failure] of Object.entries(HYPEREVM_WITHDRAWAL_FAILURES)) {
      expect(failure.code).toBe(code);
      expect(['quote', 'review', 'signing', 'relaying', 'confirming']).toContain(
        failure.resumeFrom
      );
      expect(['no', 'unknown', 'yes']).toContain(failure.fundsMoved);
      expect(failure.reason.length).toBeGreaterThan(0);
    }
  });

  it('everything refused before signing reports that nothing moved', () => {
    for (const code of [
      'account-mode-unknown',
      'usdc-token-unresolved',
      'payout-token-unreadable',
      'invalid-amount',
      'insufficient-balance',
      'sign-declined',
    ] as const) {
      expect(HYPEREVM_WITHDRAWAL_FAILURES[code].fundsMoved).toBe('no');
    }
  });
});

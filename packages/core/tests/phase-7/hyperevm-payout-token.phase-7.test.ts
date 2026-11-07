/**
 * [#788] Phase 7 · task 7.10.3 — the payout token, and the difference between
 * "the money is not there" and "we could not look".
 *
 * The second testnet walk withdrew successfully and the app said the money had
 * not appeared, because `balanceOf` was called on HyperCore's
 * **`CoreDepositWallet`** rather than on the USDC ERC-20. `spotMeta` is not
 * lying and it was not read wrong — probed live on 2026-08-02, BOTH networks
 * answer the deposit wallet in `tokens[].evmContract.address`:
 *
 * | network | `spotMeta` USDC `evmContract` | its `token()` — the ERC-20 |
 * |---|---|---|
 * | mainnet (999) | `0x6b9e7731…5390a24` | `0xb88339CB…2Ba630f` |
 * | testnet (998) | `0x0b80659a…3e5c206` | `0x2B3370eE…6457D8Ab` |
 *
 * `decimals()` reverts on the deposit wallet on both. So the linkage is still
 * discoverable at runtime exactly as ADR 7.9 requires — it just needs one more
 * hop, and the hop must be *verified* rather than assumed, which is what these
 * tests pin. The old fixtures asserted the ERC-20 came straight out of
 * `spotMeta`, which is why nothing caught it.
 *
 * Evidence: docs/roadmap/spikes/recordings/7.10.3-hyperevm-payout-token-probe.json
 */
import { describe, expect, it } from 'vitest';

import {
  HYPEREVM_WITHDRAWAL_FAILURES,
  HyperEvmWithdrawalError,
  confirmHyperEvmPayout,
  resolveHyperEvmPayoutToken,
  resolveUsdcSpotToken,
  type HexAddress,
  type HlSpotMetaResult,
  type HyperEvmPayoutTokenProbe,
} from '../../src/index';

/** HyperEVM testnet's CoreDepositWallet — what testnet `spotMeta` really returns. */
const CORE_DEPOSIT_WALLET = '0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206' as HexAddress;
/** The USDC ERC-20 it fronts — `token()`, and the only address `balanceOf` works on. */
const USDC_ERC20 = '0x2B3370eE501B4a559b57D449569354196457D8Ab' as HexAddress;

/** `spotMeta` as testnet actually answers it, not as the old fixtures wished. */
const LIVE_SPOT_META: HlSpotMetaResult = {
  universe: [],
  tokens: [
    {
      name: 'USDC',
      szDecimals: 8,
      weiDecimals: 8,
      index: 0,
      tokenId: '0xeb62eee3685fc4c43992febcd9e75443' as `0x${string}`,
      isCanonical: true,
      evmContract: { address: CORE_DEPOSIT_WALLET, evm_extra_wei_decimals: -2 },
      fullName: null,
      deployerTradingFeeShare: '0.0',
    },
  ],
};

/**
 * A chain, as the two probes see it. `decimals` lists the contracts that answer
 * `decimals()`; everything else reverts, which is what the deposit wallet does.
 */
function chain(options: {
  decimals?: Record<string, number>;
  token?: Record<string, HexAddress>;
}): HyperEvmPayoutTokenProbe {
  const decimals = options.decimals ?? {};
  const token = options.token ?? {};
  return {
    async readErc20Decimals(address) {
      const answer = decimals[address.toLowerCase()];
      if (answer === undefined) throw new Error(`The contract function "decimals" reverted.`);
      return answer;
    },
    async readDepositWalletToken(address) {
      const answer = token[address.toLowerCase()];
      if (answer === undefined) throw new Error(`The contract function "token" reverted.`);
      return answer;
    },
  };
}

const LIVE_CHAIN_998 = chain({
  decimals: { [USDC_ERC20.toLowerCase()]: 6 },
  token: { [CORE_DEPOSIT_WALLET.toLowerCase()]: USDC_ERC20 },
});

describe('[#788] spotMeta names a linked contract, which is not the ERC-20', () => {
  it('resolves the linkage testnet actually returns — the CoreDepositWallet', () => {
    const token = resolveUsdcSpotToken(LIVE_SPOT_META);
    // The fixture that would have caught the original defect: this IS what the
    // live endpoint answers, and it is NOT an address `balanceOf` works on.
    expect(token.linkedEvmContract).toBe(CORE_DEPOSIT_WALLET);
    expect(token.evmDecimals).toBe(6);
  });

  it('follows the deposit wallet’s token() to the ERC-20, and verifies it before using it', async () => {
    const meta = resolveUsdcSpotToken(LIVE_SPOT_META);
    const payout = await resolveHyperEvmPayoutToken({
      linkedContract: meta.linkedEvmContract,
      expectedDecimals: meta.evmDecimals,
      probe: LIVE_CHAIN_998,
    });

    expect(payout.address).toBe(USDC_ERC20);
    expect(payout.decimals).toBe(6);
    expect(payout.source).toBe('core-deposit-wallet-token');
    // The address spotMeta named is kept, because that is the thing that is
    // easy to mistake for the token and the thing an operator will want to see.
    expect(payout.linkedContract).toBe(CORE_DEPOSIT_WALLET);
  });

  it('uses the linked contract directly when it IS a readable ERC-20', async () => {
    const payout = await resolveHyperEvmPayoutToken({
      linkedContract: USDC_ERC20,
      expectedDecimals: 6,
      probe: LIVE_CHAIN_998,
    });
    expect(payout.address).toBe(USDC_ERC20);
    expect(payout.source).toBe('spot-meta-evm-contract');
  });
});

describe('[#788] a payout token that is not a readable ERC-20 refuses at plan time', () => {
  async function refusal(probe: HyperEvmPayoutTokenProbe, expectedDecimals = 6) {
    try {
      await resolveHyperEvmPayoutToken({
        linkedContract: CORE_DEPOSIT_WALLET,
        expectedDecimals,
        probe,
      });
    } catch (err) {
      return err as HyperEvmWithdrawalError;
    }
    throw new Error('expected a refusal');
  }

  it('refuses — loudly, and before anything is signed — when neither hop reads', async () => {
    const error = await refusal(chain({}));
    expect(error.code).toBe('payout-token-unreadable');
    // The whole point of moving this to plan time: nothing has moved, and the
    // user has not spent a ceremony on a withdrawal we could never confirm.
    expect(error.failure.fundsMoved).toBe('no');
    expect(error.failure.resumeFrom).toBe('quote');
    expect(error.message).toContain(CORE_DEPOSIT_WALLET);
  });

  it('refuses when token() answers something that is not a contract address', async () => {
    const zero = '0x0000000000000000000000000000000000000000' as HexAddress;
    const error = await refusal(chain({ token: { [CORE_DEPOSIT_WALLET.toLowerCase()]: zero } }));
    expect(error.code).toBe('payout-token-unreadable');
  });

  it('refuses when token() names a contract that is not an ERC-20 either', async () => {
    const error = await refusal(
      chain({ token: { [CORE_DEPOSIT_WALLET.toLowerCase()]: USDC_ERC20 } }),
    );
    expect(error.code).toBe('payout-token-unreadable');
  });

  it('refuses on a decimals mismatch rather than confirming against the wrong precision', async () => {
    const error = await refusal(LIVE_CHAIN_998, 18);
    expect(error.code).toBe('payout-token-unreadable');
    expect(error.message).toContain('18');
  });
});

describe('[#788] "we could not look" is not "the money is not there"', () => {
  const alwaysThrows = async (): Promise<bigint> => {
    throw new Error('The contract function "balanceOf" reverted.');
  };

  async function confirm(input: {
    readBalance: () => Promise<bigint>;
    balanceBefore: bigint | null;
  }) {
    try {
      await confirmHyperEvmPayout({
        readBalance: input.readBalance,
        balanceBefore: input.balanceBefore,
        expectedUnits: 1_000_000n,
        pollIntervalMs: 10,
        timeoutMs: 30,
        sleep: async () => {},
      });
    } catch (err) {
      return err as HyperEvmWithdrawalError;
    }
    throw new Error('expected a refusal');
  }

  it('a read that NEVER succeeds is a broken channel, not an unconfirmed payout', async () => {
    const error = await confirm({ readBalance: alwaysThrows, balanceBefore: 0n });
    // The existing suite only ever covered a read that later succeeds, which is
    // why a permanently reverting contract came out as `payout-unconfirmed` —
    // byte-identical to a genuine non-arrival.
    expect(error.code).toBe('payout-check-unavailable');
    expect(error.code).not.toBe('payout-unconfirmed');
    expect(error.failure.fundsMoved).toBe('unknown');
    expect(error.failure.resumeFrom).toBe('confirming');
    // The reason carries what actually went wrong, so the user is not told the
    // money is missing when the truth is that we could not read the chain.
    expect(error.message).toContain('balanceOf');
    expect(HYPEREVM_WITHDRAWAL_FAILURES['payout-check-unavailable'].reason).not.toMatch(
      /not appear|did not arrive|missing/i,
    );
  });

  it('a read that succeeds and shows no credit is still an unconfirmed payout', async () => {
    const error = await confirm({ readBalance: async () => 5n, balanceBefore: 5n });
    expect(error.code).toBe('payout-unconfirmed');
  });

  it('a baseline that could not be read does not throw the flow away — it is adopted in-window', async () => {
    let call = 0;
    const result = await confirmHyperEvmPayout({
      // The pre-dispatch read failed, so the baseline is null; the first read
      // that works becomes it, and the credit still confirms.
      readBalance: async () => {
        call += 1;
        if (call === 1) throw new Error('rpc down');
        return call === 2 ? 4_000_000n : 5_000_000n;
      },
      balanceBefore: null,
      expectedUnits: 1_000_000n,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.confirmed).toBe(true);
    expect(result.balanceBefore).toBe(4_000_000n);
    expect(result.creditedUsdc).toBe('1');
  });

  it('a null baseline whose reads all fail is the broken channel, not a missing payout', async () => {
    const error = await confirm({ readBalance: alwaysThrows, balanceBefore: null });
    expect(error.code).toBe('payout-check-unavailable');
  });
});

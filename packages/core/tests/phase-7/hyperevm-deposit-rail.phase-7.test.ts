import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, getAddress, toFunctionSelector } from 'viem';
import {
  CORE_DEPOSIT_FOR_ABI,
  CORE_DEPOSIT_FOR_SELECTOR,
  CORE_DEPOSIT_WITH_AUTH_SELECTOR,
  HYPERCORE_EVM_SYSTEM_ADDRESS,
  HYPERCORE_SYSTEM_ADDRESS_LANE_RECORDING,
  HYPE_SYSTEM_ADDRESS,
  HYPEREVM_ROUTE_MIN_DEPOSIT_USD,
  HyperEvmDepositError,
  HYPEREVM_DEPOSIT_FAILURES,
  buildHyperEvmDepositCalls,
  coreTokenSystemAddress,
  isCoreSystemAddress,
  confirmHyperEvmDepositCredit,
  describeHyperEvmDepositHop,
  planHyperEvmDeposit,
  type HexAddress,
  type HlSpotMetaResult,
  type PlanHyperEvmDepositInput,
} from '../../src';

/**
 * [#808] Phase 7 · ADR 7.9 decision 2 — the HyperEVM deposit rail.
 *
 * The user's own external wallet broadcasts `approve` + `depositFor(masterEOA,
 * amount, 0)`; the platform is not in the funds path. Three facts decide almost
 * every test below, and each was measured rather than assumed:
 *
 *  - **`depositFor` has no protocol minimum.** ADR 7.9 probed
 *    `depositFor(dead, 0, 0)` on both networks: the only amount guard is `> 0`.
 *    So the floor here is OURS (#794's economic 0.1), and it has to be enforced
 *    without ever claiming the chain would refuse.
 *  - **The credit lands in SPOT.** Spike 7.9 Q2 executed it on testnet with 1
 *    USDC: the recipient's spot balance rose, their perps `accountValue` stayed
 *    `0.0`. A deposit that stops there is not finished.
 *  - **`spotMeta`'s `evmContract` is the CoreDepositWallet, not the ERC-20**
 *    (#788). The deposit needs both — one to `approve`, one to `depositFor` —
 *    so it must walk the linkage and check it, not assume either address.
 */

const MASTER = '0x1111111111111111111111111111111111111111' as HexAddress;
const WALLET = '0x2222222222222222222222222222222222222222' as HexAddress;
/** ADR 7.9's testnet table: the CoreDepositWallet and the USDC it fronts. */
const DEPOSIT_WALLET = getAddress('0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206') as HexAddress;
const ERC20 = getAddress('0x2B3370eE501B4a559b57D449569354196457D8Ab') as HexAddress;

const SPOT_META: HlSpotMetaResult = {
  tokens: [
    {
      name: 'USDC',
      szDecimals: 2,
      weiDecimals: 8,
      index: 0,
      tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054',
      isCanonical: true,
      evmContract: { address: DEPOSIT_WALLET, evm_extra_wei_decimals: -2 },
      fullName: 'USD Coin',
      deployerTradingFeeShare: '0',
    },
  ],
  universe: [],
} as unknown as HlSpotMetaResult;

/** The linked contract reverts on `decimals()` and answers `token()` — exactly
 * what both networks do (#788), so this is the shape every plan resolves. */
function probe(over: Partial<{ decimals: (a: HexAddress) => Promise<number>; token: (a: HexAddress) => Promise<HexAddress> }> = {}) {
  return {
    readErc20Decimals:
      over.decimals ??
      (async (address: HexAddress) => {
        if (address === DEPOSIT_WALLET) throw new Error('execution reverted');
        if (address === ERC20) return 6;
        throw new Error(`unexpected decimals() at ${address}`);
      }),
    readDepositWalletToken: over.token ?? (async () => ERC20),
  };
}

function planInput(over: Partial<PlanHyperEvmDepositInput> = {}): PlanHyperEvmDepositInput {
  return {
    mode: 'default',
    network: 'testnet',
    recipient: MASTER,
    depositor: WALLET,
    amountUsdc: '5',
    spotMeta: SPOT_META,
    probe: probe(),
    wallet: { usdcUnits: 10_000_000n, allowanceUnits: 0n },
    ...over,
  };
}

describe('[#808] the deposit resolves its two addresses, and verifies them', () => {
  it('approves the ERC-20 and deposits at the CoreDepositWallet — never the other way round', async () => {
    const plan = await planHyperEvmDeposit(planInput());

    expect(plan.depositWallet).toBe(DEPOSIT_WALLET);
    expect(plan.token.address).toBe(ERC20);
    expect(plan.token.source).toBe('core-deposit-wallet-token');
    // The two are different contracts and `balanceOf`/`decimals` revert on the
    // first. Collapsing them is what reported a landed withdrawal as missing.
    expect(plan.depositWallet).not.toBe(plan.token.address);

    const [approve, deposit] = plan.calls;
    expect(approve!.kind).toBe('approve');
    expect(approve!.to).toBe(ERC20);
    expect(deposit!.kind).toBe('depositFor');
    expect(deposit!.to).toBe(DEPOSIT_WALLET);
  });

  it('refuses before any signature when neither address is a readable ERC-20', async () => {
    await expect(
      planHyperEvmDeposit(
        planInput({
          probe: probe({
            decimals: async () => {
              throw new Error('execution reverted');
            },
            token: async () => {
              throw new Error('execution reverted');
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'deposit-token-unreadable' });
  });

  it('refuses a token whose decimals disagree with what Core derives', async () => {
    // 8 + (−2) = 6. A token reporting 18 would make every amount wrong by
    // twelve orders of magnitude, so it refuses rather than converting.
    await expect(
      planHyperEvmDeposit(planInput({ probe: probe({ decimals: async () => 18 }) })),
    ).rejects.toMatchObject({ code: 'deposit-token-unreadable' });
  });

  it('refuses when spotMeta carries no USDC row to deposit against', async () => {
    await expect(
      planHyperEvmDeposit(
        planInput({ spotMeta: { tokens: [], universe: [] } as unknown as HlSpotMetaResult }),
      ),
    ).rejects.toMatchObject({ code: 'usdc-token-unresolved' });
  });
});

describe('[#808] the calls the external wallet broadcasts', () => {
  it('encodes approve for exactly the deposit, never unbounded', async () => {
    const plan = await planHyperEvmDeposit(planInput({ amountUsdc: '5' }));
    const [approve] = plan.calls;

    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve!.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args?.[0]).toBe(DEPOSIT_WALLET);
    expect(decoded.args?.[1]).toBe(5_000_000n);
    // An infinite approval to a contract the user never audited is a standing
    // claim on their whole balance; this rail never asks for one.
    expect(decoded.args?.[1]).not.toBe(2n ** 256n - 1n);
    expect(approve!.value).toBe(0n);
  });

  it('encodes depositFor(recipient, amount, 0) at the probed selector', async () => {
    const plan = await planHyperEvmDeposit(planInput({ amountUsdc: '5' }));
    const deposit = plan.calls.find((call) => call.kind === 'depositFor')!;

    // ADR 7.9 probed the signature on both networks; a drift here would send
    // money to a function that does not exist.
    expect(CORE_DEPOSIT_FOR_SELECTOR).toBe('0xc23c545a');
    expect(toFunctionSelector('depositFor(address,uint256,uint32)')).toBe(
      CORE_DEPOSIT_FOR_SELECTOR,
    );
    expect(deposit.data.slice(0, 10)).toBe(CORE_DEPOSIT_FOR_SELECTOR);

    const decoded = decodeFunctionData({ abi: CORE_DEPOSIT_FOR_ABI, data: deposit.data });
    expect(decoded.functionName).toBe('depositFor');
    // The RECIPIENT is the master EOA, not the wallet paying gas — that is the
    // whole reason this route works for a gasless account (ADR 7.9, spike Q1).
    expect(decoded.args?.[0]).toBe(MASTER);
    expect(decoded.args?.[1]).toBe(5_000_000n);
    expect(decoded.args?.[2]).toBe(0);
  });

  // The rail's gasless-looking sibling, pinned as the measured negative it is.
  // `depositWithAuth` takes no `from` and no recipient — `msg.sender` is both —
  // so a relayer calling it would move its OWN USDC into its OWN HyperCore
  // account. Measured on both networks 2026-08-10 (reads only):
  // docs/roadmap/spikes/7.9-hyperevm-depositwithauth-relayability.md
  it('pins depositWithAuth as recovered, and never builds a call to it', async () => {
    expect(CORE_DEPOSIT_WITH_AUTH_SELECTOR).toBe('0xea031649');
    expect(
      toFunctionSelector('depositWithAuth(uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32,uint32)'),
    ).toBe(CORE_DEPOSIT_WITH_AUTH_SELECTOR);

    // Eleven plausible spellings were absent from both deployments before this
    // one matched; a rename would strand a deposit at a function that is not
    // there, so the shape is asserted rather than trusted.
    expect(CORE_DEPOSIT_WITH_AUTH_SELECTOR).not.toBe(CORE_DEPOSIT_FOR_SELECTOR);

    const plan = await planHyperEvmDeposit(planInput({ amountUsdc: '5' }));
    for (const call of plan.calls) {
      expect(call.data.slice(0, 10)).not.toBe(CORE_DEPOSIT_WITH_AUTH_SELECTOR);
    }
  });

  it('skips the approval when the existing allowance already covers it', async () => {
    const plan = await planHyperEvmDeposit(
      planInput({ amountUsdc: '5', wallet: { usdcUnits: 10_000_000n, allowanceUnits: 5_000_000n } }),
    );
    expect(plan.calls.map((c) => c.kind)).toEqual(['depositFor']);
    expect(plan.transactionCount).toBe(1);

    const short = await planHyperEvmDeposit(
      planInput({ amountUsdc: '5', wallet: { usdcUnits: 10_000_000n, allowanceUnits: 4_999_999n } }),
    );
    expect(short.calls.map((c) => c.kind)).toEqual(['approve', 'depositFor']);
    expect(short.transactionCount).toBe(2);
  });

  it('builds the same calls from resolved addresses without a plan', () => {
    const calls = buildHyperEvmDepositCalls({
      token: ERC20,
      depositWallet: DEPOSIT_WALLET,
      recipient: MASTER,
      amountUnits: 100_000n,
      allowanceUnits: 0n,
      chainId: 998,
    });
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'depositFor']);
    for (const call of calls) expect(call.chainId).toBe(998);
  });
});

/**
 * The system-address lane, pinned as the measured negative it is.
 *
 * Hyperliquid documents a direct HyperEVM → HyperCore lane with no contract in
 * it, and read next to EIP-3009 it looks like the forwarder was never needed.
 * It is not available for USDC: Core token 0's linked contract is
 * `CoreDepositWallet`, not the ERC-20, so a transfer to `0x2000…0000` emits
 * from the wrong contract, is credited to nobody, and cannot be recovered —
 * testnet's system address is holding 19 USDC that someone already lost that
 * way.
 *
 * Asserted against the committed recording rather than restated, so a re-run
 * that contradicts these numbers fails here instead of in a deposit.
 */
describe('[#808] the HyperCore system-address lane is not a deposit path for USDC', () => {
  const recording = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        HYPERCORE_SYSTEM_ADDRESS_LANE_RECORDING,
      ),
      'utf8',
    ),
  ) as {
    networks: Record<
      string,
      {
        usdc: {
          linkedContract: string;
          erc20: string;
          systemAddress: string;
          systemAddressPerWrapper: string;
          linkedContractIsNotAnErc20: Record<string, string>;
          balances: { usdcHeldByLinkedContract: string; usdcHeldBySystemAddress: string };
        };
        plainlyLinkedControl: {
          coreTokenIndex: number;
          systemAddress: string;
          linkedContractIsTheErc20: boolean;
          balanceAtSystemAddress: string;
        } | null;
        liveDelivery: {
          found: boolean;
          linkedContractTransfer: { emittedBy: string; from: string; to: string };
          emittedCoreWriterAction: boolean;
        };
      }
    >;
  };

  it('derives a token system address, and agrees with the withdrawal rail at index 0', () => {
    // One derivation, two modules. The withdrawal rail pinned index 0 as a
    // literal long before this existed; if either moves, this fails rather than
    // letting the two disagree about where Core's money goes.
    expect(coreTokenSystemAddress(0)).toBe(getAddress(HYPERCORE_EVM_SYSTEM_ADDRESS));
    expect(coreTokenSystemAddress(268)).toBe(
      getAddress('0x200000000000000000000000000000000000010c'),
    );
    expect(() => coreTokenSystemAddress(-1)).toThrow(/non-negative/);
    expect(() => coreTokenSystemAddress(1.5)).toThrow(/non-negative integer/);
  });

  it('recognises the system-address family, including HYPE’s exception', () => {
    expect(isCoreSystemAddress(HYPERCORE_EVM_SYSTEM_ADDRESS)).toBe(true);
    expect(isCoreSystemAddress(coreTokenSystemAddress(268))).toBe(true);
    expect(isCoreSystemAddress(HYPE_SYSTEM_ADDRESS)).toBe(true);
    expect(isCoreSystemAddress(HYPE_SYSTEM_ADDRESS.toLowerCase())).toBe(true);
    // The two addresses this rail legitimately uses must never match.
    expect(isCoreSystemAddress(DEPOSIT_WALLET)).toBe(false);
    expect(isCoreSystemAddress(ERC20)).toBe(false);
  });

  it.each(['998', '999'])(
    'records that Core token 0 is linked to the wrapper, not the ERC-20 (chain %s)',
    (chainId) => {
      const net = recording.networks[chainId];
      expect(net.usdc.linkedContract).not.toBe(net.usdc.erc20);
      // Not an ERC-20 at all — which is why a `Transfer` from the ERC-20 is not
      // a `Transfer` from the linked contract, and is never credited.
      expect(net.usdc.linkedContractIsNotAnErc20).toEqual({
        decimals: 'reverts',
        name: 'reverts',
        symbol: 'reverts',
      });
      expect(getAddress(net.usdc.systemAddress)).toBe(coreTokenSystemAddress(0));
      expect(getAddress(net.usdc.systemAddressPerWrapper)).toBe(coreTokenSystemAddress(0));

      // The EVM-side supply sits in the wrapper. The system address is not
      // where USDC accumulates, because nothing is meant to arrive there.
      expect(BigInt(net.usdc.balances.usdcHeldByLinkedContract)).toBeGreaterThan(0n);
      expect(BigInt(net.usdc.balances.usdcHeldBySystemAddress)).toBeLessThan(
        BigInt(net.usdc.balances.usdcHeldByLinkedContract),
      );
    },
  );

  it('records the contrast: a plainly-linked token DOES hold its supply at its system address', () => {
    const control = recording.networks['999'].plainlyLinkedControl;
    expect(control).not.toBeNull();
    expect(control!.linkedContractIsTheErc20).toBe(true);
    expect(getAddress(control!.systemAddress)).toBe(coreTokenSystemAddress(control!.coreTokenIndex));
    expect(BigInt(control!.balanceAtSystemAddress)).toBeGreaterThan(0n);
  });

  it.each(['998', '999'])(
    'records that even the wrapper names ITSELF in the system-address Transfer (chain %s)',
    (chainId) => {
      const delivery = recording.networks[chainId].liveDelivery;
      expect(delivery.found).toBe(true);
      // The credit from this event lands in the wrapper's own Core account —
      // so no `Transfer` to a system address can credit a third party, and the
      // user is named in a separate CoreWriter action instead.
      expect(delivery.linkedContractTransfer.from).toBe(delivery.linkedContractTransfer.emittedBy);
      expect(getAddress(delivery.linkedContractTransfer.to)).toBe(coreTokenSystemAddress(0));
      expect(delivery.emittedCoreWriterAction).toBe(true);
    },
  );

  it.each(['token', 'depositWallet', 'recipient'] as const)(
    'refuses to build a deposit whose %s is a system address',
    (role) => {
      const base = {
        token: ERC20,
        depositWallet: DEPOSIT_WALLET,
        recipient: MASTER,
        amountUnits: 100_000n,
        allowanceUnits: 0n,
        chainId: 998,
      };
      expect(() =>
        buildHyperEvmDepositCalls({ ...base, [role]: coreTokenSystemAddress(0) }),
      ).toThrow(/system address/);
      // It must fail before producing calls, not alongside them: an `approve`
      // to a system address is a standing claim on the user's balance.
      expect(() => buildHyperEvmDepositCalls({ ...base, [role]: HYPE_SYSTEM_ADDRESS })).toThrow(
        /cannot be recovered/,
      );
    },
  );

  it('still builds the real rail untouched', () => {
    const calls = buildHyperEvmDepositCalls({
      token: ERC20,
      depositWallet: DEPOSIT_WALLET,
      recipient: MASTER,
      amountUnits: 100_000n,
      allowanceUnits: 0n,
      chainId: 998,
    });
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'depositFor']);
    for (const call of calls) expect(isCoreSystemAddress(call.to)).toBe(false);
  });
});

describe('[#808] the floor is ours, and it is enforced before signing', () => {
  it('refuses below the economic minimum, naming it as ours', async () => {
    await expect(
      planHyperEvmDeposit(planInput({ amountUsdc: '0.05' })),
    ).rejects.toMatchObject({ code: 'below-economic-minimum' });

    const failure = HYPEREVM_DEPOSIT_FAILURES['below-economic-minimum'];
    expect(failure.fundsMoved).toBe('no');
    // The chain would accept it. Saying otherwise would be false, and it is the
    // difference between this rail and the bridge's unrecoverable $5.
    expect(failure.reason).toMatch(/no protocol minimum|our floor/i);
  });

  it('accepts the amount the walk asked for, which the bridge could not', async () => {
    const plan = await planHyperEvmDeposit(planInput({ amountUsdc: '0.1' }));
    expect(plan.amountUnits).toBe(100_000n);
    expect(plan.minimum).toEqual({ usdc: String(HYPEREVM_ROUTE_MIN_DEPOSIT_USD), kind: 'economic' });
  });

  it('refuses an amount the wallet does not hold, before the wallet is asked', async () => {
    await expect(
      planHyperEvmDeposit(
        planInput({ amountUsdc: '5', wallet: { usdcUnits: 4_999_999n, allowanceUnits: 0n } }),
      ),
    ).rejects.toMatchObject({ code: 'insufficient-wallet-balance' });
  });

  it('refuses a malformed amount rather than coercing it', async () => {
    for (const amount of ['1e6', '0x10', '-1', 'abc', '']) {
      await expect(planHyperEvmDeposit(planInput({ amountUsdc: amount }))).rejects.toMatchObject({
        code: 'invalid-amount',
      });
    }
  });
});

describe('[#808] landing is not the same as being tradable', () => {
  it('adds the spot → perp hop for a split account', async () => {
    const plan = await planHyperEvmDeposit(planInput({ mode: 'default', amountUsdc: '5' }));
    expect(plan.settlesInto).toBe('spot');
    expect(plan.followUp.required).toBe(true);
    expect(plan.followUp.action).toEqual({ type: 'usdClassTransfer', params: { amount: '5', toPerp: true } });
    expect(plan.ceremonies).toBe(1);

    const summary = describeHyperEvmDepositHop(plan)!;
    expect(summary.action).toBe('usdClassTransfer');
    expect(summary.amountUsdc).toBe('5');
    // Nothing leaves the account on this leg — it crosses spot → perp inside
    // it, so the summary must not name a destination it does not have.
    expect(summary.destination).toBeNull();
  });

  it('needs no hop under a unified account — there is no divide to cross', async () => {
    const plan = await planHyperEvmDeposit(planInput({ mode: 'unifiedAccount' }));
    expect(plan.followUp.required).toBe(false);
    expect(plan.followUp.action).toBeUndefined();
    expect(plan.ceremonies).toBe(0);
    expect(describeHyperEvmDepositHop(plan)).toBeNull();
    expect(plan.followUp.reason).toMatch(/unified/i);
  });

  it('refuses a mode it could not read rather than guessing the hop', async () => {
    // A guess either spends a ceremony on an action the account rejects, or
    // leaves the money in spot while reporting a completed deposit.
    await expect(planHyperEvmDeposit(planInput({ mode: null }))).rejects.toMatchObject({
      code: 'account-mode-unknown',
    });
  });

  it('makes the middle of the flow resumable, and names where the money is', () => {
    const pending = HYPEREVM_DEPOSIT_FAILURES['hop-pending'];
    expect(pending.resumable).toBe(true);
    expect(pending.resumeFrom).toBe('transferring');
    // The money is in the account — just not where the trading screen looks.
    // "Failed" would be false and "done" would be worse.
    expect(pending.fundsMoved).toBe('yes');
    expect(pending.reason).toMatch(/spot/i);

    for (const failure of Object.values(HYPEREVM_DEPOSIT_FAILURES)) {
      expect(failure.reason.length).toBeGreaterThan(0);
      expect(['no', 'unknown', 'yes']).toContain(failure.fundsMoved);
    }
  });

  it('reports every pre-broadcast refusal as funds untouched', async () => {
    for (const code of [
      'account-mode-unknown',
      'usdc-token-unresolved',
      'deposit-token-unreadable',
      'invalid-amount',
      'below-economic-minimum',
      'insufficient-wallet-balance',
      'wallet-declined',
    ] as const) {
      expect(HYPEREVM_DEPOSIT_FAILURES[code].fundsMoved).toBe('no');
    }
  });
});

describe('[#808] the credit is confirmed on Core, not assumed from a receipt', () => {
  const sleep = () => Promise.resolve();

  it('confirms once the spot balance carries the deposit', async () => {
    let now = 0;
    const readBalance = vi
      .fn<[], Promise<bigint>>()
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValue(6_000_000n);

    const confirmation = await confirmHyperEvmDepositCredit({
      readSpotUsdcUnits: readBalance,
      balanceBefore: 1_000_000n,
      expectedUnits: 5_000_000n,
      pollIntervalMs: 1,
      timeoutMs: 100,
      sleep,
      now: () => (now += 10),
    });

    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.creditedUsdc).toBe('5');
  });

  it('separates "we could not look" from "it is not there"', async () => {
    let now = 0;
    // Every read fails: this says nothing about the deposit, so it must not
    // claim the money is missing (#788's lesson, in the other direction).
    await expect(
      confirmHyperEvmDepositCredit({
        readSpotUsdcUnits: async () => {
          throw new Error('api unreachable');
        },
        balanceBefore: null,
        expectedUnits: 5_000_000n,
        pollIntervalMs: 1,
        timeoutMs: 30,
        sleep,
        now: () => (now += 10),
      }),
    ).rejects.toMatchObject({ code: 'credit-check-unavailable' });

    let then = 0;
    await expect(
      confirmHyperEvmDepositCredit({
        readSpotUsdcUnits: async () => 1_000_000n,
        balanceBefore: 1_000_000n,
        expectedUnits: 5_000_000n,
        pollIntervalMs: 1,
        timeoutMs: 30,
        sleep,
        now: () => (then += 10),
      }),
    ).rejects.toMatchObject({ code: 'deposit-unconfirmed' });
  });

  it('takes the first successful read as the baseline when the pre-read failed', async () => {
    let now = 0;
    const readBalance = vi
      .fn<[], Promise<bigint>>()
      .mockResolvedValueOnce(2_000_000n)
      .mockResolvedValue(7_000_000n);

    const confirmation = await confirmHyperEvmDepositCredit({
      readSpotUsdcUnits: readBalance,
      balanceBefore: null,
      expectedUnits: 5_000_000n,
      pollIntervalMs: 1,
      timeoutMs: 100,
      sleep,
      now: () => (now += 10),
    });
    expect(confirmation.balanceBefore).toBe(2_000_000n);
    expect(confirmation.confirmed).toBe(true);
  });

  it('carries its failures as HyperEvmDepositError, with the taxonomy attached', async () => {
    const error = await planHyperEvmDeposit(planInput({ mode: null })).catch((e) => e);
    expect(error).toBeInstanceOf(HyperEvmDepositError);
    expect(error.failure).toBe(HYPEREVM_DEPOSIT_FAILURES['account-mode-unknown']);
  });
});

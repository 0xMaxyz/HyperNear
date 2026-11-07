/**
 * [#902] Phase 7 · task 7.10.6 — the HyperEVM withdrawal fee is FLAT, not
 * proportional.
 *
 * The rail shipped with `HYPEREVM_WITHDRAWAL_FEE_RATE = 0.00088` — 0.088% of
 * the amount — inferred from spike 7.9's single measurement: a `1.0` payout that
 * cost `0.00088`. At that one size "0.088% of the amount" and "≈0.0009 flat"
 * agree exactly, so the sample could not tell them apart. It is the same error
 * ADR 7.9.10 corrected on the CCTP router, where a flat 0.20 divided by one
 * 22 USDC transfer read as a 1.13% margin.
 *
 * Spike 7.10.6 read every payout both testnet accounts have ever made
 * (`docs/roadmap/spikes/recordings/7.10.6-hyperevm-withdrawal-fee-run.json`,
 * `userNonFundingLedgerUpdates`, read-only). These tests assert the model
 * against **that recording**, not against numbers retyped here: the point of the
 * task is that a constant must not outrun its data, and a test that hardcodes
 * the same guess would fail the same way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HYPERCORE_EVM_SYSTEM_ADDRESS,
  HYPEREVM_FIRST_TRANSFER_SURCHARGE_USDC,
  HYPEREVM_WITHDRAWAL_FEE_MEASURED_AT,
  HYPEREVM_WITHDRAWAL_FEE_OBSERVED,
  HYPEREVM_WITHDRAWAL_FEE_RECORDING,
  HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC,
  WITHDRAW3_FLAT_FEE_USDC,
  parseUsdcAmount,
  quoteHyperEvmWithdrawal,
  withdrawalRoutes,
} from '../../src/index';

interface RecordedPayout {
  account: string;
  at: string;
  amountUsdc: string;
  feeUsdc: string;
  impliedRate: number;
}

const RECORDING = JSON.parse(
  readFileSync(resolve(__dirname, '../../../..', HYPEREVM_WITHDRAWAL_FEE_RECORDING), 'utf8'),
) as {
  systemAddress: string;
  payouts: RecordedPayout[];
  oneOffSurcharge: { observations: RecordedPayout[] };
  summary: { amountVariesTimes: number; feeVariesTimes: number; quotedFeeUsdc: string };
};

/** The 16 payouts the fee model is fitted to — the 1 USDC outlier is its own case. */
const ORDINARY = RECORDING.payouts.filter((p) => parseUsdcAmount(p.feeUsdc) < parseUsdcAmount('0.5'));

const QUOTED_FEE_UNITS = parseUsdcAmount(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);

describe('[#902] the recording is what the model is fitted to', () => {
  it('is a spread, not one point: every row is a real payout and the amounts span >100×', () => {
    expect(RECORDING.systemAddress).toBe(HYPERCORE_EVM_SYSTEM_ADDRESS.toLowerCase());
    expect(ORDINARY.length).toBeGreaterThanOrEqual(10);

    const amounts = ORDINARY.map((p) => parseUsdcAmount(p.amountUsdc));
    const smallest = amounts.reduce((a, b) => (a < b ? a : b));
    const largest = amounts.reduce((a, b) => (a > b ? a : b));
    expect(Number(largest) / Number(smallest)).toBeGreaterThan(100);
  });

  it('the fee does not move with the amount — a 999× spread in size moved it under 2×', () => {
    const fees = ORDINARY.map((p) => parseUsdcAmount(p.feeUsdc));
    const cheapest = fees.reduce((a, b) => (a < b ? a : b));
    const dearest = fees.reduce((a, b) => (a > b ? a : b));

    expect(Number(dearest) / Number(cheapest)).toBeLessThan(2);
    expect(RECORDING.summary.amountVariesTimes).toBeGreaterThan(100);
    expect(RECORDING.summary.feeVariesTimes).toBeLessThan(2);
  });

  it('two different amounts were charged the SAME fee — the fact a rate cannot express', () => {
    const byFee = new Map<string, Set<string>>();
    for (const p of ORDINARY) {
      byFee.set(p.feeUsdc, (byFee.get(p.feeUsdc) ?? new Set()).add(p.amountUsdc));
    }
    const sharedFee = [...byFee.values()].filter((amounts) => amounts.size > 1);
    expect(sharedFee.length).toBeGreaterThan(0);
  });

  it('refutes the retired rate against its own data: 0.088% of the largest payout is >100× the fee charged', () => {
    const largest = ORDINARY.reduce((a, b) =>
      parseUsdcAmount(a.amountUsdc) > parseUsdcAmount(b.amountUsdc) ? a : b,
    );
    const predicted = (parseUsdcAmount(largest.amountUsdc) * 88n) / 100_000n;
    expect(Number(predicted) / Number(parseUsdcAmount(largest.feeUsdc))).toBeGreaterThan(100);
    // …and the implied rate collapses across the sample, which is the tell: a
    // real rate is the one thing that would have stayed constant.
    const smallest = ORDINARY.reduce((a, b) =>
      parseUsdcAmount(a.amountUsdc) < parseUsdcAmount(b.amountUsdc) ? a : b,
    );
    expect(largest.impliedRate).toBeLessThan(smallest.impliedRate / 100);
  });

  it('the constants say what the recording says — no number is retyped from memory', () => {
    const fees = ORDINARY.map((p) => parseUsdcAmount(p.feeUsdc));
    expect(HYPEREVM_WITHDRAWAL_FEE_OBSERVED.samples).toBe(ORDINARY.length);
    expect(parseUsdcAmount(HYPEREVM_WITHDRAWAL_FEE_OBSERVED.minUsdc)).toBe(
      fees.reduce((a, b) => (a < b ? a : b)),
    );
    expect(parseUsdcAmount(HYPEREVM_WITHDRAWAL_FEE_OBSERVED.maxUsdc)).toBe(
      fees.reduce((a, b) => (a > b ? a : b)),
    );
    expect(HYPEREVM_WITHDRAWAL_FEE_MEASURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('[#902] the quote charges a flat fee, at every size', () => {
  const sizes = ['0.5', '1', '10', '100', '1000', '25000'];

  it('quotes the same absolute fee whatever the amount', () => {
    for (const size of sizes) {
      const quote = quoteHyperEvmWithdrawal(size);
      expect(quote.feeUsdc).toBe(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);
      expect(quote.feeShape).toBe('flat');
    }
  });

  it('debits the payout plus the flat fee — the fee is charged ON TOP, not deducted', () => {
    expect(quoteHyperEvmWithdrawal('1').debitUsdc).toBe('1.001');
    expect(quoteHyperEvmWithdrawal('1000').debitUsdc).toBe('1000.001');
    // `withdraw3` is the other way round: its flat $1 comes out of the signed
    // amount. Conflating the two directions is how a balance check goes short.
    expect(quoteHyperEvmWithdrawal('50').debitUsdc).toBe('50.001');
  });

  it('never quotes less than the chain has ever charged — the whole point of a ceiling', () => {
    for (const payout of ORDINARY) {
      expect(parseUsdcAmount(payout.feeUsdc)).toBeLessThanOrEqual(QUOTED_FEE_UNITS);
    }
    // …and it is a ceiling over the observations rather than a number picked to
    // be safe: it sits within 2× of the dearest one, so over-quoting stays
    // negligible in absolute terms.
    const dearest = ORDINARY.map((p) => parseUsdcAmount(p.feeUsdc)).reduce((a, b) => (a > b ? a : b));
    expect(Number(QUOTED_FEE_UNITS)).toBeLessThan(Number(dearest) * 2);
  });

  it('states the fee as a proportion of THIS payout, and it shrinks as the amount grows', () => {
    // The field survives, its meaning does not: it is derived per quote now, so
    // it can never again be mistaken for the model. A user reading it sees the
    // truth a flat fee has — bigger withdrawals are proportionally cheaper.
    const small = quoteHyperEvmWithdrawal('1');
    const large = quoteHyperEvmWithdrawal('1000');
    expect(small.feeRate).toBeCloseTo(0.001, 12);
    expect(large.feeRate).toBeCloseTo(0.000001, 12);
    expect(large.feeRate).toBeLessThan(small.feeRate);
  });

  it('is cheaper than `withdraw3` at EVERY size, by the same factor', () => {
    // The old model made this a claim about small withdrawals — 1,136× at 1
    // USDC, and worse than withdraw3 above ~1,136. Flat against flat, the ratio
    // is constant and the rail wins everywhere, which is the product fact #902
    // asked to surface.
    const factors = sizes.map((size) => quoteHyperEvmWithdrawal(size).timesCheaperThanWithdraw3);
    for (const factor of factors) expect(factor).toBe(factors[0]);
    expect(Math.round(factors[0])).toBe(1000);
    expect(quoteHyperEvmWithdrawal('25000').withdraw3FeeUsdc).toBe(WITHDRAW3_FLAT_FEE_USDC);
  });

  it('carries the provenance of the measurement it is now based on', () => {
    const quote = quoteHyperEvmWithdrawal('1');
    expect(quote.recording).toBe(HYPEREVM_WITHDRAWAL_FEE_RECORDING);
    expect(quote.measuredAt).toBe(HYPEREVM_WITHDRAWAL_FEE_MEASURED_AT);
    expect(quote.estimated).toBe(true);
  });
});

describe('[#902] the one-off surcharge is recorded, not modelled', () => {
  it('is in the recording as an observation, kept out of the per-withdrawal fee', () => {
    const [surcharged] = RECORDING.oneOffSurcharge.observations;
    expect(surcharged).toBeTruthy();
    // Exactly 1 USDC above an ordinary fee, on that account's first outgoing
    // transfer. Folding it into the rate is what would make every withdrawal
    // quote a dollar it does not cost.
    expect(parseUsdcAmount(surcharged.feeUsdc)).toBeGreaterThan(parseUsdcAmount('1'));
    expect(parseUsdcAmount(HYPEREVM_FIRST_TRANSFER_SURCHARGE_USDC)).toBe(parseUsdcAmount('1'));
    expect(quoteHyperEvmWithdrawal('1').feeUsdc).toBe(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);
  });
});

describe('[#902] the withdrawal registry stops advertising a rate', () => {
  it.each(['mainnet', 'testnet'] as const)('the HyperEVM row on %s is a flat fee', (network) => {
    const hyperEvm = withdrawalRoutes(network).find((route) => route.id === 'hyperEvm');
    expect(hyperEvm).toBeTruthy();
    expect(hyperEvm!.feeKind).toBe('flat');
    expect(hyperEvm!.feeUsdc).toBe(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);
    expect(hyperEvm!.feeRate).toBeUndefined();
  });

  it('leaves the two flat rails distinguishable — three rows, three different fees', () => {
    const fees = withdrawalRoutes('testnet').map((route) => route.feeUsdc);
    expect(new Set(fees).size).toBe(fees.length);
  });
});

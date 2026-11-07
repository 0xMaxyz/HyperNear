/**
 * [#1170] Phase 14 — what a Route A deposit may be charged for the chain gas
 * its own top-ups spent.
 *
 * This is the arithmetic half, isolated from the router that feeds it. Every
 * case here is a way the charge can be wrong in the user's favour or the
 * platform's, and the asymmetry matters: charging too little quietly restores
 * the loss #1170 exists to close, while charging too much delivers less than
 * the user was quoted — which is the one outcome no amount of reconciliation
 * can put right after the fact.
 *
 * The figures are the ones from the first successful mainnet Route A run
 * (request `4dfb4995…`), so a regression here is measured against a real
 * deposit rather than a round number chosen to make the test pass.
 */
import { describe, expect, it } from 'vitest';

import {
  measureDepositGasSpend,
  microsToUsdString,
  planDepositGasRecovery,
  ROUTE_A_GAS_USD,
  ROUTE_B_GAS_USD,
  type DepositGasSpendRow,
} from '../../src/index';

/** The BSC top-up from the first mainnet run: 0.0000040625 BNB. */
const BSC_WEI = '4062500000000';
/** The TON top-up from the same run: 0.02375 TON. */
const TON_NANO = '23750000';

const TON_USD = 3.2;
const BNB_USD = 700;

/** A ledger balance far above any charge, so the "too small" guard never fires. */
const AMPLE = 6_000_000n;

function gasRow(overrides: Partial<DepositGasSpendRow> & Pick<DepositGasSpendRow, 'kind'>): DepositGasSpendRow {
  return {
    amount: '0',
    broadcastTxHash: '0xtopup',
    detail: { forStep: '1' },
    ...overrides,
  };
}

const bscRow = (amount = BSC_WEI, forStep = '1'): DepositGasSpendRow =>
  gasRow({ kind: 'bsc-gas-top-up', amount, detail: { forStep } });

const tonRow = (amount = TON_NANO, forStep = '3'): DepositGasSpendRow =>
  gasRow({ kind: 'ton-gas-top-up', amount, detail: { forStep } });

const plan = (rows: DepositGasSpendRow[], overrides: Partial<Parameters<typeof planDepositGasRecovery>[0]> = {}) =>
  planDepositGasRecovery({
    route: 'A',
    rows,
    tonUsd: TON_USD,
    bnbUsd: BNB_USD,
    capUsd: ROUTE_A_GAS_USD,
    availableBalance: AMPLE,
    ...overrides,
  });

describe('[#1170] measuring what the tanks actually gave up', () => {
  it('sums the native top-ups per chain, from the rows the router already commits', () => {
    expect(measureDepositGasSpend('A', [bscRow(), tonRow(), tonRow(TON_NANO, '4')])).toEqual({
      bscWei: BigInt(BSC_WEI),
      tonNano: BigInt(TON_NANO) * 2n,
    });
  });

  it('ignores a row that was reserved but never broadcast — it moved no money', () => {
    // A reservation commits BEFORE the top-up is sent, so a crash or a lost
    // compare-and-set genuinely leaves rows behind that funded nothing. Re-issue
    // claims the NEXT attempt row rather than overwriting, so these accumulate.
    const unsent: DepositGasSpendRow = { ...bscRow(), broadcastTxHash: undefined };
    expect(measureDepositGasSpend('A', [unsent]).bscWei).toBe(0n);
    expect(measureDepositGasSpend('A', [unsent, bscRow()]).bscWei).toBe(BigInt(BSC_WEI));
  });

  it("ignores Route B's gas rows, which share this table", () => {
    // Route B's sweep reserves 1091-1093 with the same `bsc-gas-top-up` kind.
    // Only `detail.forStep` tells them apart, and billing a Route A user for a
    // Route B sweep is the failure that filter exists to prevent.
    expect(measureDepositGasSpend('A', [bscRow(BSC_WEI, '9')]).bscWei).toBe(0n);
  });

  it('bills Route B for step 9 and for nothing else', () => {
    // The mirror image, and the half that would have been missed: Route B must
    // not be billed for Route A's steps either. A request carries one route;
    // the rows do not say so, and `forStep` is the whole of the distinction.
    expect(measureDepositGasSpend('B', [bscRow(BSC_WEI, '9')]).bscWei).toBe(BigInt(BSC_WEI));
    expect(measureDepositGasSpend('B', [bscRow(BSC_WEI, '1')]).bscWei).toBe(0n);
    expect(measureDepositGasSpend('B', [tonRow(TON_NANO, '3')]).tonNano).toBe(0n);
  });

  it('sees no TON on Route B at all — that arm is inert rather than wrong', () => {
    const hop = { kind: 'ton-seqno', detail: { residualBeneficiary: 'gas-tank', residualNano: '99' } };
    expect(measureDepositGasSpend('B', [bscRow(BSC_WEI, '9'), hop])).toEqual({
      bscWei: BigInt(BSC_WEI),
      tonNano: 0n,
    });
  });

  it('ignores a row with no forStep at all rather than guessing which route it served', () => {
    expect(measureDepositGasSpend('A', [gasRow({ kind: 'bsc-gas-top-up', amount: BSC_WEI, detail: {} })]).bscWei).toBe(0n);
  });

  it('nets out the residual TON already swept back to the gas tank', () => {
    // The double-charge this filter prevents: steps 3 and 4 hand their leftover
    // TON back to the tank when it is below the user-return threshold, and that
    // leftover is largely the top-up itself. Charging the gross figure bills the
    // user for the part that came home.
    const hop = { kind: 'ton-seqno', detail: { residualBeneficiary: 'gas-tank', residualNano: '10000000' } };
    expect(measureDepositGasSpend('A', [tonRow(), hop]).tonNano).toBe(BigInt(TON_NANO) - 10_000_000n);
  });

  it('does NOT net out a residual that went to the user — that is not the platform getting paid back', () => {
    const hop = { kind: 'ton-seqno', detail: { residualBeneficiary: 'user', residualNano: '10000000' } };
    expect(measureDepositGasSpend('A', [tonRow(), hop]).tonNano).toBe(BigInt(TON_NANO));
  });

  it('clamps at zero when more came back than went out, rather than crediting the user', () => {
    const hop = { kind: 'ton-seqno', detail: { residualBeneficiary: 'gas-tank', residualNano: '99999999999' } };
    expect(measureDepositGasSpend('A', [tonRow(), hop]).tonNano).toBe(0n);
  });

  it('has no BSC equivalent — nothing sweeps native BNB back, so it is charged gross', () => {
    const hop = { kind: 'bsc-nonce', detail: { residualBeneficiary: 'gas-tank', residualNano: '10000000' } };
    expect(measureDepositGasSpend('A', [bscRow(), hop]).bscWei).toBe(BigInt(BSC_WEI));
  });
});

describe('[#1170] pricing it', () => {
  it('charges the real mainnet spend at realistic prices — a few cents, not a round number', () => {
    const result = plan([bscRow(), tonRow(), tonRow(TON_NANO, '4')]);
    // 0.0000040625 BNB @ $700 = $0.00284375
    // 0.0475 TON        @ $3.20 = $0.152
    // Together above the cap, so this run charges the disclosed line.
    expect(result.measuredMicros).toBe(154_843n);
    expect(result.capped).toBe(true);
    expect(result.chargedMicros).toBe(150_000n);
    expect(result.gasUnits).toBe(150_000n);
  });

  it('a micro-dollar IS a USDT base unit — the conversion is the identity, not a rescale', () => {
    // Both are 1e-6 of a dollar. Any rescale here would be a factor-of-N bug of
    // exactly the kind `amounts.ts` documents for 18-vs-6-decimal USDT.
    const result = plan([bscRow()]);
    expect(result.gasUnits).toBe(result.chargedMicros);
  });

  it('rounds DOWN, so truncation favours the user', () => {
    // A spend that cannot be expressed in whole micro-dollars must lose the
    // fraction to the user, never gain it for the platform.
    const result = plan([bscRow('1')], { bnbUsd: 1 });
    expect(result.measuredMicros).toBe(0n);
    expect(result.gasUnits).toBe(0n);
  });

  it('caps at the gas line the user was quoted, and says it did', () => {
    const result = plan([tonRow('1000000000')], { tonUsd: 5 });
    expect(result.capped).toBe(true);
    expect(result.chargedMicros).toBe(BigInt(Math.round(ROUTE_A_GAS_USD * 1e6)));
    // The measured figure is kept, not overwritten by the cap: it is the only
    // evidence that the disclosed constant has drifted below reality.
    expect(result.measuredMicros).toBeGreaterThan(result.chargedMicros);
  });

  it('does not cap a spend that fits, and reports capped:false', () => {
    const result = plan([bscRow()]);
    expect(result.capped).toBe(false);
    expect(result.chargedMicros).toBe(result.measuredMicros);
  });
});

describe('[#1170] every way the charge is refused', () => {
  it.each([
    ['no TON price', { tonUsd: undefined }],
    ['no BNB price', { bnbUsd: undefined }],
    ['a zero price', { tonUsd: 0, bnbUsd: 0 }],
    ['a negative price', { tonUsd: -3 }],
    ['a NaN price', { tonUsd: Number.NaN }],
    ['an infinite price', { bnbUsd: Number.POSITIVE_INFINITY }],
  ])('charges nothing on %s — never a guessed one', (_label, overrides) => {
    expect(plan([bscRow(), tonRow()], overrides).gasUnits).toBe(0n);
  });

  it('charges nothing when no gas was spent at all', () => {
    expect(plan([]).gasUnits).toBe(0n);
    expect(plan([{ kind: 'bsc-nonce', detail: {} }]).gasUnits).toBe(0n);
  });

  it('charges nothing when the deduction would not leave a positive delivery', () => {
    // "A deposit too small to carry its own gas." The answer is never a zero or
    // negative delivery; it is no charge, and the platform absorbs the gas.
    const charge = plan([bscRow(), tonRow()]).gasUnits;
    expect(charge).toBeGreaterThan(0n);
    expect(plan([bscRow(), tonRow()], { availableBalance: charge }).gasUnits).toBe(0n);
    expect(plan([bscRow(), tonRow()], { availableBalance: charge - 1n }).gasUnits).toBe(0n);
    expect(plan([bscRow(), tonRow()], { availableBalance: charge + 1n }).gasUnits).toBe(charge);
  });

  it('still reports what it measured when it refuses to charge, so the loss is visible', () => {
    const refused = plan([bscRow(), tonRow()], { availableBalance: 1n });
    expect(refused.gasUnits).toBe(0n);
    expect(refused.measuredMicros).toBeGreaterThan(0n);
  });

  it('charges nothing when the cap itself is zero or nonsense', () => {
    expect(plan([bscRow(), tonRow()], { capUsd: 0 }).gasUnits).toBe(0n);
    expect(plan([bscRow(), tonRow()], { capUsd: -1 }).gasUnits).toBe(0n);
  });

  it('tolerates a malformed amount as zero rather than throwing mid-settlement', () => {
    expect(plan([bscRow('not-a-number'), tonRow()]).measuredMicros).toBe(
      plan([tonRow()]).measuredMicros,
    );
  });
});

describe('[#1170] microsToUsdString', () => {
  it('renders a charge as a plain decimal, trailing zeros trimmed', () => {
    expect(microsToUsdString(150_000n)).toBe('0.15');
    expect(microsToUsdString(154_843n)).toBe('0.154843');
    expect(microsToUsdString(0n)).toBe('0');
    expect(microsToUsdString(1_000_000n)).toBe('1');
    expect(microsToUsdString(1n)).toBe('0.000001');
  });

  it('never loses the integer part, however small the fraction', () => {
    expect(microsToUsdString(12_000_001n)).toBe('12.000001');
  });
});

describe("[#1170] Route B's own charge", () => {
  const planB = (rows: DepositGasSpendRow[], overrides: Record<string, unknown> = {}) =>
    planDepositGasRecovery({
      route: 'B',
      rows,
      tonUsd: TON_USD,
      bnbUsd: BNB_USD,
      capUsd: ROUTE_B_GAS_USD,
      availableBalance: AMPLE,
      ...overrides,
    });

  it('charges the BSC sweep it actually paid for', () => {
    // One transfer at the first mainnet run's own top-up figure. Route B's cap
    // covers two of these — the sweep and the collection — so a single sweep
    // sits comfortably under it.
    const result = planB([bscRow(BSC_WEI, '9')]);
    expect(result.measuredMicros).toBe(2_843n);
    expect(result.capped).toBe(false);
    expect(result.gasUnits).toBe(2_843n);
  });

  it('is capped by ROUTE_B_GAS_USD, which is a different line from Route A’s', () => {
    // The caps are per route because the disclosures are per route. Charging a
    // Route B deposit up to Route A's line would take four hops' worth of gas
    // out of a deposit that paid for one.
    expect(ROUTE_B_GAS_USD).toBeLessThan(ROUTE_A_GAS_USD);
    const result = planB([bscRow('900000000000000000', '9')]);
    expect(result.capped).toBe(true);
    expect(result.chargedMicros).toBe(BigInt(Math.round(ROUTE_B_GAS_USD * 1e6)));
  });

  it('is not zero — the constant that said Route B pays no gas was wrong', () => {
    // `ROUTE_B_GAS_USD` read 0 and its docblock said Route B "touches no chain
    // the platform pays gas on", while its sweep was funded from the BSC tank
    // on every deposit. A zero cap would charge nothing however much was spent.
    expect(ROUTE_B_GAS_USD).toBeGreaterThan(0);
    expect(planB([bscRow(BSC_WEI, '9')]).gasUnits).toBeGreaterThan(0n);
  });

  it('still refuses when the deposit is too small to carry it', () => {
    const charge = planB([bscRow(BSC_WEI, '9')]).gasUnits;
    expect(planB([bscRow(BSC_WEI, '9')], { availableBalance: charge }).gasUnits).toBe(0n);
  });
});

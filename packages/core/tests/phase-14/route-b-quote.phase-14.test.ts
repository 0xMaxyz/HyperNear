/**
 * [#771] Phase 14 · Epic 14.3 · Task 14.3.2 — Route B's pure half.
 *
 * Everything here is checked against the traffic task 14.1.1 actually recorded
 * (`docs/roadmap/spikes/recordings/14.1.1-oneclick-hypercore-run.json`) rather
 * than against the roadmap's prose about it. Four facts from that run are
 * load-bearing for this route, and each one is re-derived below rather than
 * quoted:
 *
 *  1. the server adds a deterministic **72 h** to whatever deadline is asked
 *     for, so the RESPONSE deadline is the only one worth persisting;
 *  2. a **dry quote carries no deadline, no `timeWhenInactive` and no
 *     `depositAddress`** — so it can neither be persisted nor withdrawn
 *     against, which is why `dry` is not a parameter Route B exposes;
 *  3. `slippageTolerance: 1` is accepted and executes; `10000` exactly is
 *     arithmetically invalid at any size (`400 "Division by zero"`), which is
 *     why the builder's ceiling is 9999 rather than 10000;
 *  4. the server injects a 10 bp `appFees` entry into every quote.
 *
 * The arithmetic is checked separately, because it is the part that decides how
 * much money moves. The arrival is the amount the user REQUESTED and the quote
 * goes ~10 bp under it to stay out of `EXACT_INPUT`'s whole-deposit-refund
 * branch — which holds because the submit asks the exchange for `amount + fee`
 * and the exchange nets the fee back out of that (#1047, `exchangeSubmitAmount`).
 * 14.1.4/#771 record the reverse ("fee on top") as settled; it was never
 * observed, and one live mainnet withdrawal falsified it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OneClickQuoteExpiringError,
  ROUTE_B_MIN_DEADLINE_FOR_CONFIRM_MS,
  ROUTE_B_MIN_DEADLINE_FOR_SUBMIT_MS,
  ROUTE_B_MIN_DEPOSIT_USD,
  ROUTE_B_QUOTE_WINDOW_MS,
  ROUTE_B_UNDERQUOTE_BPS,
  RouteBAmountRefusedError,
  assertQuoteDeadlineUsable,
  assertRouteBAmount,
  buildRouteBQuoteRequest,
  fromBaseUnits,
  assertWithdrawableAgainstMetadata,
  exchangeSubmitAmount,
  predictRouteBArrival,
  routeBCostDisclosure,
  toBaseUnits,
  type HexAddress,
} from '../../src/index';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RECORDING_PATH = 'docs/roadmap/spikes/recordings/14.1.1-oneclick-hypercore-run.json';

interface RecordedQuote {
  label: string;
  requestedDeadline: string;
  httpStatus: number;
  request: Record<string, unknown> & { dry: boolean; slippageTolerance: number; amount: string };
  response: {
    quote?: {
      amountOut: string;
      minAmountOut: string;
      deadline?: string;
      timeWhenInactive?: string;
      depositAddress?: string;
    };
    quoteRequest?: { appFees?: { recipient: string; fee: number }[] };
    signature?: string;
    message?: string;
  };
}

const recording = JSON.parse(
  readFileSync(join(repoRoot, RECORDING_PATH), 'utf8'),
) as { quotes: RecordedQuote[] };

const live = recording.quotes.filter((q) => !q.request.dry && q.httpStatus === 201);
const dry = recording.quotes.filter((q) => q.request.dry && q.httpStatus === 201);

const USDT_BSC = 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g';
const HYPERCORE_USDC = '1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const MASTER = '0x0000008398d108F4DC04d84518F3B4eC5E4A86C5' as HexAddress;
/** A platform treasury intents account. Lowercased EVM address by convention. */
const TREASURY = '0x00000000000000000000000000000000000fee01';

const USDT_DECIMALS = 18;

describe('[#771] the recording still says what Route B is built on', () => {
  it('has live quotes to check against (the fixture is alive)', () => {
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(dry.length).toBeGreaterThanOrEqual(3);
  });

  it('the RESPONSE deadline is the requested one plus exactly 72 h, every time', () => {
    for (const quote of live) {
      const requested = Date.parse(quote.requestedDeadline);
      const returned = Date.parse(quote.response.quote!.deadline!);
      expect(returned - requested, quote.label).toBe(72 * 60 * 60 * 1000);
      // …and `timeWhenInactive` — when the address stops taking funds — is the
      // same instant, which is what makes the deadline the thing to persist.
      expect(quote.response.quote!.timeWhenInactive).toBe(quote.response.quote!.deadline);
    }
  });

  it('a dry quote has no deadline, no timeWhenInactive and no deposit address', () => {
    for (const quote of dry) {
      expect(quote.response.quote!.deadline, quote.label).toBeUndefined();
      expect(quote.response.quote!.timeWhenInactive, quote.label).toBeUndefined();
      expect(quote.response.quote!.depositAddress, quote.label).toBeUndefined();
    }
  });

  it('every quote is signed — the only evidence a dispute could be resolved on', () => {
    for (const quote of [...live, ...dry]) {
      expect(quote.response.signature, quote.label).toMatch(/^ed25519:/);
    }
  });

  it('the server injects a 10 bp appFees entry of its own', () => {
    const fees = live[0].response.quoteRequest?.appFees ?? [];
    expect(fees).toHaveLength(1);
    expect(fees[0].fee).toBe(10);
  });

  it('rejects slippageTolerance 10000 as arithmetically impossible, not merely out of range', () => {
    const byLabel = (needle: string) => recording.quotes.find((q) => q.label.includes(needle))!;
    // Worth pinning precisely, because the roadmap records this as "returns a
    // 500" and the run says otherwise: it is a 400, and its message says why.
    // A 100% tolerance leaves no output to divide into, at any size — which is
    // what makes 9999 the builder's ceiling rather than a cautious choice.
    const excluded = byLabel('slippage 10000');
    expect(excluded.httpStatus).toBe(400);
    expect(excluded.response.message).toMatch(/division by zero/i);
  });

  it('shows why a near-100% tolerance is unusable even where the range accepts it', () => {
    const byLabel = (needle: string) => recording.quotes.find((q) => q.label.includes(needle))!;
    // 9999 is inside the accepted range and still refused at 20 USDT: the
    // minimum output collapses below the bridge's floor. Route B quotes at 1
    // (0.01%) instead — the destination leg is a fixed-fee hop, so a wide
    // tolerance buys nothing and costs the quote.
    const wide = byLabel('slippage 9999');
    expect(wide.httpStatus).toBe(400);
    expect(wide.response.message).toMatch(/too low for bridge/i);
  });
});

describe('[#771] the quote request Route B builds matches the recorded one', () => {
  const recorded = live[0];

  const built = buildRouteBQuoteRequest({
    originAsset: USDT_BSC,
    destinationAsset: HYPERCORE_USDC,
    amountUnits: recorded.request.amount,
    recipient: MASTER,
    refundIntentsAccount: TREASURY,
    deadline: recorded.requestedDeadline,
  });

  it('pins the same route the recording walked: BSC USDT in, HyperCore USDC out', () => {
    expect(built.originAsset).toBe(recorded.request.originAsset);
    expect(built.destinationAsset).toBe(recorded.request.destinationAsset);
    expect(built.depositType).toBe('ORIGIN_CHAIN');
    expect(built.recipientType).toBe('DESTINATION_CHAIN');
    expect(built.swapType).toBe('EXACT_INPUT');
    expect(built.amount).toBe(recorded.request.amount);
  });

  it('quotes at 0.01% slippage — the value the recording proved executes', () => {
    expect(built.slippageTolerance).toBe(1);
    expect(built.slippageTolerance).toBe(recorded.request.slippageTolerance);
  });

  it('is never dry, and offers no way to make it dry', () => {
    expect(built.dry).toBe(false);
    // The type carries no `dry` parameter at all — a dry quote returns nothing
    // that can be persisted or withdrawn against.
    expect(Object.keys(built)).not.toContain('dryRun');
  });

  it('refunds to the platform treasury as INTENTS, not to a BSC address', () => {
    // The one deliberate divergence from the recording. An ORIGIN_CHAIN refund
    // lands USDT at a BSC address the user has no BNB to sweep; an INTENTS
    // refund needs no gas and lands somewhere the platform can act on.
    expect(built.refundType).toBe('INTENTS');
    expect(built.refundTo).toBe(TREASURY);
    expect(built.refundTo).not.toBe(built.recipient);
  });

  it('refuses a slippage outside the range the server actually accepts', () => {
    const base = {
      originAsset: USDT_BSC,
      destinationAsset: HYPERCORE_USDC,
      amountUnits: '20000000000000000000',
      recipient: MASTER,
      refundIntentsAccount: TREASURY,
      deadline: recorded.requestedDeadline,
    };
    expect(() => buildRouteBQuoteRequest({ ...base, slippageTolerance: 10_000 })).toThrow(/9999/);
    expect(() => buildRouteBQuoteRequest({ ...base, slippageTolerance: -1 })).toThrow();
    expect(buildRouteBQuoteRequest({ ...base, slippageTolerance: 9_999 }).slippageTolerance).toBe(
      9_999,
    );
  });

  it('refuses to build without a treasury to refund to', () => {
    expect(() =>
      buildRouteBQuoteRequest({
        originAsset: USDT_BSC,
        destinationAsset: HYPERCORE_USDC,
        amountUnits: '20000000000000000000',
        recipient: MASTER,
        refundIntentsAccount: '',
        deadline: recorded.requestedDeadline,
      }),
    ).toThrow(/treasury/);
  });
});

describe('[#771] base units are exact', () => {
  it('round-trips USDT-BSC at 18 decimals', () => {
    expect(toBaseUnits('20', 18).toString()).toBe('20000000000000000000');
    expect(toBaseUnits('0.7', 18).toString()).toBe('700000000000000000');
    expect(fromBaseUnits(20_000_000_000_000_000_000n, 18)).toBe('20');
    expect(fromBaseUnits(700_000_000_000_000_000n, 18)).toBe('0.7');
  });

  it('does not go through a float', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; here it is not a float at all.
    const sum = toBaseUnits('0.1', 18) + toBaseUnits('0.2', 18);
    expect(fromBaseUnits(sum, 18)).toBe('0.3');
  });

  it('refuses more precision than the asset has, rather than truncating it', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow(/decimal places/);
  });
});

describe('[#771] the arrival prediction: quote the arrival, submit the arrival + fee', () => {
  const FEE = '0.7';

  it('arrival is the amount REQUESTED, and what to submit is amount + fee', () => {
    const arrival = predictRouteBArrival({ amount: '50', exchangeFee: FEE, decimals: USDT_DECIMALS });
    // What the user asked to land. The quote is built for this figure.
    expect(arrival.arrivalUnits).toBe(toBaseUnits('50', USDT_DECIMALS).toString());
    // …and what has to be ASKED of the exchange for that to happen, because its
    // `amount` parameter is the debit and it sends the remainder (#1047).
    expect(arrival.debited).toBe('50.7');
    expect(arrival.debited).toBe(
      exchangeSubmitAmount({ amount: '50', exchangeFee: FEE, decimals: USDT_DECIMALS }),
    );
  });

  it('quotes under the ARRIVAL, never under the submitted figure', () => {
    // The failure this exists to prevent: quoting against `debited` would
    // overshoot the arrival by the fee and put the deposit in EXACT_INPUT's
    // whole-deposit-refund branch — the most expensive failure on this route.
    const arrival = predictRouteBArrival({ amount: '50', exchangeFee: FEE, decimals: USDT_DECIMALS });
    expect(BigInt(arrival.quotedInputUnits)).toBeLessThan(BigInt(arrival.arrivalUnits));
    expect(BigInt(arrival.quotedInputUnits)).toBeLessThan(
      toBaseUnits(arrival.debited, USDT_DECIMALS),
    );
  });

  it('quotes at least the full 10 bp under the arrival, never a rounding step short', () => {
    for (const amount of ['50', '50.000000000000000001', '137.42', '1000', '9999.999999']) {
      const arrival = predictRouteBArrival({ amount, exchangeFee: FEE, decimals: USDT_DECIMALS });
      const arrived = BigInt(arrival.arrivalUnits);
      const quoted = BigInt(arrival.quotedInputUnits);
      const shortfall = arrived - quoted;
      // The deduction rounds UP, so the margin is >= 10 bp for every size.
      expect(shortfall * 10_000n >= arrived * BigInt(ROUTE_B_UNDERQUOTE_BPS)).toBe(true);
      // …and it is not wildly more than 10 bp either — one base unit of slack.
      expect(shortfall * 10_000n <= arrived * BigInt(ROUTE_B_UNDERQUOTE_BPS) + 10_000n).toBe(true);
    }
  });

  it('refuses a non-positive amount rather than quoting one', () => {
    expect(() =>
      predictRouteBArrival({ amount: '0', exchangeFee: FEE, decimals: USDT_DECIMALS }),
    ).toThrow();
  });
});

describe('[#771] the $50 floor and the provider’s own limits, and which one refused', () => {
  const FEE = '0.7';

  it('refuses below the platform floor and states the percentage', () => {
    let error: RouteBAmountRefusedError | undefined;
    try {
      assertRouteBAmount({ amount: '10', exchangeFee: FEE });
    } catch (err) {
      error = err as RouteBAmountRefusedError;
    }
    expect(error?.bound).toBe('platform-floor');
    expect(error?.limit).toBe(ROUTE_B_MIN_DEPOSIT_USD);
    // $0.32 fixed + 19 bp on $10 is $0.339, plus the 0.7 exchange fee = $1.04 —
    // 10.39% of the deposit. That number is the argument for the floor, so it
    // is in the refusal rather than in a comment somewhere.
    expect(error?.message).toContain('10.39% of the deposit');
  });

  it('names the PROVIDER when its live minimum is the binding one', () => {
    let error: RouteBAmountRefusedError | undefined;
    try {
      // Above the platform's $50 but below a provider that has raised its own.
      assertRouteBAmount({ amount: '60', exchangeFee: FEE, providerMin: '100' });
    } catch (err) {
      error = err as RouteBAmountRefusedError;
    }
    expect(error?.bound).toBe('provider-minimum');
    expect(error?.limit).toBe('100');
  });

  it('names the PROVIDER’s maximum, which the platform has no equivalent of', () => {
    let error: RouteBAmountRefusedError | undefined;
    try {
      assertRouteBAmount({ amount: '60000', exchangeFee: FEE, providerMax: '50000' });
    } catch (err) {
      error = err as RouteBAmountRefusedError;
    }
    expect(error?.bound).toBe('provider-maximum');
    expect(error?.limit).toBe('50000');
  });

  it('enforces the platform floor even where the provider would allow less', () => {
    // Testnet's withdrawMin is 3 and production's is 2 (14.1.4). Neither makes a
    // $5 deposit worth making on this route.
    expect(() => assertRouteBAmount({ amount: '5', exchangeFee: FEE, providerMin: '3' })).toThrow(
      RouteBAmountRefusedError,
    );
  });

  it('accepts an amount that clears both', () => {
    expect(() =>
      assertRouteBAmount({ amount: '100', exchangeFee: FEE, providerMin: '2', providerMax: '50000' }),
    ).not.toThrow();
  });

  it('[#1047] bounds the provider limits on the SUBMITTED amount, not the bare one', () => {
    // 49999.5 + a 0.7 fee is 50000.2, and 50000.2 is what goes in the
    // exchange's `amount` field — so the exchange refuses it. This used to be
    // compared against 49999.5, quote fine, and be refused by
    // `assertWithdrawableAgainstMetadata` at submit — after the user had spent
    // the two-code ceremony. Same value at both ends now.
    let error: RouteBAmountRefusedError | undefined;
    try {
      assertRouteBAmount({ amount: '49999.5', exchangeFee: FEE, providerMax: '50000' });
    } catch (err) {
      error = err as RouteBAmountRefusedError;
    }
    expect(error?.bound).toBe('provider-maximum');
    // The refusal names the figure that was actually compared, not just the cap.
    expect(error?.message).toContain('50000.2');
    // One fee lower and it fits, at both ends.
    expect(() =>
      assertRouteBAmount({ amount: '49998', exchangeFee: FEE, providerMax: '50000' }),
    ).not.toThrow();
  });

  it('[#1047] the same value clears the submit-side check that runs after it', () => {
    // The two ends, side by side: what `assertRouteBAmount` admits at quote
    // time is exactly what `assertWithdrawableAgainstMetadata` sees at submit,
    // because the submit sends `exchangeSubmitAmount(amount, fee)`.
    const metadata = {
      asset: 'USDT',
      network: 'BSC',
      providerNetwork: 'BSC',
      withdrawEnabled: true,
      withdrawalFee: FEE,
      minWithdrawal: '2',
      maxWithdrawal: '50000',
    };
    for (const amount of ['50', '1000', '49999.3']) {
      expect(() =>
        assertRouteBAmount({
          amount,
          exchangeFee: FEE,
          providerMin: metadata.minWithdrawal,
          providerMax: metadata.maxWithdrawal,
        }),
      ).not.toThrow();
      expect(() =>
        assertWithdrawableAgainstMetadata(
          exchangeSubmitAmount({ amount, exchangeFee: FEE, decimals: USDT_DECIMALS }),
          metadata,
        ),
      ).not.toThrow();
    }
  });
});

describe('[#771] the cost disclosure names both halves', () => {
  it('shows the exchange fee alongside the route cost, not the route alone', () => {
    const cost = routeBCostDisclosure({ amount: '100', exchangeFee: '0.7' });
    expect(cost.routeCostUsd).toBe('0.51'); // 0.32 fixed + 19 bp of 100
    expect(cost.exchangeFeeUsd).toBe('0.70');
    expect(cost.totalCostUsd).toBe('1.21');
    // On a $100 deposit the exchange's flat fee (70 bp) is LARGER than the
    // whole route cost (51 bp) — which is exactly why a disclosure naming the
    // route alone would understate what this deposit costs by more than half.
    expect(Number(cost.exchangeFeeUsd)).toBeGreaterThan(Number(cost.routeCostUsd));
    expect(cost.totalCostPercent).toBe('1.21');
  });
});

describe('[#771] a quote with too little life left cannot be withdrawn against', () => {
  const NOW = Date.parse('2026-08-06T12:00:00Z');

  it('accepts a fresh quote, measured against the REQUESTED window', () => {
    const requested = new Date(NOW + ROUTE_B_QUOTE_WINDOW_MS);
    expect(() => assertQuoteDeadlineUsable(requested.toISOString(), NOW)).not.toThrow();
  });

  // The inverted assertion. This suite used to assert the opposite — that a
  // requested 1 h window "comes back as 73 h" and that the 73 h value is what
  // the gate reads. Mainnet proved it wrong: a quote requested 07:19:54Z with a
  // response deadline of Aug 25 was REFUNDED at 08:20:02Z, eight seconds past
  // the requested hour. Gating on the response value is what let a dead quote
  // pass for three days, so the response deadline must NOT satisfy the gate on
  // its own once the requested window has run out.
  it('does not treat the response +72 h as runway once the requested window has passed', () => {
    const responseDeadline = new Date(NOW + ROUTE_B_QUOTE_WINDOW_MS + 72 * 60 * 60 * 1000);
    const afterRequestedWindow = NOW + ROUTE_B_QUOTE_WINDOW_MS + 1;
    // The response deadline is still days away, and that is precisely the trap:
    // the SWAP is already dead. Only the requested deadline may be passed here.
    const requested = new Date(NOW + ROUTE_B_QUOTE_WINDOW_MS).toISOString();
    expect(() => assertQuoteDeadlineUsable(requested, afterRequestedWindow)).toThrow(
      OneClickQuoteExpiringError,
    );
    // Sanity: the response value would have sailed through, which is the bug.
    expect(() =>
      assertQuoteDeadlineUsable(responseDeadline.toISOString(), afterRequestedWindow),
    ).not.toThrow();
  });

  it('refuses a submit with less than the submit floor remaining', () => {
    const almost = new Date(NOW + ROUTE_B_MIN_DEADLINE_FOR_SUBMIT_MS - 60_000).toISOString();
    expect(() => assertQuoteDeadlineUsable(almost, NOW)).toThrow(OneClickQuoteExpiringError);
  });

  // The confirm step's own floor: the human work is done, only the ~2 m transfer
  // is left, so a window too short to START a withdrawal can still be long
  // enough to RELEASE one.
  it('accepts a confirm at a remaining time that would refuse a submit', () => {
    const between = new Date(NOW + ROUTE_B_MIN_DEADLINE_FOR_SUBMIT_MS - 60_000).toISOString();
    expect(() =>
      assertQuoteDeadlineUsable(between, NOW, ROUTE_B_MIN_DEADLINE_FOR_CONFIRM_MS),
    ).not.toThrow();
  });

  it('refuses a confirm below the confirm floor', () => {
    const almost = new Date(NOW + ROUTE_B_MIN_DEADLINE_FOR_CONFIRM_MS - 30_000).toISOString();
    expect(() =>
      assertQuoteDeadlineUsable(almost, NOW, ROUTE_B_MIN_DEADLINE_FOR_CONFIRM_MS),
    ).toThrow(OneClickQuoteExpiringError);
  });

  it('refuses an already-expired quote', () => {
    expect(() => assertQuoteDeadlineUsable(new Date(NOW - 1).toISOString(), NOW)).toThrow(
      /went inactive/,
    );
  });

  it('refuses a missing deadline — which is what a dry quote has', () => {
    expect(() => assertQuoteDeadlineUsable(undefined, NOW)).toThrow(OneClickQuoteExpiringError);
  });

  it('refuses an unparseable deadline rather than treating NaN as "fine"', () => {
    expect(() => assertQuoteDeadlineUsable('not-a-date', NOW)).toThrow(OneClickQuoteExpiringError);
  });
});

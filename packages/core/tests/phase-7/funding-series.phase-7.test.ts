/**
 * [#816] Phase 7 · Epic 7.11 · Task 7.11.1 — the funding series' maths.
 *
 * The chart's `1h` / `8h` / `D` toggles are sums of one hourly series, not
 * three upstream reads (docs/roadmap/spikes/7.11-funding-history-api.md): the
 * venue charges funding hourly and quotes an 8-hour rate that is eight of those
 * added up. So the arithmetic here *is* the feature, and every case below is a
 * way it silently produces a wrong-but-plausible chart:
 *
 *  - **alignment** — buckets have to land on the venue's own 00:00/08:00/16:00
 *    UTC boundaries, or the "8h funding" a trader reads here is a different
 *    eight hours from the one the exchange quotes;
 *  - **the leading partial bucket** — three hours summed into a bucket that
 *    should hold eight is a smaller number, indistinguishable from funding
 *    actually falling, produced entirely by where the window happened to start;
 *  - **duplicate hours** — two upstream pages stitched together overlap by
 *    construction, and charging the same hour twice inflates the cumulative
 *    line, which is the number a trader reads as their carry;
 *  - **the cumulative line** — it must be the running sum of exactly what is
 *    plotted, so the last point answers "what has holding this cost".
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FUNDING_CHART_INTERVALS,
  FUNDING_INTERVAL_MS,
  SdkManager,
  aggregateFundingSamples,
  fetchFundingHistory,
  fundingRateToPercent,
  totalFunding,
  type FundingRateSample,
  type HlClientLike,
} from '../../src/index';

const HOUR = 3_600_000;
/** A UTC midnight, so bucket boundaries in the expectations are readable. */
const MIDNIGHT = Date.UTC(2026, 6, 1, 0, 0, 0);

/**
 * `count` hourly samples from `startHour`, each at the venue's real shape: on
 * the hour, with the few milliseconds of publication jitter the live API shows.
 */
function hourlySamples(
  startHour: number,
  count: number,
  rate: number | ((index: number) => number) = 0.00001
): FundingRateSample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    time: startHour + index * HOUR + (index % 7) + 23,
    fundingRate: String(typeof rate === 'function' ? rate(index) : rate),
    premium: '0.0001',
  }));
}

describe('[#816] aggregateFundingSamples — bucketing', () => {
  it('passes hourly samples through one bucket each', () => {
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 3), '1h');
    expect(points.map((p) => p.time)).toEqual([MIDNIGHT, MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR]);
    expect(points.every((p) => p.partial)).toBe(false);
  });

  it('sums eight hourly rates into the 8h rate the venue quotes', () => {
    const [point] = aggregateFundingSamples(hourlySamples(MIDNIGHT, 8, 0.0000125), '8h');
    // 0.0000125/h × 8 = 0.0001 = 0.01 % — the number Hyperliquid's own 8h
    // toggle shows for that rate.
    expect(point.rate).toBeCloseTo(0.0001, 12);
    expect(fundingRateToPercent(point.rate)).toBeCloseTo(0.01, 12);
  });

  it('aligns 8h buckets to 00:00 / 08:00 / 16:00 UTC', () => {
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 24), '8h');
    expect(points.map((p) => p.time)).toEqual([
      MIDNIGHT,
      MIDNIGHT + 8 * HOUR,
      MIDNIGHT + 16 * HOUR,
    ]);
    expect(points.map((p) => new Date(p.time).getUTCHours())).toEqual([0, 8, 16]);
  });

  it('aligns daily buckets to UTC midnight', () => {
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 48), '1d');
    expect(points.map((p) => p.time)).toEqual([MIDNIGHT, MIDNIGHT + 24 * HOUR]);
    expect(points.every((p) => new Date(p.time).getUTCHours() === 0)).toBe(true);
  });

  it('starts a new 8h bucket at the boundary payment, not after it', () => {
    // The 08:00 payment opens the second bucket; the first holds 00:00–07:00.
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 9), '8h');
    expect(points[0].time).toBe(MIDNIGHT);
    expect(points[1].time).toBe(MIDNIGHT + 8 * HOUR);
    expect(points[1].partial).toBe(true);
  });

  it('ignores publication jitter — a record at H:00:00.043 is H s bucket', () => {
    const [point] = aggregateFundingSamples(
      [{ time: MIDNIGHT + 43, fundingRate: '0.00001', premium: '0' }],
      '1h'
    );
    expect(point.time).toBe(MIDNIGHT);
  });
});

describe('[#816] aggregateFundingSamples — incomplete buckets', () => {
  it('drops a short leading bucket rather than drawing it as a dip', () => {
    // A window that opens at 05:00 gives the 00:00 bucket only three hours.
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT + 5 * HOUR, 11), '8h');
    expect(points.map((p) => p.time)).toEqual([MIDNIGHT + 8 * HOUR]);
    expect(points[0].partial).toBe(false);
  });

  it('keeps the still-forming trailing bucket, flagged partial', () => {
    // 00:00–15:00: one complete bucket, then the live one, four hours in.
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 12), '8h');
    expect(points).toHaveLength(2);
    expect(points[0].partial).toBe(false);
    expect(points[1].partial).toBe(true);
    expect(points[1].rate).toBeCloseTo(4 * 0.00001, 12);
  });

  it('flags a bucket the venue left a gap in', () => {
    const withGap = hourlySamples(MIDNIGHT, 8).filter((_s, index) => index !== 3);
    const [point] = aggregateFundingSamples(withGap, '8h');
    expect(point.partial).toBe(true);
    expect(point.rate).toBeCloseTo(7 * 0.00001, 12);
  });

  it('returns nothing for an empty series rather than a zero point', () => {
    expect(aggregateFundingSamples([], '8h')).toEqual([]);
    expect(totalFunding([])).toBe(0);
  });

  it('drops a lone leading partial bucket, leaving nothing to plot', () => {
    expect(aggregateFundingSamples(hourlySamples(MIDNIGHT + 5 * HOUR, 2), '8h')).toEqual([]);
  });
});

describe('[#816] aggregateFundingSamples — input the venue actually returns', () => {
  it('orders out-of-order samples instead of trusting arrival order', () => {
    const shuffled = [...hourlySamples(MIDNIGHT, 6, (i) => (i + 1) / 1_000_000)].reverse();
    const points = aggregateFundingSamples(shuffled, '1h');
    expect(points.map((p) => p.time)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => MIDNIGHT + i * HOUR)
    );
    expect(points[5].cumulativeRate).toBeCloseTo(21 / 1_000_000, 12);
  });

  it('counts a repeated hour once — stitched pages overlap by construction', () => {
    const page = hourlySamples(MIDNIGHT, 8, 0.0000125);
    const stitched = [...page, ...page.slice(5)];
    const [point] = aggregateFundingSamples(stitched, '8h');
    expect(point.rate).toBeCloseTo(0.0001, 12);
    expect(point.partial).toBe(false);
  });

  it('dedupes by the hour, not the millisecond — publication jitter differs per page', () => {
    const page = hourlySamples(MIDNIGHT, 8, 0.0000125);
    const rePublished = page.slice(5).map((sample) => ({ ...sample, time: sample.time + 9 }));
    const [point] = aggregateFundingSamples([...page, ...rePublished], '8h');
    expect(point.rate).toBeCloseTo(0.0001, 12);
    expect(point.partial).toBe(false);
  });

  it('skips a malformed rate instead of poisoning the sum with NaN', () => {
    const samples = hourlySamples(MIDNIGHT, 8, 0.00001);
    samples[2] = { ...samples[2], fundingRate: 'n/a' };
    const [point] = aggregateFundingSamples(samples, '8h');
    expect(Number.isFinite(point.rate)).toBe(true);
    expect(point.rate).toBeCloseTo(7 * 0.00001, 12);
    expect(point.partial).toBe(true);
  });

  it('carries negative funding through as a negative bucket', () => {
    const points = aggregateFundingSamples(
      hourlySamples(MIDNIGHT, 8, (i) => (i < 4 ? -0.00002 : 0.00001)),
      '8h'
    );
    expect(points[0].rate).toBeCloseTo(-0.00004, 12);
  });
});

describe('[#816] the cumulative line', () => {
  it('is the running sum of exactly the plotted buckets', () => {
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT, 24, 0.0000125), '8h');
    expect(points.map((p) => p.cumulativeRate)).toEqual([
      points[0].rate,
      points[0].rate + points[1].rate,
      points[0].rate + points[1].rate + points[2].rate,
    ]);
  });

  it('ends at the same total whichever interval it was bucketed into', () => {
    const samples = hourlySamples(MIDNIGHT, 24, (i) => (i % 5) / 1_000_000);
    const totals = FUNDING_CHART_INTERVALS.map((interval) =>
      totalFunding(aggregateFundingSamples(samples, interval))
    );
    for (const total of totals) expect(total).toBeCloseTo(totals[0], 12);
  });

  it('excludes a dropped leading partial bucket from the total', () => {
    const points = aggregateFundingSamples(hourlySamples(MIDNIGHT + 5 * HOUR, 11), '8h');
    expect(totalFunding(points)).toBeCloseTo(8 * 0.00001, 12);
  });

  it('falls back toward zero when funding flips sign', () => {
    const points = aggregateFundingSamples(
      hourlySamples(MIDNIGHT, 16, (i) => (i < 8 ? 0.00002 : -0.00002)),
      '8h'
    );
    expect(points[0].cumulativeRate).toBeCloseTo(0.00016, 12);
    expect(totalFunding(points)).toBeCloseTo(0, 12);
  });
});

describe('[#816] FUNDING_INTERVAL_MS', () => {
  it('is the hour multiple each label claims', () => {
    expect(FUNDING_INTERVAL_MS).toEqual({ '1h': HOUR, '8h': 8 * HOUR, '1d': 24 * HOUR });
  });
});

describe('[#816] fetchFundingHistory', () => {
  const sdkFor = (client: Partial<HlClientLike>): SdkManager =>
    ({ getReadOnlyHlClient: () => client as HlClientLike }) as unknown as SdkManager;

  it('maps the venue record to the venue-neutral sample', async () => {
    const fundingHistory = vi.fn().mockResolvedValue([
      { coin: 'BTC', fundingRate: '0.0000125', premium: '0.0000304', time: MIDNIGHT },
    ]);
    const samples = await fetchFundingHistory(sdkFor({ fundingHistory }), 'BTC', MIDNIGHT - HOUR);
    expect(samples).toEqual([
      { time: MIDNIGHT, fundingRate: '0.0000125', premium: '0.0000304' },
    ]);
    expect(fundingHistory).toHaveBeenCalledWith({
      coin: 'BTC',
      startTime: MIDNIGHT - HOUR,
      endTime: undefined,
    });
  });

  it('passes an explicit endTime through — pagination depends on the bound', async () => {
    const fundingHistory = vi.fn().mockResolvedValue([]);
    await fetchFundingHistory(sdkFor({ fundingHistory }), 'ETH', MIDNIGHT, MIDNIGHT + 8 * HOUR);
    expect(fundingHistory).toHaveBeenCalledWith({
      coin: 'ETH',
      startTime: MIDNIGHT,
      endTime: MIDNIGHT + 8 * HOUR,
    });
  });

  it('reads an absent response as an empty series, never as a thrown page', async () => {
    const fundingHistory = vi.fn().mockResolvedValue(undefined);
    await expect(fetchFundingHistory(sdkFor({ fundingHistory }), 'BTC', MIDNIGHT)).resolves.toEqual(
      []
    );
  });

  it('says which endpoint is missing when the client does not implement it', async () => {
    await expect(fetchFundingHistory(sdkFor({}), 'BTC', MIDNIGHT)).rejects.toThrow(
      /fundingHistory/
    );
  });
});

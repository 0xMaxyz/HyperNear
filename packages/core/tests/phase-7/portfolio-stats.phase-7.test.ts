import { describe, expect, it } from 'vitest';

import {
  maxDrawdownFraction,
  portfolioPeriodStats,
  rollingVolumeUsd,
  type FeeSummary,
  type PortfolioSnapshot,
} from '../../src/index';

describe('rollingVolumeUsd', () => {
  it('sums the last 14 days of userCross + userAdd', () => {
    const fees: FeeSummary = {
      userCrossRate: '0.00045',
      userAddRate: '0.00015',
      dailyUserVlm: Array.from({ length: 16 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        userCross: i < 2 ? '9999' : '10',
        userAdd: i < 2 ? '1' : '5',
        exchange: '0',
      })),
    };
    // Drops the first two (oldest) days; 14 × (10+5) = 210.
    expect(rollingVolumeUsd(fees, 14)).toBe(210);
  });
});

describe('maxDrawdownFraction', () => {
  it('is the peak-to-trough drop as a fraction of the peak', () => {
    const history: Array<[number, string]> = [
      [1, '100'],
      [2, '120'],
      [3, '90'],
      [4, '110'],
    ];
    // Peak 120 → trough 90 = 0.25.
    expect(maxDrawdownFraction(history)).toBeCloseTo(0.25);
  });

  it('is 0 for a strictly rising series', () => {
    expect(
      maxDrawdownFraction([
        [1, '10'],
        [2, '20'],
        [3, '30'],
      ])
    ).toBe(0);
  });
});

describe('portfolioPeriodStats', () => {
  const snapshot: PortfolioSnapshot = [
    [
      'day',
      {
        accountValueHistory: [
          [1, '100'],
          [2, '80'],
        ],
        pnlHistory: [
          [1, '0'],
          [2, '12.5'],
        ],
        vlm: '500',
      },
    ],
  ];

  it('reads PNL, volume and drawdown for a named period', () => {
    const stats = portfolioPeriodStats(snapshot, 'day');
    expect(stats).toEqual({
      pnlUsd: 12.5,
      volumeUsd: 500,
      drawdownFraction: 0.2,
    });
  });

  it('returns null when the period is missing', () => {
    expect(portfolioPeriodStats(snapshot, 'week')).toBeNull();
  });
});

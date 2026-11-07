/**
 * Combined break-even of a hedge (two or more legs).
 *
 *   PnL(P) = sum_i s_i * size_i * (P - entry_i)      s_i = +1 long, -1 short
 *            - fees already paid
 *            - estimated close fees          = closeFeeRate * P * sum_i size_i
 *            + net funding (received - paid)
 *
 * PnL is linear in P: PnL(P) = slope * P + C, so the break-even is -C / slope.
 * With net size 0 the price terms cancel and the position has a "locked" PnL
 * (only the close-fee term still moves with P, so it is evaluated at the mark).
 */
export interface HedgeLeg {
  side: 'long' | 'short';
  /** Absolute size in base units (> 0). */
  size: number;
  entryPx: number;
  /** Fees already paid on this leg (USD, >= 0). */
  feesPaid: number;
  /** Net funding on this leg: received minus paid (USD, signed). */
  netFunding: number;
}

export interface BreakevenInput {
  legs: HedgeLeg[];
  /** Taker fee rate as a fraction of notional, applied when closing every leg. */
  closeFeeRate: number;
  /** Used only for the locked-PnL case. */
  markPx?: number;
}

export type Breakeven =
  | { kind: 'price'; price: number }
  /** Net size is zero: PnL no longer depends on price (beyond the close fee). */
  | { kind: 'locked'; lockedPnl: number }
  /** Break-even price is <= 0: the hedge is above water at every positive price. */
  | { kind: 'always_profitable' }
  /** Break-even price is <= 0 on a net-short book: it is under water at every positive price. */
  | { kind: 'never_profitable' };

const sign = (l: HedgeLeg) => (l.side === 'long' ? 1 : -1);

function terms(input: BreakevenInput) {
  const { legs, closeFeeRate } = input;
  if (!legs.length) throw new Error('no legs');
  for (const l of legs) if (!(l.size > 0) || !(l.entryPx > 0)) throw new Error('leg size and entryPx must be > 0');
  const netSize = legs.reduce((t, l) => t + sign(l) * l.size, 0);
  const grossSize = legs.reduce((t, l) => t + l.size, 0);
  const constant =
    -legs.reduce((t, l) => t + sign(l) * l.size * l.entryPx, 0) -
    legs.reduce((t, l) => t + l.feesPaid, 0) +
    legs.reduce((t, l) => t + l.netFunding, 0);
  return { netSize, slope: netSize - closeFeeRate * grossSize, constant, grossSize };
}

/** Combined PnL if every leg were closed at price `px`. */
export function combinedPnl(input: BreakevenInput, px: number): number {
  const { slope, constant } = terms(input);
  return slope * px + constant;
}

export function breakeven(input: BreakevenInput): Breakeven {
  const { netSize, slope, constant } = terms(input);
  if (netSize === 0) {
    if (input.markPx === undefined) throw new Error('markPx is required when net size is 0');
    return { kind: 'locked', lockedPnl: slope * input.markPx + constant };
  }
  const price = -constant / slope;
  if (price > 0) return { kind: 'price', price };
  return slope > 0 ? { kind: 'always_profitable' } : { kind: 'never_profitable' };
}

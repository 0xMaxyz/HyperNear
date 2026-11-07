import {
  HL_MAX_ORDER_PRIORITY_P,
  HL_ORDER_PRIORITY_P_PER_BP,
  type HlOrderPriority,
} from './types';

/**
 * The exchange ceiling on a write priority fee, in basis points.
 * `HL_MAX_ORDER_PRIORITY_P / HL_ORDER_PRIORITY_P_PER_BP` = 8.
 */
export const HL_MAX_ORDER_PRIORITY_BPS =
  HL_MAX_ORDER_PRIORITY_P / HL_ORDER_PRIORITY_P_PER_BP;

/** Raised when a caller asks for a priority the exchange would reject. */
export class InvalidOrderPriorityError extends Error {
  readonly code = 'INVALID_ORDER_PRIORITY';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderPriorityError';
  }
}

/**
 * Basis points → Hyperliquid's `grouping: { p }` form (`p / 1e8`), or
 * `undefined` for "no priority fee" — see
 * [spike 16.1.2](../../../../docs/roadmap/spikes/16.1.2-write-latency-capabilities.md).
 *
 * **Zero and `undefined` both mean no fee, and both return `undefined`** — not
 * `{ p: 0 }`. A zero-valued grouping is a *positive* assertion on the wire
 * where absence is what "unprioritized" actually means, and it would displace
 * the `'na'` default for no benefit.
 *
 * Rejects rather than clamps. Clamping an over-cap request would quietly charge
 * a different fee than the caller asked for — and the fee comes out of the
 * user's own staked HYPE, so silently substituting a number is not ours to do.
 */
export function orderPriorityFromBps(bps: number | undefined): HlOrderPriority | undefined {
  if (bps === undefined || bps === 0) return undefined;

  if (!Number.isFinite(bps)) {
    throw new InvalidOrderPriorityError('priority must be a finite number of basis points');
  }
  if (bps < 0) {
    throw new InvalidOrderPriorityError('priority must not be negative');
  }
  if (bps > HL_MAX_ORDER_PRIORITY_BPS) {
    throw new InvalidOrderPriorityError(
      `priority must not exceed ${HL_MAX_ORDER_PRIORITY_BPS} bps (the exchange ceiling); got ${bps}`
    );
  }

  // `p` is an integer count of 1e-8 units. Rounding is safe here only because
  // the range is capped at 80000 — well inside exact float integer territory.
  const p = Math.round(bps * HL_ORDER_PRIORITY_P_PER_BP);
  if (p <= 0) {
    throw new InvalidOrderPriorityError(
      `priority of ${bps} bps rounds to zero — use 0 or omit it to send no priority fee`
    );
  }
  return { p };
}

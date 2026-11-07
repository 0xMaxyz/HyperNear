// Pure liquidation helpers, extracted from the PerpX client/market-data.ts (ef58453) so
// the margin guard can use them without pulling SdkManager/PerpsClient.

/**
 * A position within this percentage of its liquidation price is flagged
 * at-risk (task 7.1.5) so the UI can surface a liquidation warning.
 */
export const LIQUIDATION_WARNING_THRESHOLD_PERCENT = 5;

/**
 * Distance from the live mark price to a position's liquidation price, as a
 * percentage of the mark (task 7.1.5). Recomputed as the mark moves, so an open
 * position's warning tracks the market live. Returns `null` when there is no
 * liquidation price (no risk) or the mark isn't a usable positive number — the
 * caller renders that as "not applicable", never as the alarming 0% that a
 * hardcoded distance implied.
 */
export function liquidationDistancePercent(
  markPx: number,
  liquidationPx: number | null | undefined
): number | null {
  if (
    liquidationPx == null ||
    !Number.isFinite(liquidationPx) ||
    !Number.isFinite(markPx) ||
    markPx <= 0
  ) {
    return null;
  }
  return (Math.abs(markPx - liquidationPx) / markPx) * 100;
}

/**
 * Whether a liquidation distance (from {@link liquidationDistancePercent})
 * crosses the warning threshold. `null` distances (no liquidation risk) are
 * never a warning.
 */
export function isNearLiquidation(
  distancePercent: number | null,
  threshold: number = LIQUIDATION_WARNING_THRESHOLD_PERCENT
): boolean {
  return distancePercent != null && distancePercent <= threshold;
}


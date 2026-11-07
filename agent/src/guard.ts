import { liquidationDistancePercent } from '@perps-platform/core';

/**
 * Margin guard trigger (pure). A leg needs a top-up when EITHER
 *  1. margin floor:  accountValue / maintenanceMargin <= marginFloorMultiple (plan: 2x), OR
 *  2. latency race:  distance to liquidation (share of mark) <= the move price could plausibly make
 *                    while a rebalance is in flight, z * sigma_per_sec * sqrt(latencyP95Sec * k).
 * The rebalance has to survive sign + callback + HL latency, so the second rule is what makes the
 * guard fire early enough for a fast market.
 */
export interface GuardConfig {
  /** p95 of the whole rebalance (NEAR sign + callback + HL). Measured: 12.8 s NEAR-side, 15.8 s end-to-end sign step. */
  latencyP95Sec: number;
  /** Safety multiple on the latency horizon. */
  k: number;
  /** Quantile of the move: how many sigmas count as "plausible". */
  z: number;
  /** Plan: trigger at 2x maintenance margin or less. */
  marginFloorMultiple: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = { latencyP95Sec: 15.8, k: 2, z: 3, marginFloorMultiple: 2 };

export interface GuardLegInput {
  id: string;
  markPx: number;
  /** null when the venue reports no liquidation price. */
  liquidationPx: number | null;
  /** accountValue / maintenanceMarginRequired of this leg (bigger is safer). */
  marginRatio: number;
  /** Annualised volatility of the asset as a fraction (0.6 = 60%). */
  annualVol: number;
}

export type GuardReason = 'margin_floor' | 'latency_move';

export interface GuardLegResult {
  id: string;
  trigger: boolean;
  reasons: GuardReason[];
  /** Distance to liquidation as a fraction of mark (null: no liquidation price). */
  distance: number | null;
  /** Plausible move over the latency horizon as a fraction of price. */
  plausibleMove: number;
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export function plausibleMove(annualVol: number, cfg: GuardConfig): number {
  const sigmaPerSec = annualVol / Math.sqrt(SECONDS_PER_YEAR);
  return cfg.z * sigmaPerSec * Math.sqrt(cfg.latencyP95Sec * cfg.k);
}

export function evaluateLeg(leg: GuardLegInput, cfg: GuardConfig = DEFAULT_GUARD_CONFIG): GuardLegResult {
  const pct = liquidationDistancePercent(leg.markPx, leg.liquidationPx);
  const distance = pct === null ? null : pct / 100;
  const move = plausibleMove(leg.annualVol, cfg);
  const reasons: GuardReason[] = [];
  if (leg.marginRatio <= cfg.marginFloorMultiple) reasons.push('margin_floor');
  if (distance !== null && distance <= move) reasons.push('latency_move');
  return { id: leg.id, trigger: reasons.length > 0, reasons, distance, plausibleMove: move };
}

export function evaluateGuard(legs: GuardLegInput[], cfg: GuardConfig = DEFAULT_GUARD_CONFIG): GuardLegResult[] {
  return legs.map((l) => evaluateLeg(l, cfg));
}

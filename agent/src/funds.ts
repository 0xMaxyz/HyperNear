// Unified accounts: one balance model for everything that reads a leg's money.
//
// Measured on Hyperliquid testnet (agent/scripts/unified-spike*.ts, docs/unified-accounts.md): once a leg is converted to a
// unified account all its USDC sits in the SPOT balance (`hold` is the part reserved as margin), the perp clearinghouse numbers
// stop being the money (withdrawable 0, accountValue about twice the margin), usdSend / spotSend / usdClassTransfer are refused,
// and sendAsset spot -> spot and withdraw still work. Instead of teaching every reader about that, `normalizeLeg` rewrites a
// unified leg's clearinghouse view at the snapshot boundary so the existing readers (guard, hedge margin check, facts, web) see
// what they always read: accountValue = equity, withdrawable = free to use, spotUsdc = 0 (nothing is stuck on spot).
import type { HlClearinghouseState, HlUserAbstractionResult } from '@perps-platform/core';

export type Abstraction = HlUserAbstractionResult | 'unknown';

/** Only `unifiedAccount` is the mode we convert to; portfolio margin has other rules and is left alone. */
export const isUnified = (a: Abstraction): boolean => a === 'unifiedAccount';

/** Accounts we may convert: still in default mode (HL refuses the change from any other, and back is refused too). */
export const canConvert = (a: Abstraction): boolean => a === 'default';

/** HL's spot USDC token id per network: the `token` of a sendAsset (the contract signs only this one). */
export const USDC_TOKEN = {
  testnet: 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
  mainnet: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
} as const;

export interface UnifiedBalance {
  /** spot USDC total: HL's own basis for a unified account's margin ratio (computeUnifiedAccountRatio) */
  spotTotal: number;
  /** the part of it HL holds as margin for open positions and resting orders */
  hold: number;
}

/**
 * The clearinghouse view readers expect. Default accounts pass through unchanged. For a unified account accountValue is the
 * spot USDC total, withdrawable is total minus hold (never negative), and the spot balance is reported as 0 because it is
 * already counted. Positions, maintenance margin and margin used are the exchange's own numbers.
 */
export function normalizeLeg(
  abstraction: Abstraction,
  clearinghouse: HlClearinghouseState,
  spot: UnifiedBalance,
): { clearinghouse: HlClearinghouseState; spotUsdc: number; unified?: UnifiedBalance } {
  if (!isUnified(abstraction)) return { clearinghouse, spotUsdc: spot.spotTotal };
  const equity = spot.spotTotal.toFixed(6);
  const free = Math.max(0, spot.spotTotal - spot.hold).toFixed(6);
  return {
    clearinghouse: {
      ...clearinghouse,
      marginSummary: { ...clearinghouse.marginSummary, accountValue: equity },
      crossMarginSummary: { ...clearinghouse.crossMarginSummary, accountValue: equity },
      withdrawable: free,
    },
    spotUsdc: 0,
    unified: spot,
  };
}

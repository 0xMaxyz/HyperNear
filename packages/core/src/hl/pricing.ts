/**
 * Hyperliquid marketable-limit price rules for `HlClient.placeMarketOrder`
 * (Epic 1.2.1): apply slippage to the mid price, then round to 5 significant
 * figures and to (6 - szDecimals) decimal places for perps. Ported
 * byte-for-byte from the previously-shipped @rabby-wallet/hyperliquid-sdk's
 * `ExchangeClient.getSlippagePx` so `placeMarketOrder` produces identical
 * crossing prices to the legacy `marketOrderOpen` for identical inputs. Pure
 * math, no SDK dependency — safe outside the wrapper's single SDK seam.
 */
export function computeSlippagePrice(
  midPx: string,
  slippage: number,
  isBuy: boolean,
  szDecimals: number
): string {
  const mid = parseFloat(midPx);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`Invalid midPx: must be a positive number, got "${midPx}"`);
  }

  const adjusted = mid * (isBuy ? 1 + slippage : 1 - slippage);
  const sigFigRounded = parseFloat(adjusted.toPrecision(5));
  const maxDecimals = 6 - szDecimals;
  const multiplier = 10 ** maxDecimals;
  const decimalRounded = Math.round(sigFigRounded * multiplier) / multiplier;
  return removeTrailingZeros(decimalRounded.toFixed(maxDecimals));
}

/**
 * Hyperliquid's size grid: an order's size must carry at most `szDecimals`
 * decimal places, or the exchange refuses it with "Order has invalid size."
 *
 * There was no size analogue to {@link computeSlippagePrice} — `szDecimals` was
 * resolved on the order path and used for the PRICE only, while the size string
 * was forwarded untouched from the browser through `PerpsClient`, `HlClient` and
 * the SDK. Closing 100% of a position round-tripped fine because that size came
 * off the exchange already on-grid; closing 25% of `1.55` on a 2-decimal market
 * produced `0.3875`, and ordinary float noise produced `0.30000000000000004`.
 * Both were rejected. Fourth testnet walk, C10.
 *
 * **Rounds DOWN, deliberately.** A size is a claim on a balance or a position:
 * rounding up can exceed the collateral that supports it, or ask to close more
 * than is open — which the exchange then refuses for a second, less obvious
 * reason. `computeMaxOrderSize` in packages/ui floors for the same reason.
 *
 * Sizes are quantized as decimal strings rather than through `Number`, so a
 * size that arrived exact stays exact: `Number('0.1') * 10` is not 1.
 */
export function quantizeSize(size: string, szDecimals: number): string {
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new Error(`Invalid szDecimals: must be a non-negative integer, got ${szDecimals}`);
  }
  const trimmed = size.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid size: must be a decimal string, got "${size}"`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length <= szDecimals) return removeTrailingZeros(trimmed);

  // Truncation IS the round-down for a magnitude; the sign is reapplied after,
  // so a negative size rounds towards zero rather than away from it.
  const truncated = szDecimals === 0 ? whole : `${whole}.${fraction.slice(0, szDecimals)}`;
  const result = removeTrailingZeros(truncated);
  return negative && result !== '0' ? `-${result}` : result;
}

function removeTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  const normalized = value.replace(/\.?0+$/, '');
  return normalized === '-0' || normalized === '' ? '0' : normalized;
}

import type { HlMetaParams, HlMetaResult, HlRequestOptions } from './types';

/**
 * Everything {@link HlAssetIndexResolver} needs from the wrapper — narrower
 * than the full {@link HlClient}/`HlClientLike` surface so tests can supply a
 * bare stub instead of a whole mock client.
 */
export interface HlMetaSource {
  meta(params?: HlMetaParams, opts?: HlRequestOptions): Promise<HlMetaResult>;
}

export interface HlAssetIndexEntry {
  /** Asset index — the position `name` holds in `meta`'s `universe` array. */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: true;
}

/**
 * Centralized asset-index resolution (Epic 1.3.8): the single point in
 * `packages/core` that maps a coin symbol (e.g. `"BTC"`) to its numeric
 * `asset` index and `szDecimals`. Every write endpoint needing them (order
 * placement, cancels, TWAP, leverage, ...) resolves through an instance of
 * this class instead of a hardcoded index — the `universe` array's ordering
 * is the only source of truth, and it shifts as Hyperliquid lists/delists
 * assets, so a hardcoded index silently drifts out of sync.
 *
 * Loads lazily on first {@link resolve} call and caches for the instance's
 * lifetime (one `meta` round-trip per session, not one per order).
 * `SdkManager` scopes one resolver instance per account session
 * (`buildHlClient`), so a fresh session always re-fetches rather than
 * inheriting a stale universe; call {@link load} explicitly to force a
 * refresh (e.g. after a delisting) within a session.
 */
export class HlAssetIndexResolver {
  #entries: Map<string, HlAssetIndexEntry> | null = null;
  #loadPromise: Promise<Map<string, HlAssetIndexEntry>> | null = null;
  readonly #source: HlMetaSource;
  readonly #params?: HlMetaParams;

  constructor(source: HlMetaSource, params?: HlMetaParams) {
    this.#source = source;
    this.#params = params;
  }

  get isLoaded(): boolean {
    return this.#entries !== null;
  }

  /** Fetches `meta` and (re)populates the resolution table. */
  async load(): Promise<void> {
    this.#loadPromise = this.#fetchEntries();
    this.#entries = await this.#loadPromise;
  }

  async #fetchEntries(): Promise<Map<string, HlAssetIndexEntry>> {
    const meta = await this.#source.meta(this.#params);
    const entries = new Map<string, HlAssetIndexEntry>();
    meta.universe.forEach((assetMeta, index) => {
      entries.set(assetMeta.name, {
        asset: index,
        szDecimals: assetMeta.szDecimals,
        maxLeverage: assetMeta.maxLeverage,
        isDelisted: assetMeta.isDelisted,
      });
    });
    return entries;
  }

  /**
   * Resolves a coin symbol to its asset index + szDecimals, loading `meta` on
   * first use. Throws for a symbol absent from `meta`'s `universe`.
   */
  async resolve(coin: string): Promise<HlAssetIndexEntry> {
    if (!this.#entries) {
      if (!this.#loadPromise) {
        this.#loadPromise = this.#fetchEntries();
      }
      this.#entries = await this.#loadPromise;
    }
    const entry = this.#entries.get(coin);
    if (!entry) {
      throw new Error(`Unknown asset: ${coin}`);
    }
    return entry;
  }

  /** Convenience over {@link resolve} for callers that only need the numeric index. */
  async resolveAssetIndex(coin: string): Promise<number> {
    return (await this.resolve(coin)).asset;
  }
}

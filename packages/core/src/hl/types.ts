import type { HexAddress } from '../adapters/types';

export type HlHex = `0x${string}`;

export type HlNetwork = 'mainnet' | 'testnet';

export const HL_API_URLS: Record<HlNetwork, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
};

/**
 * The EIP-712 domain chain id user-signed actions are signed under, per network.
 *
 * Hyperliquid imposes no requirement here: the wire action carries
 * `signatureChainId`, the exchange rebuilds the domain from THAT value and
 * recovers against it, and `hyperliquidChain` ("Mainnet"/"Testnet") is what
 * selects the network. Any chain id verifies.
 *
 * It was one constant, `0x66eee` (421614, Arbitrum Sepolia), on both networks —
 * copied from the official Python SDK, whose own signer is a bare private key
 * that never consults a chain. A CONNECTED WALLET does: MetaMask (and others)
 * refuse `eth_signTypedData_v4` whose `domain.chainId` is not the chain they are
 * on, with `Provided chainId "421614" must match the active chainId "1"`. So a
 * mainnet deployment could not `approveAgent`, and a wallet user's first order
 * or leverage change died on the approval that precedes it.
 *
 * The value is therefore the deployment's SETTLEMENT chain, which is the chain
 * every other wallet rail here (deposit, withdrawal, USDC permit, CCTP) already
 * needs — so `WagmiWalletAdapter` can switch the wallet onto it before signing
 * and the wallet never ping-pongs between two chains. Ethereum would have done
 * equally well as a signature domain and was rejected for that reason alone.
 *
 * Not covered, and deliberately: an L1 (phantom-agent) payload has domain chain
 * id 1337 (`L1_ACTION_DOMAIN_CHAIN_ID`), which no wallet is ever on. A wallet is
 * only ever handed one when the session declares `canSelfSign` — i.e. before it
 * has minted an agent — and the trading path always mints one first ([#928],
 * [#932]). A wallet asked to self-sign L1 still fails, as it always has.
 */
export const HL_SIGNATURE_CHAIN_IDS: Record<HlNetwork, HlHex> = {
  /** Arbitrum One (42161). */
  mainnet: '0xa4b1',
  /** Arbitrum Sepolia (421614) — where Hyperliquid testnet settles. */
  testnet: '0x66eee',
};

export interface HlEip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: HlHex;
}

export interface HlTypedDataField {
  name: string;
  type: string;
}

/**
 * The complete EIP-712 payload a signer receives: everything an
 * `eth_signTypedData_v4`-style signer needs, and nothing else — no key
 * material, no SDK objects. `types` includes the `EIP712Domain` entry.
 */
export interface HlSignPayload {
  domain: HlEip712Domain;
  types: Record<string, readonly HlTypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Resolves to the 65-byte (r || s || v) hex signature over the payload. */
export type HlSignFn = (payload: HlSignPayload) => Promise<HlHex>;

/**
 * A pluggable async signer for one tier. Implementations sign wherever the
 * key lives — a passkey signer inside its iframe, apps/api's session facade
 * over the network, a browser wallet — the wrapper only ever awaits the
 * callback and never sees key material.
 */
export interface HlAsyncSigner {
  readonly address: HexAddress;
  readonly sign: HlSignFn;
}

export type HlApiEndpoint = 'info' | 'exchange' | 'explorer';

/**
 * The transport-injection seam: packages/hl-egress (Phase 2 Epic 2.4) slots
 * underneath the wrapper by implementing this. Omitted from the config, the
 * wrapper falls back to direct HTTPS against the configured network.
 */
export interface HlTransport {
  request(endpoint: HlApiEndpoint, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface HlClientConfig {
  network: HlNetwork;
  /** Signs user-signed (EIP-712) actions: transfers, approvals, leverage. */
  masterSigner?: HlAsyncSigner;
  /** Signs L1 actions: orders, cancels. Same signer as master when self-signing. */
  agentSigner?: HlAsyncSigner;
  transport?: HlTransport;
  /** Base-URL override for the default transport; ignored when `transport` is injected. */
  apiUrl?: string;
  /** Request timeout in ms for the default transport. */
  timeout?: number;
  /** Override the domain chain id for user-signed actions; defaults to
   * {@link HL_SIGNATURE_CHAIN_IDS} for this client's network. */
  signatureChainId?: HlHex;
  /** Nonce override, e.g. Phase 2's per-account action queue or a fixed test nonce. */
  nonceSource?: (address: HexAddress) => number | Promise<number>;
}

export interface HlRequestOptions {
  signal?: AbortSignal;
}

export interface HlL1RequestOptions extends HlRequestOptions {
  vaultAddress?: HexAddress;
  expiresAfter?: number;
}

export interface HlMetaParams {
  /** DEX name; omit or empty string for the main perp DEX. */
  dex?: string;
}

/**
 * A single perp universe entry from the `meta` info endpoint — the source of
 * truth {@link HlAssetIndexResolver} (Epic 1.3.8, ./assetIndex.ts) resolves a
 * coin symbol against. `name`'s position in the `universe` array *is* its
 * numeric asset index; Hyperliquid does not return the index explicitly.
 */
export interface HlMetaUniverseAsset {
  szDecimals: number;
  name: string;
  maxLeverage: number;
  marginTableId: number;
  /** @deprecated use `marginMode` instead. */
  onlyIsolated?: true;
  isDelisted?: true;
  marginMode?: 'strictIsolated' | 'noCross';
}

export interface HlMetaResult {
  universe: HlMetaUniverseAsset[];
}

export interface HlLimitOrderType {
  limit: { tif: 'Gtc' | 'Ioc' | 'Alo' | 'FrontendMarket' };
}

export interface HlTriggerOrderType {
  trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' };
}

export interface HlOrderInput {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: HlLimitOrderType | HlTriggerOrderType;
  c?: HlHex;
}

/**
 * A write **priority fee** — Hyperliquid's paid mempool prioritization
 * ([spike 16.1.2](../../../../docs/roadmap/spikes/16.1.2-write-latency-capabilities.md)).
 *
 * **It is charged to the user, not to us**: the rate comes out of the signing
 * account's *undelegated HYPE staking balance*, as a fraction of filled
 * notional (IOC) or resting notional (ALO). So it can never be a deployment
 * default — an account with no staked HYPE cannot pay it, and one that can
 * did not agree to. It is always an explicit per-order choice by the caller.
 */
export interface HlOrderPriority {
  /** Priority rate as a fraction `p / 1e8`. Max {@link HL_MAX_ORDER_PRIORITY_P}. */
  p: number;
}

/** The largest `p` the exchange accepts: 80000 → 8 bps. */
export const HL_MAX_ORDER_PRIORITY_P = 80_000;

/** One basis point, in `p` units (`p` is a fraction of 1e8). */
export const HL_ORDER_PRIORITY_P_PER_BP = 10_000;

/**
 * How the order action groups. **A union, which is the whole point**: the
 * priority fee occupies the same wire field as the TP/SL groupings, so an
 * order physically cannot be both prioritized and TP/SL-grouped. Modelling it
 * as a union makes that a compile error rather than a runtime rejection.
 */
export type HlOrderGrouping = 'na' | 'normalTpsl' | 'positionTpsl' | HlOrderPriority;

export interface HlOrderBuilder {
  /** Builder address receiving the fee. */
  address: HexAddress;
  /**
   * Builder fee in tenths of a basis point: **1 = 0.001%**. Max 100 for perps
   * (0.1%), 1000 for spot (1%).
   *
   * This said `1 = 0.0001%` — off by 10× — while the two maxima on the same
   * line only work at 0.001%, and while `PerpsClient.ensureApprovals` derives
   * the approved ceiling as `fee / 1000` %. Left as it was, the one place
   * someone reads before configuring a real fee was the one place that
   * disagreed.
   */
  fee: number;
}

export interface HlOrderParams {
  orders: HlOrderInput[];
  grouping?: HlOrderGrouping;
  builder?: HlOrderBuilder;
}

/** Order ID (numeric) or Client Order ID (hex `c` value) identifying the order to modify. */
export type HlOidOrCloid = number | HlHex;

export interface HlModifyParams {
  oid: HlOidOrCloid;
  /** Replacement order — same shape as a fresh order, not a partial patch. */
  order: HlOrderInput;
}

export interface HlModifyEntry {
  oid: HlOidOrCloid;
  order: HlOrderInput;
}

export interface HlBatchModifyParams {
  modifies: HlModifyEntry[];
}

/**
 * Default slippage for {@link HlMarketOrderParams} when the caller omits
 * one — ported from the previously-shipped @rabby-wallet/hyperliquid-sdk's
 * own internal default (`SLIPPAGE = 0.08`), so `placeMarketOrder` matches
 * legacy behavior when callers rely on the implicit default rather than
 * passing one explicitly. Distinct from `DEFAULT_MARKET_SLIPPAGE` (0.05) in
 * packages/core/src/constants, which is a UI-facing preferences default, not
 * the exchange-client's own fallback.
 */
export const HL_DEFAULT_MARKET_SLIPPAGE = 0.08;

export interface HlMarketOrderParams {
  /** Resolved asset index — see {@link HlAssetIndexResolver} (Epic 1.3.8, ./assetIndex.ts), the centralized `meta`-backed resolver every caller resolves this from. Never hardcode it. */
  asset: number;
  isBuy: boolean;
  /** Size in base currency units. */
  size: string;
  /** Mid price the slippage-adjusted crossing price is computed from. */
  midPx: string;
  /** Fraction, e.g. 0.08 for 8%. Defaults to {@link HL_DEFAULT_MARKET_SLIPPAGE}. */
  slippage?: number;
  reduceOnly?: boolean;
  /** Size decimals for the asset (from `meta`), used for price rounding. */
  szDecimals: number;
  builder?: HlOrderBuilder;
  /** Optional paid mempool priority — see {@link HlOrderPriority}. */
  priority?: HlOrderPriority;
  c?: HlHex;
}

/** TIF variants accepted by {@link HlLimitOrderParams} — `FrontendMarket` is `placeMarketOrder`-only. */
export type HlLimitOrderTif = 'Gtc' | 'Ioc' | 'Alo';

export interface HlLimitOrderParams {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  isBuy: boolean;
  /** Limit price. */
  price: string;
  /** Size in base currency units. */
  size: string;
  /**
   * Time-in-force: `Gtc` (Good-Til-Cancelled, rests until filled/canceled),
   * `Ioc` (Immediate-Or-Cancel, fills what it can then cancels the rest),
   * `Alo` (Add-Liquidity-Only/post-only, rejected if it would cross the book).
   */
  tif: HlLimitOrderTif;
  reduceOnly?: boolean;
  builder?: HlOrderBuilder;
  /** Optional paid mempool priority — see {@link HlOrderPriority}. */
  priority?: HlOrderPriority;
  c?: HlHex;
}

/** Take-profit (`tp`) vs stop-loss (`sl`) trigger — see {@link HlTriggerOrderParams}. */
export type HlTpSl = 'tp' | 'sl';

export interface HlTriggerOrderParams {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  isBuy: boolean;
  /**
   * The order's limit price once triggered. For a `isMarket: true` (market)
   * trigger this is the aggressive price the resulting market order crosses at;
   * for a `isMarket: false` (limit) trigger it's the resting limit price.
   */
  price: string;
  /** Size in base currency units. */
  size: string;
  /** Mark price at which the trigger fires. */
  triggerPx: string;
  /**
   * `tp` (take-profit: fires when the mark price moves favorably to
   * `triggerPx`) or `sl` (stop-loss: fires when it moves adversely).
   */
  tpsl: HlTpSl;
  /**
   * `true` → execute as a market order when triggered; `false` → rest as a
   * limit order at {@link price} once triggered.
   */
  isMarket: boolean;
  reduceOnly?: boolean;
  /**
   * Order grouping — `na` (standalone trigger order, the default) or
   * `normalTpsl`/`positionTpsl` when attaching the trigger to a position.
   */
  grouping?: HlOrderGrouping;
  builder?: HlOrderBuilder;
  c?: HlHex;
}

export interface HlTwapOrderParams {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  isBuy: boolean;
  /** Size in base currency units. */
  size: string;
  reduceOnly?: boolean;
  /** TWAP duration in minutes; Hyperliquid enforces 5-1440. */
  durationMinutes: number;
  /** Randomize child-order timing within each slice. Defaults to `true`. */
  randomize?: boolean;
}

/** Per Hyperliquid's `twapOrder` response: `running` while active, `error` if rejected outright. */
export interface HlTwapOrderStatus {
  running?: { twapId: number };
  error?: string;
}

export interface HlTwapOrderResult {
  status: 'ok';
  response: { type: 'twapOrder'; data: { status: HlTwapOrderStatus } };
}

export interface HlTwapCancelParams {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  /** TWAP id, from {@link HlTwapOrderStatus.running}'s `twapId` — not an order id. */
  twapId: number;
}

/** `"success"` or `{ error }`, like {@link HlCancelStatus} but for a single TWAP. */
export type HlTwapCancelStatus = 'success' | { error: string };

export interface HlTwapCancelResult {
  status: 'ok';
  response: { type: 'twapCancel'; data: { status: HlTwapCancelStatus } };
}

export interface HlCancelInput {
  /** Asset index. */
  a: number;
  /** Order ID to cancel. */
  o: number;
}

/**
 * Ask Hyperliquid to prioritize this cancel in the mempool — the `f` flag on
 * the `cancel` action ([spike 16.1.2](../../../../docs/roadmap/spikes/16.1.2-write-latency-capabilities.md)).
 *
 * **Opt-in, never inferred, and never sent as `false`.** Three facts force
 * that shape:
 *
 *  - Hyperliquid **rejects** a fast cancel that refers to a trigger order. A
 *    wrong guess does not merely lose the optimization, it fails the cancel —
 *    which on a stop-loss is the worst possible moment to fail. So the flag is
 *    only ever set when a caller has positively said this is not a trigger
 *    (`OpenOrder.isTrigger` is on every listed order, so callers know).
 *  - The SDK types it as a literal `true` (`f: v.OptionalSchema<v.LiteralSchema<true>>`),
 *    so `f: false` fails schema validation before signing. Absence is the only
 *    way to say "not fast".
 *  - It rides on the **action**, not on each entry in `cancels[]` — a batch is
 *    all-fast or none, so a batch containing any trigger order must not set it.
 *
 * The flag is inert upstream today ("currently `fast` has no other effect");
 * it becomes a mempool priority the day the announced network upgrade lands.
 */
export interface HlFastCancelFlag {
  fast?: boolean;
}

export interface HlBatchCancelParams extends HlFastCancelFlag {
  cancels: HlCancelInput[];
}

export interface HlCancelOrderParams extends HlFastCancelFlag {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  /** Order ID to cancel. */
  oid: number;
}

/**
 * Per-cancel outcome in a {@link HlCancelResult}'s `statuses` array —
 * `"success"` or `{ error }`. Batch cancel is partial-failure-tolerant: one
 * entry failing (e.g. already filled) doesn't fail the rest of the batch.
 */
export type HlCancelStatus = 'success' | { error: string };

export interface HlCancelResult {
  status: 'ok';
  response: { type: 'cancel'; data: { statuses: HlCancelStatus[] } };
}

export interface HlOrderStatus {
  resting?: { oid: number; cloid?: HlHex };
  filled?: { oid: number; totalSz: string; avgPx: string; cloid?: HlHex };
  error?: string;
}

export interface HlOrderResult {
  status: 'ok';
  response: { type: 'order'; data: { statuses: HlOrderStatus[] } };
}

export interface HlUsdSendParams {
  destination: HexAddress;
  amount: string;
}

export interface HlSuccessResult {
  status: 'ok';
  response: { type: string };
}

export interface HlWithdrawParams {
  destination: HexAddress;
  amount: string;
}

export interface HlSendAssetParams {
  destination: HexAddress;
  /** Source DEX ("" for the default USDC perp DEX, "spot" for spot). */
  sourceDex: string;
  /** Destination DEX ("" for the default USDC perp DEX, "spot" for spot). */
  destinationDex: string;
  token: string;
  amount: string;
  /** Source sub-account address ("" for the main account). */
  fromSubAccount?: HexAddress | '';
}

/**
 * Withdraw from HyperCore straight to an external EVM chain over Circle CCTP
 * ([#811], ADR 7.9 task 8). `CoreDepositWallet.coreReceiveWithData` burns
 * through CCTP v2, so one master-signed action pays real Circle USDC on
 * Arbitrum — no Bridge2, no 1 USDC fee, and no gas from the user, which makes
 * it the only Arbitrum exit a passkey-only session can complete.
 */
export interface HlSendToEvmWithDataParams {
  /** Token symbol as HyperCore names it — `USDC`. */
  token: string;
  amount: string;
  /**
   * Which HyperCore balance to draw from: `"spot"`, or `""` for the default
   * USDC perp DEX. Follows the account's abstraction mode — never a constant.
   */
  sourceDex: string;
  /** The recipient on the destination chain, in {@link addressEncoding}. */
  destinationRecipient: string;
  addressEncoding: 'hex' | 'base58';
  /**
   * ⚠️ **Circle's CCTP domain id, NOT an EVM chain id.** Arbitrum is `3` on
   * both networks (Ethereum `0`, Base `6`); HyperEVM is `19`. The pinned SDK's
   * own doc example passes `42161` and is wrong — a decoded delivery of this
   * action carries `destinationDomain 3`. See `cctp-withdraw.ts`.
   */
  destinationChainId: number;
  /** Gas limit for the destination-chain execution. */
  gasLimit: number;
  /**
   * CCTP hook data. `"0x"` makes `CoreDepositWallet` attach its own
   * `cctp-forward` hook, which is what gets the payout delivered automatically
   * (and is what the flat delivery fee buys).
   */
  data: string;
}

/**
 * Spot token transfer to another address (task 7.9 / [#743]). Sending to
 * HyperCore's system address `0x2000…0000` is what pays a balance out onto
 * HyperEVM — the split-account half of the withdrawal rail, since a unified
 * account refuses this action outright.
 */
export interface HlSpotSendParams {
  destination: HexAddress;
  /** `NAME:tokenId`, read from `spotMeta` rather than hardcoded. */
  token: string;
  amount: string;
}

/**
 * Move USDC across the perp/spot class boundary (task 7.9 / [#743]). Refused on
 * a unified account, which has no boundary to cross.
 */
export interface HlUsdClassTransferParams {
  amount: string;
  /** `true` moves spot → perp; `false` moves perp → spot. */
  toPerp: boolean;
}

export interface HlSetReferrerParams {
  code: string;
}

export interface HlApproveAgentParams {
  agentAddress: HexAddress;
  /** Empty/omitted for an unnamed agent. */
  agentName?: string;
  /**
   * Epoch ms the approval should lapse at (Phase 16 Epic B). There is no
   * `validUntil` field on the wire: {@link HlClient.approveAgent} encodes this
   * as the name suffix ` valid_until <ms>` that the SDK strips before its
   * 16-char name check (`hl/agent-name.ts` carries the citation).
   *
   * Ignored without an `agentName` — an unnamed agent has no name to carry it.
   * It is a REQUEST: whether Hyperliquid honours the instant or clamps it is
   * unmeasured until spike 16.1.1(d), so nothing may read this back as the
   * agent's resulting expiry.
   */
  validUntil?: number;
}

export interface HlApproveBuilderFeeParams {
  /** e.g. "0.01%". */
  maxFeeRate: string;
  builder: HexAddress;
}

export interface HlScheduleCancelParams {
  /** ms since epoch, at least 5 s in the future; omit to remove the scheduled cancel. */
  time?: number;
}

export interface HlUpdateLeverageParams {
  asset: number;
  isCross: boolean;
  leverage: number;
}

export interface HlUpdateIsolatedMarginParams {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  /** Position side: `true` for long, `false` for short. */
  isBuy: boolean;
  /** Isolated-margin amount to adjust (in 1e6 format, e.g. 1000000 for 1 USDC). */
  ntli: number;
}

export interface HlCreateSubAccountParams {
  /** Sub-account name, 1-16 characters. */
  name: string;
}

export interface HlCreateSubAccountResult {
  status: 'ok';
  response: { type: 'createSubAccount'; data: HexAddress };
}

export interface HlSubAccountTransferParams {
  subAccountUser: HexAddress;
  /** `true` deposits from the main account into the sub-account; `false` withdraws. */
  isDeposit: boolean;
  /** USD amount to transfer, in 1e6 format (e.g. 1000000 for 1 USDC) — same convention as {@link HlUpdateIsolatedMarginParams.ntli}. */
  usd: number;
}

export interface HlSubAccountSpotTransferParams {
  subAccountUser: HexAddress;
  /** `true` deposits from the main account into the sub-account; `false` withdraws. */
  isDeposit: boolean;
  token: string;
  /** Decimal amount as a string (not wei-scaled) — same convention as {@link HlSendAssetParams.amount}. */
  amount: string;
}

export interface HlUserFillsParams {
  user: HexAddress;
  /** If true, partial fills are aggregated when a crossing order fills multiple resting orders. */
  aggregateByTime?: boolean;
}

/** A single user trade fill, as returned by the `userFills` info endpoint. */
export interface HlUserFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: HlHex;
  oid: number;
  crossed: boolean;
  fee: string;
  /** Optional fee charged by the UI builder. */
  builderFee?: string;
  tid: number;
  feeToken: string;
  twapId: number | null;
  cloid?: HlHex;
  liquidation?: {
    liquidatedUser: HexAddress;
    markPx: string;
    method: 'market' | 'backstop';
  };
}

export type HlUserFillsResult = HlUserFill[];

export interface HlUserPortfolioParams {
  user: HexAddress;
}

/** Period keys Hyperliquid returns from the `portfolio` info endpoint. */
export type HlPortfolioPeriod =
  | 'day'
  | 'week'
  | 'month'
  | 'allTime'
  | 'perpDay'
  | 'perpWeek'
  | 'perpMonth'
  | 'perpAllTime';

export interface HlPortfolioPeriodStats {
  accountValueHistory: Array<[timeMs: number, value: string]>;
  pnlHistory: Array<[timeMs: number, value: string]>;
  vlm: string;
}

/** Snapshot from `type: "portfolio"` — one entry per period. */
export type HlUserPortfolioResult = Array<[HlPortfolioPeriod, HlPortfolioPeriodStats]>;

export interface HlUserFeesParams {
  user: HexAddress;
}

export interface HlDailyUserVolume {
  date: string;
  userCross: string;
  userAdd: string;
  exchange: string;
}

/** Snapshot from `type: "userFees"` — fee rates and daily volume. */
export interface HlUserFeesResult {
  dailyUserVlm: HlDailyUserVolume[];
  userCrossRate: string;
  userAddRate: string;
  userSpotCrossRate?: string;
  userSpotAddRate?: string;
}

export interface HlHistoricalOrdersParams {
  user: HexAddress;
}

/**
 * Per-coin inputs {@link HlCloseAllPositionsParams} needs to build a
 * reduce-only close order for an open position — the same externally-resolved
 * values {@link HlMarketOrderParams} needs (asset index, szDecimals) plus the
 * mid price to compute the slippage-adjusted crossing price from.
 */
export interface HlCloseAllPositionsAssetInfo {
  /** Resolved asset index (see {@link HlMarketOrderParams.asset}). */
  asset: number;
  /** Size decimals for the asset (from `meta`), used for price rounding. */
  szDecimals: number;
  /** Current mid price, used to compute the slippage-adjusted crossing price. */
  midPx: string;
}

export interface HlCloseAllPositionsParams {
  /** Address whose open positions are read via `clearinghouseState`. */
  user: HexAddress;
  /**
   * Per-coin asset info for every coin the account might hold a position in —
   * {@link HlClient.closeAllPositions} looks up each open position's order
   * inputs from this map by `coin`. A position for a coin missing from the
   * map throws.
   */
  assets: Record<string, HlCloseAllPositionsAssetInfo>;
  /** Fraction, e.g. 0.08 for 8%. Defaults to {@link HL_DEFAULT_MARKET_SLIPPAGE}. */
  slippage?: number;
  builder?: HlOrderBuilder;
}

export interface HlCloseAllPositionsResult {
  /** Coin symbols for which a reduce-only close order was sent, in wire order. */
  closedCoins: string[];
  /**
   * The underlying batched `order` result. Absent when there were no open
   * positions to close — a no-op, so no exchange request is sent.
   */
  order?: HlOrderResult;
}

/**
 * Order-processing status returned by the `historicalOrders` info endpoint —
 * mirrors the exchange's full order-lifecycle taxonomy (open/filled/canceled
 * plus every rejection/cancellation reason).
 */
export type HlOrderProcessingStatus =
  | 'open'
  | 'filled'
  | 'canceled'
  | 'triggered'
  | 'rejected'
  | 'marginCanceled'
  | 'vaultWithdrawalCanceled'
  | 'openInterestCapCanceled'
  | 'selfTradeCanceled'
  | 'reduceOnlyCanceled'
  | 'siblingFilledCanceled'
  | 'delistedCanceled'
  | 'liquidatedCanceled'
  | 'scheduledCancel'
  | 'tickRejected'
  | 'minTradeNtlRejected'
  | 'perpMarginRejected'
  | 'reduceOnlyRejected'
  | 'badAloPxRejected'
  | 'iocCancelRejected'
  | 'badTriggerPxRejected'
  | 'marketOrderNoLiquidityRejected'
  | 'positionIncreaseAtOpenInterestCapRejected'
  | 'positionFlipAtOpenInterestCapRejected'
  | 'tooAggressiveAtOpenInterestCapRejected'
  | 'openInterestIncreaseRejected'
  | 'insufficientSpotBalanceRejected'
  | 'oracleRejected'
  | 'perpMaxPositionRejected';

/** Open order with additional display info, as returned by `historicalOrders`. */
export interface HlFrontendOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  triggerCondition: string;
  isTrigger: boolean;
  triggerPx: string;
  children: HlFrontendOrder[];
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType:
    | 'Market'
    | 'Limit'
    | 'Stop Market'
    | 'Stop Limit'
    | 'Take Profit Market'
    | 'Take Profit Limit';
  tif: 'Gtc' | 'Ioc' | 'Alo' | 'FrontendMarket' | 'LiquidationMarket' | null;
  cloid: HlHex | null;
}

/** A single entry in the `historicalOrders` response: a frontend order plus its current status. */
export interface HlHistoricalOrder {
  order: HlFrontendOrder;
  status: HlOrderProcessingStatus;
  /** Timestamp when the status was last updated (in ms since epoch). */
  statusTimestamp: number;
}

export type HlHistoricalOrdersResult = HlHistoricalOrder[];

export interface HlOpenOrdersParams {
  user: HexAddress;
}

export type HlOpenOrdersResult = HlFrontendOrder[];

export interface HlUserFundingParams {
  user: HexAddress;
  /** Start time in milliseconds since epoch. */
  startTime?: number;
  /** End time in milliseconds since epoch. */
  endTime?: number;
}

/** A single user funding ledger update from the `userFunding` info endpoint. */
export interface HlUserFunding {
  /** Timestamp of the update (in ms since epoch). */
  time: number;
  /** L1 transaction hash. */
  hash: HlHex;
  /** Funding update details. */
  delta: {
    /** Update type. */
    type: 'funding';
    /** Asset symbol (e.g., BTC). */
    coin: string;
    /** Amount transferred in USDC. */
    usdc: string;
    /** Signed position size. */
    szi: string;
    /** Applied funding rate. */
    fundingRate: string;
    /** Number of samples (or null). */
    nSamples: number | null;
  };
}

export type HlUserFundingResult = HlUserFunding[];

export interface HlLedgerUpdatesParams {
  user: HexAddress;
  /** Start time in milliseconds since epoch. */
  startTime?: number;
  /** End time in milliseconds since epoch. */
  endTime?: number;
}

/**
 * One entry from `userNonFundingLedgerUpdates` — every movement of value into
 * or out of a HyperCore account that is not a funding payment: bridge deposits
 * and withdrawals, spot sends, internal transfers, vault flows, liquidations.
 *
 * The delta is typed as **the variants this codebase classifies, plus an open
 * catch-all**, on purpose. The SDK enumerates around twenty and that list grows
 * with Hyperliquid; hand-copying it here would silently drift, and a variant we
 * failed to anticipate must render as a plain row rather than break the parse
 * or vanish. A hole in a money history is worse than an ugly line in one.
 */
export interface HlLedgerUpdate {
  time: number;
  hash: HlHex;
  delta: HlLedgerDelta;
}

export type HlLedgerDelta =
  | { type: 'deposit'; usdc: string }
  | { type: 'withdraw'; usdc: string; nonce?: number; fee?: string }
  | {
      type: 'send' | 'spotTransfer';
      user: string;
      destination: string;
      token?: string;
      amount?: string;
      usdcValue?: string;
      fee?: string;
      nativeTokenFee?: string;
    }
  | { type: 'internalTransfer'; user: string; destination: string; usdc: string; fee?: string }
  | { type: 'accountClassTransfer'; usdc: string; toPerp?: boolean }
  | { type: string; [key: string]: unknown };

export type HlLedgerUpdatesResult = HlLedgerUpdate[];

export interface HlTwapHistoryParams {
  user: HexAddress;
}

/** TWAP order state at creation, as returned by the `twapHistory` info endpoint. */
export interface HlTwapState {
  coin: string;
  executedNtl: string;
  executedSz: string;
  /** Duration in minutes. */
  minutes: number;
  randomize: boolean;
  reduceOnly: boolean;
  side: 'B' | 'A';
  sz: string;
  /** Start time of the TWAP order (in ms since epoch). */
  timestamp: number;
  user: HexAddress;
}

/** Current lifecycle status of a TWAP order, per the `twapHistory` info endpoint. */
export type HlTwapHistoryStatus =
  | { status: 'finished' | 'activated' | 'terminated' }
  | { status: 'error'; description: string };

/** A single entry in the `twapHistory` response: the TWAP's state at creation plus its current status. */
export interface HlTwapHistoryEntry {
  /** Creation time of the history record (in seconds since epoch). */
  time: number;
  state: HlTwapState;
  status: HlTwapHistoryStatus;
  twapId?: number;
}

export type HlTwapHistoryResult = HlTwapHistoryEntry[];

export interface HlFundingHistoryParams {
  /** Asset symbol (e.g., BTC). */
  coin: string;
  /** Start time in milliseconds since epoch. */
  startTime: number;
  /** End time in milliseconds since epoch. */
  endTime?: number;
}

/** A single funding history record from the `fundingHistory` info endpoint. */
export interface HlFundingHistoryRecord {
  /** Asset symbol (e.g., BTC). */
  coin: string;
  /** Funding rate. */
  fundingRate: string;
  /** Premium price. */
  premium: string;
  /** Funding record timestamp (in ms since epoch). */
  time: number;
}

export type HlFundingHistoryResult = HlFundingHistoryRecord[];

export interface HlReferralStatusParams {
  user: HexAddress;
}

/** A single referral reward record from reward history. */
export interface HlReferralRewardRecord {
  /** Amount of earned rewards. */
  earned: string;
  /** Traded volume at the time of reward. */
  vlm: string;
  /** Traded volume via referrals. */
  referralVlm: string;
  /** Timestamp when the reward was earned (in ms since epoch). */
  time: number;
}

/** A single token reward state for referrals. */
export interface HlTokenRewardState {
  /** Cumulative traded volume. */
  cumVlm: string;
  /** Rewards earned but not yet claimed. */
  unclaimedRewards: string;
  /** Rewards that have been claimed. */
  claimedRewards: string;
  /** Builder reward amount. */
  builderRewards: string;
}

/** Details about a single referred user (when viewing as a referrer). */
export interface HlReferralState {
  /** Cumulative traded volume. */
  cumVlm: string;
  /** Total fees rewarded to the referred user since referral. */
  cumRewardedFeesSinceReferred: string;
  /** Total fees rewarded to the referrer from referred trades. */
  cumFeesRewardedToReferrer: string;
  /** Timestamp when the referred user joined (in ms since epoch). */
  timeJoined: number;
  /** Address of the referred user. */
  user: HexAddress;
  /** Mapping of token IDs to referral reward states. */
  tokenToState: Array<[number, {
    cumVlm: string;
    cumRewardedFeesSinceReferred: string;
    cumFeesRewardedToReferrer: string;
  }]>;
}

/** Referrer state details. */
export type HlReferrerState =
  | {
      /** Referrer is ready to receive rewards. */
      stage: 'ready';
      /** Referral program details. */
      data: {
        /** Assigned referral code. */
        code: string;
        /** Total number of referrals. */
        nReferrals: number;
        /** Summary of each referral state. */
        referralStates: HlReferralState[];
      };
    }
  | {
      /** Referrer needs to create a referral code. */
      stage: 'needToCreateCode';
    }
  | {
      /** Referrer must complete a trade before earning rewards. */
      stage: 'needToTrade';
      /** Required trading volume details for activation. */
      data: {
        /** Required trading volume. */
        required: string;
      };
    };

/** Referral status information returned by the `referral` info endpoint. */
export interface HlReferralStatus {
  /** Referrer details (who referred this user, if any). */
  referredBy: {
    /** Referrer address. */
    referrer: HexAddress;
    /** Referral code used. */
    code: string;
  } | null;
  /** Cumulative traded volume. */
  cumVlm: string;
  /** Rewards earned but not yet claimed. */
  unclaimedRewards: string;
  /** Rewards that have been claimed. */
  claimedRewards: string;
  /** Builder reward amount. */
  builderRewards: string;
  /** Current state of the referrer (if this user is a referrer). */
  referrerState: HlReferrerState;
  /** History of referral rewards. */
  rewardHistory: HlReferralRewardRecord[];
  /** Mapping of token IDs to referral reward states. */
  tokenToState: Array<[number, HlTokenRewardState]>;
}

export type HlReferralStatusResult = HlReferralStatus;

export interface HlUserRoleParams {
  user: HexAddress;
}

/** User role information returned by the `userRole` info endpoint. */
export type HlUserRole =
  | { role: 'missing' | 'user' | 'vault' }
  | { role: 'agent'; data: { user: HexAddress } }
  | { role: 'subAccount'; data: { master: HexAddress } };

export type HlUserRoleResult = HlUserRole;

export interface HlSubAccountsParams {
  user: HexAddress;
}

/** Cumulative funding paid/received for a position, as embedded in {@link HlAssetPosition}. */
export interface HlCumFunding {
  allTime: string;
  sinceOpen: string;
  sinceChange: string;
}

/** Leverage details for a position — `isolated` carries the USD amount used; `cross` does not. */
export type HlPositionLeverage =
  | { type: 'isolated'; value: number; rawUsd: string }
  | { type: 'cross'; value: number };

export interface HlAssetPosition {
  coin: string;
  szi: string;
  leverage: HlPositionLeverage;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
  maxLeverage: number;
  cumFunding: HlCumFunding;
}

export interface HlMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

/** Perpetual account summary, as embedded in {@link HlSubAccountEntry.clearinghouseState}. */
export interface HlClearinghouseState {
  marginSummary: HlMarginSummary;
  crossMarginSummary: HlMarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: Array<{ type: 'oneWay'; position: HlAssetPosition }>;
  time: number;
}

export interface HlSpotTokenBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
  /**
   * The slice of `hold` locked by resting **spot** orders (task 7.8.7). Under a
   * unified account `hold` also covers perp margin, so the two are only equal
   * for an account with no perp exposure.
   */
  spotHold?: string;
}

/**
 * Spot token balances — embedded in {@link HlSubAccountEntry.spotState}, and
 * returned by the `spotClearinghouseState` info endpoint, which under a
 * `unifiedAccount` reports the account's entire balance (task 7.8.7).
 */
export interface HlSpotClearinghouseState {
  balances: HlSpotTokenBalance[];
}

/**
 * One row of `spotMeta().tokens` — the runtime linkage between a Core spot
 * token and its HyperEVM ERC-20 (task 7.9 / [#743]). ADR 7.9: "the linkage is
 * discoverable at runtime — do not hardcode it."
 */
export interface HlSpotMetaToken {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  index: number;
  tokenId: HlHex;
  isCanonical: boolean;
  /** `null` for a token with no HyperEVM representation. */
  evmContract: {
    /**
     * The contract the token is linked to. [#788] Not necessarily the ERC-20:
     * for USDC this is HyperCore's `CoreDepositWallet` on both mainnet and
     * testnet, and `balanceOf`/`decimals` revert on it.
     */
    address: HlHex;
    /** Added to `weiDecimals` for the EVM side's precision (USDC: 8 + −2 = 6). */
    evm_extra_wei_decimals: number;
  } | null;
  fullName: string | null;
  deployerTradingFeeShare: string;
}

export interface HlSpotMetaUniverseEntry {
  tokens: [baseToken: number, quoteToken: number];
  name: string;
  index: number;
  isCanonical: boolean;
}

export interface HlSpotMetaResult {
  universe: HlSpotMetaUniverseEntry[];
  tokens: HlSpotMetaToken[];
}

export interface HlSubAccountEntry {
  name: string;
  subAccountUser: HexAddress;
  master: HexAddress;
  clearinghouseState: HlClearinghouseState;
  spotState: HlSpotClearinghouseState;
}

/** `null` when the user has no sub-accounts. */
export type HlSubAccountsResult = HlSubAccountEntry[] | null;

// ── Read/account endpoints re-homed from the legacy SDK (Epic 1.5.4) ───────

export interface HlAllMidsParams {
  /** DEX name; omit or empty string for the main perp DEX. */
  dex?: string;
}

/** Mapping of coin symbol to mid price. */
export type HlAllMidsResult = Record<string, string>;

export interface HlL2BookParams {
  coin: string;
  nSigFigs?: 2 | 3 | 4 | 5;
  /** Aggregation mantissa; only meaningful when `nSigFigs` is 5. */
  mantissa?: 2 | 5;
}

export interface HlL2BookLevel {
  px: string;
  sz: string;
  n: number;
}

/** `null` when the requested coin does not exist. */
export type HlL2BookResult = {
  coin: string;
  time: number;
  /** Bid and ask levels (index 0 = bids, index 1 = asks). */
  levels: [HlL2BookLevel[], HlL2BookLevel[]];
  /** Only present when `nSigFigs` is set. */
  spread?: string;
} | null;

export interface HlRecentTradesParams {
  coin: string;
}

/** One public trade print; `side` is the aggressor ('B' = buy, 'A' = sell). */
export interface HlRecentTrade {
  coin: string;
  side: 'B' | 'A';
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
}

export type HlRecentTradesResult = HlRecentTrade[];

export interface HlCandleSnapshotParams {
  coin: string;
  interval: HlWsCandleInterval;
  startTime: number;
  endTime?: number;
}

export interface HlCandle {
  t: number;
  T: number;
  s: string;
  i: HlWsCandleInterval;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

export type HlCandleSnapshotResult = HlCandle[];

/** Perp asset context (mark/mid price, funding, open interest) aligned by index with `meta`'s `universe`. */
export interface HlPerpAssetCtx {
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  /** Validator-published median of external exchange prices — sets funding, anchors `markPx`. */
  oraclePx: string;
  funding: string;
  openInterest: string;
}

export type HlMetaAndAssetCtxsParams = HlMetaParams;

export type HlMetaAndAssetCtxsResult = [HlMetaResult, HlPerpAssetCtx[]];

export interface HlClearinghouseStateParams {
  user: HexAddress;
}

export interface HlSpotClearinghouseStateParams {
  user: HexAddress;
}

export interface HlUserAbstractionParams {
  user: HexAddress;
}

/**
 * Hyperliquid's account abstraction modes (task 7.8.7). Under
 * `unifiedAccount` spot and perp balances merge into one per-asset balance and
 * the perp clearinghouse state stops carrying the account's money; the other
 * modes keep the split the rest of this codebase assumes.
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
 */
export type HlUserAbstractionResult =
  | 'default'
  | 'unifiedAccount'
  | 'portfolioMargin'
  | 'disabled'
  | 'dexAbstraction';

export interface HlExtraAgent {
  address: HexAddress;
  name: string;
  /** `null` when the agent has no expiry. */
  validUntil: number | null;
}

export interface HlExtraAgentsParams {
  user: HexAddress;
}

export type HlExtraAgentsResult = HlExtraAgent[];

export interface HlMaxBuilderFeeParams {
  user: HexAddress;
  builder: HexAddress;
}

export type HlMaxBuilderFeeResult = number;

// ── WebSocket subscription transport (Epic 1.4.1) ──────────────────────────

/**
 * Connection health as observed by {@link HlSubscriptionClient}. Distinct from
 * the underlying SDK reconnect machinery, which does not surface a
 * consumer-facing signal — this enum is the wrapper-level gap coverage the
 * roadmap asks for.
 *
 * - `connecting` — first connection not yet established.
 * - `open` — connected and receiving frames.
 * - `reconnecting` — the socket dropped; the SDK is retrying with backoff.
 * - `stale` — the socket is open but no frame has arrived within
 *   {@link HlSubscriptionClientConfig.stalenessTimeoutMs}. Data flow has
 *   silently stalled even though the connection looks alive.
 * - `closed` — {@link HlSubscriptionClient.close} was called (terminal).
 */
export type HlWsConnectionStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'stale'
  | 'closed';

/**
 * Reconnect/backoff policy forwarded to the SDK transport. Wrapper-owned names
 * so the SDK's `ReconnectingWebSocketOptions` never leaks into packages/core.
 */
export interface HlWsReconnectOptions {
  /** Max consecutive failed reconnection attempts before giving up. Default: unlimited. */
  maxRetries?: number;
  /** Max time in ms to wait for a connection to open; `null` disables. Default: 10_000. */
  connectionTimeoutMs?: number | null;
  /** Delay before a reconnect in ms, or a function of the 0-based attempt number. Default: jittered exponential backoff capped at 10s. */
  reconnectionDelayMs?: number | ((attempt: number) => number);
  /** Return `false` to permanently stop reconnecting after a drop. Receives the 0-based attempt number. */
  shouldReconnect?: (attempt: number) => boolean;
}

/**
 * Keep-alive (heartbeat) policy forwarded to the SDK transport: it pings on
 * `intervalMs` and forces a reconnect when a ping goes unanswered for
 * `timeoutMs`.
 */
export interface HlWsKeepAliveOptions {
  /** Interval between pings in ms. The server drops a silent connection after ~60s. Default: 30_000. */
  intervalMs?: number;
  /** Time to wait for a pong before forcing a reconnect, in ms. Default: 10_000. */
  timeoutMs?: number;
}

/** Handle returned by every `subscribe*` call; awaiting `unsubscribe` tears the channel down. */
export interface HlWsSubscription {
  unsubscribe(): Promise<void>;
}

/** Options accepted by every `subscribe*` call. */
export interface HlWsSubscribeOptions {
  /** Stops waiting for the server confirmation and detaches the listener. */
  signal?: AbortSignal;
  /** Invoked at most once if an already-confirmed subscription later fails (rejected re-subscribe, permanent close). */
  onError?: (error: Error) => void;
}

/**
 * The subscription-transport seam (analogous to {@link HlTransport} for the
 * HTTP side): Phase 2 Epic 2.4.3's `packages/hl-egress` slots underneath the
 * WS wrapper by supplying one of these bound to a pool egress IP. Structurally
 * a subset of the SDK's `WebSocketTransport`, so the default factory returns
 * one directly. `socket` is the reconnecting socket as an `EventTarget`;
 * {@link HlSubscriptionClient} observes its `open`/`close`/`error`/`message`
 * events to derive {@link HlWsConnectionStatus}.
 */
export interface HlSubscriptionTransport {
  readonly socket: EventTarget;
  subscribe<T>(
    channel: string,
    payload: unknown,
    listener: (event: { detail: T }) => void,
    options?: HlWsSubscribeOptions
  ): Promise<HlWsSubscription>;
  ready(signal?: AbortSignal): Promise<void>;
  close(): void;
}

/** Resolved defaults handed to a {@link HlSubscriptionClientConfig.transportFactory}. */
export interface HlWsTransportDefaults {
  network: HlNetwork;
  /** WS endpoint override; falls back to the network default when omitted. */
  url?: string;
  timeout?: number | null;
  reconnect?: HlWsReconnectOptions;
  keepAlive?: HlWsKeepAliveOptions;
  /** Automatic re-subscription after a reconnect. */
  resubscribe: boolean;
}

export interface HlSubscriptionClientConfig {
  network: HlNetwork;
  /** WS endpoint override; ignored when a `transportFactory` is supplied. */
  url?: string;
  /** Request timeout in ms for WS POST requests; `null` disables. */
  timeout?: number | null;
  reconnect?: HlWsReconnectOptions;
  keepAlive?: HlWsKeepAliveOptions;
  /** Automatically re-subscribe every channel after a reconnect. Default: `true`. */
  resubscribe?: boolean;
  /**
   * No inbound frame within this many ms flips the connection status to
   * `stale`. Default: `keepAlive.intervalMs + keepAlive.timeoutMs` (40s with
   * the SDK defaults), so a healthy heartbeat keeps it fresh.
   */
  stalenessTimeoutMs?: number;
  /**
   * Transport-injection seam (Phase 2 Epic 2.4.3): return a subscription
   * transport bound to an egress IP. Omitted, the wrapper builds the SDK's
   * `WebSocketTransport` against the configured network.
   */
  transportFactory?: (defaults: HlWsTransportDefaults) => HlSubscriptionTransport;
}

/** Live mid prices for every coin, as pushed on the `allMids` channel. */
export interface HlWsAllMids {
  mids: Record<string, string>;
}

/** One price level in an {@link HlWsL2Book} side. */
export interface HlWsL2BookLevel {
  px: string;
  sz: string;
  n: number;
}

/** L2 order-book snapshot as pushed on the `l2Book` channel. */
export interface HlWsL2Book {
  coin: string;
  time: number;
  /** `[bids, asks]`. */
  levels: [HlWsL2BookLevel[], HlWsL2BookLevel[]];
}

export interface HlWsL2BookParams {
  coin: string;
  /** Price-aggregation significant figures (2-5); omit for full precision. */
  nSigFigs?: number;
  /** Extra mantissa precision when `nSigFigs` is 5. */
  mantissa?: number;
}

/** Candle interval accepted by the `candle` channel. */
export type HlWsCandleInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

/** A single candle as pushed on the `candle` channel. */
export interface HlWsCandle {
  /** Open time (ms since epoch). */
  t: number;
  /** Close time (ms since epoch). */
  T: number;
  /** Coin symbol. */
  s: string;
  /** Interval. */
  i: HlWsCandleInterval;
  o: string;
  c: string;
  h: string;
  l: string;
  /** Base-asset volume. */
  v: string;
  /** Number of trades. */
  n: number;
}

export interface HlWsCandleParams {
  coin: string;
  interval: HlWsCandleInterval;
}

// ── WebSocket subscription channels (Epic 1.4.2) ────────────────────────────
//
// The roadmap's "user (fills/order-update events)" maps to two distinct
// Hyperliquid wire channels, both keyed by user address:
// `subscribeUserFills` (fills) and `subscribeOrderUpdates` (order-status
// transitions) — kept separate rather than merged under one `userEvents`-style
// union so each stays precisely typed.

export interface HlWsUserFillsParams {
  user: HexAddress;
  /** If true, partial fills are aggregated when a crossing order fills multiple resting orders. */
  aggregateByTime?: boolean;
}

/** Fill update pushed on the `userFills` channel; `fills` reuses {@link HlUserFill}'s shape from the HTTP `userFills` endpoint. */
export interface HlWsUserFillsEvent {
  user: HexAddress;
  fills: HlUserFill[];
  /** `true` for the initial snapshot sent immediately after subscribing. */
  isSnapshot?: true;
}

export interface HlWsOrderUpdatesParams {
  user: HexAddress;
}

/** Order as carried on the `orderUpdates` channel — leaner than {@link HlFrontendOrder} (no trigger/TIF/children display fields). */
export interface HlWsOrderUpdateOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: HlHex;
  reduceOnly?: true;
}

export interface HlWsOrderUpdate {
  order: HlWsOrderUpdateOrder;
  /** Reuses {@link HlOrderProcessingStatus} (Epic 1.3.2's `historicalOrders` taxonomy). */
  status: HlOrderProcessingStatus;
  /** Timestamp when the status was last updated (in ms since epoch). */
  statusTimestamp: number;
}

export type HlWsOrderUpdatesEvent = HlWsOrderUpdate[];

export interface HlWsTradesParams {
  coin: string;
}

/** A single executed trade, as pushed on the `trades` channel. */
export interface HlWsTrade {
  coin: string;
  side: 'B' | 'A';
  px: string;
  sz: string;
  time: number;
  hash: HlHex;
  tid: number;
  /** `[buyer, seller]`. */
  users: [HexAddress, HexAddress];
}

export type HlWsTradesEvent = HlWsTrade[];

export interface HlWsNotificationParams {
  user: HexAddress;
}

/** A single user notification, as pushed on the `notification` channel. */
export interface HlWsNotification {
  notification: string;
}

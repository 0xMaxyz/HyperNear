export type HexAddress = `0x${string}`;

export interface PerpsAccount {
  address: HexAddress;
  chainId?: number;
  capabilities: {
    canSelfSign: boolean;
    supportsBatchSign: boolean;
  };
}

export interface SignTypedDataRequest {
  from: HexAddress;
  data: Record<string, unknown>;
  version: 'V4';
}

export interface EvmTxRequest {
  chainId: number;
  from: HexAddress;
  to: HexAddress;
  data?: HexAddress;
  value?: bigint;
}

export interface WalletAdapter {
  getAccount(): Promise<PerpsAccount | null>;
  onAccountChanged?(cb: (account: PerpsAccount | null) => void): () => void;
  signTypedData(req: SignTypedDataRequest): Promise<HexAddress>;
  signTypedDataBatch?(reqs: SignTypedDataRequest[]): Promise<HexAddress[]>;
  sendTransaction(tx: EvmTxRequest): Promise<HexAddress>;
  /**
   * Sign a plain EIP-191 ("personal_sign") message. Used by the SIWE
   * wallet-connect login flow (task 3.3.2) to sign the EIP-4361 message, never
   * for trading actions (those go through signTypedData). Optional because
   * non-EOA signers (e.g. the passkey path) don't need it.
   */
  signMessage?(message: string): Promise<HexAddress>;
}

export type ApproveSignatureType = 'approveAgent' | 'approveBuilderFee';

export interface ApproveSignature {
  type: ApproveSignatureType;
  signature: string;
  [key: string]: unknown;
}

/**
 * The complete EIP-712 payload an agent signer receives: everything an
 * `eth_signTypedData_v4`-style signer needs, and nothing else — no key
 * material, no SDK objects. Structurally identical to the hl wrapper's
 * `HlSignPayload`, so a seam signer plugs into the wrapper's agent tier
 * without translation.
 */
export interface AgentSignPayload {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: HexAddress;
  };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * The signature-oriented agent seam (Phase 1 Epic 1.5.2). Implementations
 * sign wherever the agent key actually lives — the passkey signer's iframe
 * (Phase 4), apps/api's session signer facade (Phase 5) — and expose only
 * the agent's public address plus an async `sign`. Key material never
 * crosses this interface: there is deliberately no member that returns a
 * private key.
 */
export interface AgentSigner {
  readonly agentAddress: HexAddress;
  sign(payload: AgentSignPayload): Promise<HexAddress>;
}

export interface AgentVaultAdapter {
  /**
   * Returns the signature-oriented signer for the master's trade agent,
   * creating the agent if needed. `isNew` is true when the agent was just
   * created, so the caller knows a fresh on-chain `approveAgent` is
   * required. (Replaces the retired `getOrCreateAgent`, whose raw
   * `agentPrivateKey` return was incompatible with signer isolation.)
   */
  getOrCreateAgentSigner(master: HexAddress): Promise<{
    signer: AgentSigner;
    isNew: boolean;
  }>;
  getApproveSignatures(master: HexAddress): Promise<ApproveSignature[]>;
  saveApproveSignatures(
    master: HexAddress,
    sigs: ApproveSignature[]
  ): Promise<void>;
}

export interface PerpTopToken {
  symbol: string;
  name: string;
  logo_url?: string;
  [key: string]: unknown;
}

export interface BridgeQuoteParams {
  fromChain: string;
  toChain: string;
  tokenId: string;
  amount: string;
  userAddr: string;
}

export interface BridgeQuote {
  tx: EvmTxRequest;
  [key: string]: unknown;
}

export interface PermissionResult {
  is_support: boolean;
  [key: string]: unknown;
}

export interface MarketDataAdapter {
  getTopTokenList(params?: Record<string, unknown>): Promise<PerpTopToken[]>;
  getBridgeQuote(params: BridgeQuoteParams): Promise<BridgeQuote>;
  getPermission(address: string): Promise<PermissionResult>;
}

export interface PreferencesAdapter {
  getFavorites(): Promise<string[]>;
  setFavorites(coins: string[]): Promise<void>;
  getMarketSlippage(): Promise<number>;
  setMarketSlippage(slippage: number): Promise<void>;
  getSelectedCoin(): Promise<string>;
  setSelectedCoin(coin: string): Promise<void>;
  getQuoteUnit(): Promise<'base' | 'usd'>;
  setQuoteUnit(unit: 'base' | 'usd'): Promise<void>;
  getLocale(): Promise<string>;
  setLocale(locale: string): Promise<void>;
}

/**
 * Builder-fee tag for orders (ADR 1.6.1). Defined here (not imported from
 * `hl/types.ts`'s `HlOrderBuilder`) to avoid a circular import — `hl/types.ts`
 * already imports {@link HexAddress} from this file — but the shape is
 * identical by design, so a {@link PerpsHostContext.builderFee} value plugs
 * straight into every order call's `builder` field with no conversion.
 */
export interface BuilderFeeConfig {
  /** Builder address receiving the fee. */
  address: HexAddress;
  /** Builder fee in tenths of a basis point (1 = 0.001%). */
  fee: number;
}

export interface PerpsHostContext {
  wallet: WalletAdapter;
  agentVault?: AgentVaultAdapter;
  marketData: MarketDataAdapter;
  preferences: PreferencesAdapter;
  /**
   * Per-host override for the compiled-in `PERPS_BUILDER_INFO` default
   * (`constants/index.ts`, ADR 1.6.1 — "no builder fee at MVP"). Unset ⇒ the
   * default applies. `apps/api` sets this from the `BUILDER_FEE_ADDRESS` /
   * `BUILDER_FEE_TENTHS_BPS` env pair (`apps/api/src/config.ts`) so an
   * operator can attach a real, Hyperliquid-registered builder without a
   * `packages/core` code change.
   */
  builderFee?: BuilderFeeConfig;
  /**
   * [Phase 16 · C.3d] Approvals are not this host's business — so
   * `ensureApprovals` must not run against it.
   *
   * Two hosts set it, and they are the two ends of the same request. The
   * SERVER's synthetic bundle (`apps/api/src/services/apiKeySigner.ts`) holds
   * no master signer at all; the CLIENT (`@perps-platform/api-client`) builds
   * the action locally and cannot reach Hyperliquid to ask about approvals in
   * the first place. In both, something else already owns the question.
   *
   * The `/v1` machine lane posts `{intent, nonce, signature}` from a bot. The
   * server rebuilds the action and verifies that one signature; there is no
   * master signer anywhere on the path and no second ceremony to ask for. Left
   * to run, `ensureApprovals` breaks that lane three ways:
   *
   *  - it probes `extraAgents` **on every order**, which is an upstream read on
   *    a bot's hot path and a spend against the per-IP weight budget;
   *  - inside the 24 h re-approval window it tries a master-signed
   *    `approveAgent` under {@link PERPS_AGENT_NAME} — the *browser's* name, not
   *    the API key's — through a wallet whose `signTypedData` throws, surfacing
   *    as a bewildering `AgentApprovalError` 502;
   *  - and on any deployment with a builder fee configured it pushes a
   *    master-signed `approveBuilderFee`, so **every** `/v1` order fails, not
   *    only ones near expiry.
   *
   * Expiry is not thereby unchecked — it moves to a TTL-cached pre-flight the
   * API lane owns (`services/apiKeyAgentLiveness.ts`), which answers with the
   * key's own error codes instead of attempting an approval it cannot perform.
   */
  detachedSignatureOnly?: boolean;
  /**
   * [Phase 16 · Epic G] The agent NAME this session's own trading key is
   * approved under. Defaults to `PERPS_AGENT_NAME`.
   *
   * A user's MAIN browser session keeps the named slot; every secondary session
   * passes {@link PERPS_UNNAMED_AGENT_NAME} — the empty string, which is a real
   * Hyperliquid slot rather than the absence of one. Without this the two
   * sessions approve *different random addresses* under the *same* name, and a
   * same-name approval deregisters the prior agent: device B evicts device A,
   * which re-approves and evicts B, forever.
   *
   * The host supplies it because only the host knows which session this is —
   * `GET /account/agent-status` reports the slot, keyed on the agent address in
   * this browser's own storage. A host that passes nothing gets the pre-Epic-G
   * behaviour, which is correct for a single-device account and for any
   * deployment with nowhere to record the choice.
   */
  agentSlotName?: string;
}

export interface ConnectResult {
  agentAddress: HexAddress;
  isSelfSign: boolean;
  isCreate: boolean;
}

export interface MarketOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  midPx?: string;
  slippage?: number;
  reduceOnly?: boolean;
  /** When set, leverage is updated on-chain before the order is placed. */
  leverage?: number;
  isCross?: boolean;
  /**
   * Ask for paid mempool priority, in basis points (max 8 — the exchange
   * ceiling). Converted to Hyperliquid's `grouping: { p }` form, where
   * `p = bps * 10000` out of 1e8. See spike 16.1.2.
   *
   * **Charged to the signing account's undelegated HYPE staking balance**, not
   * to the platform — so it is never defaulted on a user's behalf and never set
   * from deployment config. Only a caller that knowingly holds staked HYPE
   * should set it.
   *
   * Mutually exclusive with an attached TP/SL: both occupy the wire's
   * `grouping` field, so an order cannot be both prioritized and TP/SL-grouped.
   */
  priorityBps?: number;
}

export interface OrderResult {
  status: string;
  response?: unknown;
}

export interface CancelOrderParams {
  coin: string;
  /** Exchange order id (`oid`) of the resting order to cancel. */
  oid: number;
  /**
   * Request mempool priority for this cancel (Hyperliquid's `f` flag).
   *
   * Opt-in and never inferred: a fast cancel naming a **trigger** order is
   * *rejected*, so setting it without knowing costs the user the cancel, not
   * just the speed. Callers listing orders already have `OpenOrder.isTrigger`
   * — pass `fast: !order.isTrigger`. See `HlFastCancelFlag` in `hl/types.ts`.
   */
  fast?: boolean;
}

export interface CancelResult {
  status: string;
  response?: unknown;
}

/**
 * Cancel several resting orders in one signed action (Epic 1.2.2). The batch
 * is partial-failure-tolerant upstream: one entry failing (e.g. already
 * filled) doesn't fail the rest — each per-order outcome rides in the
 * result's `statuses` array, in request order.
 */
export interface CancelOrdersParams {
  cancels: CancelOrderParams[];
  /**
   * Request mempool priority for the whole batch (Hyperliquid's `f` flag).
   *
   * **Declared here, not per entry.** The flag rides on the `cancel` *action*,
   * alongside `cancels[]` rather than inside it, so a batch is all-fast or
   * none — there is no wire form for "fast for these three, not that one". Any
   * `fast` set on an individual {@link CancelOrderParams} is therefore ignored
   * in a batch; only this one is read.
   *
   * Set it only when **no** entry names a trigger order: Hyperliquid rejects
   * the action if any of them does, which would fail every cancel in the batch,
   * not just the trigger.
   */
  fast?: boolean;
}

/**
 * Time-in-force for a modified resting order — the replacement is a full
 * order, not a partial patch, so it declares how it rests just like a fresh
 * limit order. Defaults to `Gtc` (the resting behavior of a modify-in-place).
 */
export type OrderTif = 'Gtc' | 'Ioc' | 'Alo';

/**
 * Place a resting limit order (Epic 1.2.4, task 7.3.2). Unlike
 * {@link MarketOrderParams} — which crosses the book at a slippage-adjusted
 * price with a `FrontendMarket` tif — a limit order rests at `px` with an
 * explicit time-in-force (`Gtc`/`Ioc`/`Alo`) and may be flagged reduce-only.
 */
export interface LimitOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  /** Limit price the order rests at. */
  px: string;
  /** Defaults to `Gtc`. */
  tif?: OrderTif;
  reduceOnly?: boolean;
  /**
   * Ask for paid mempool priority, in basis points (max 8 — the exchange
   * ceiling). Converted to Hyperliquid's `grouping: { p }` form, where
   * `p = bps * 10000` out of 1e8. See spike 16.1.2.
   *
   * **Charged to the signing account's undelegated HYPE staking balance**, not
   * to the platform — so it is never defaulted on a user's behalf and never set
   * from deployment config. Only a caller that knowingly holds staked HYPE
   * should set it.
   *
   * Mutually exclusive with an attached TP/SL: both occupy the wire's
   * `grouping` field, so an order cannot be both prioritized and TP/SL-grouped.
   */
  priorityBps?: number;
}

/** Take-profit (`tp`) vs stop-loss (`sl`) direction of a trigger (task 7.3.3). */
export type TriggerTpSl = 'tp' | 'sl';

/**
 * Place a TP/SL trigger order (Epic 1.2.5, task 7.3.3). Unlike
 * {@link LimitOrderParams} — which rests on the book immediately — a trigger
 * order stays dormant until the mark price crosses `triggerPx`, then either
 * crosses as a market order (`isMarket: true`) or rests as a limit at `px`
 * (`isMarket: false`). `tpsl` picks take-profit (fires on a favorable move) vs
 * stop-loss (fires on an adverse one). TP/SL orders are typically reduce-only.
 */
export interface TriggerOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  /**
   * The order's price once triggered: the resting limit price for a limit
   * trigger (`isMarket: false`), or the aggressive crossing price for a market
   * trigger (`isMarket: true`).
   */
  px: string;
  /** Mark price at which the trigger fires. */
  triggerPx: string;
  tpsl: TriggerTpSl;
  /** `true` → execute as a market order on fire; `false` → rest as a limit. */
  isMarket: boolean;
  reduceOnly?: boolean;
}

/**
 * Replace a resting order in place (Epic 1.2.3). Identified by `coin` (→ asset
 * index) + its exchange `oid`; the remaining fields are the replacement
 * order's terms, mirroring {@link MarketOrderParams} minus the market-only
 * slippage/leverage knobs.
 */
export interface ModifyOrderParams {
  coin: string;
  /** Exchange order id (`oid`) of the resting order to replace. */
  oid: number;
  isBuy: boolean;
  size: string;
  /** Replacement limit price. */
  px: string;
  /** Defaults to `Gtc`. */
  tif?: OrderTif;
  reduceOnly?: boolean;
}

/**
 * Modify several resting orders in one signed action (Epic 1.2.3). Like a
 * batch order placement, the response's `statuses` array carries one entry
 * per modify, in request order.
 */
export interface ModifyOrdersParams {
  modifies: ModifyOrderParams[];
}

export interface ModifyResult {
  status: string;
  response?: unknown;
}

/**
 * Open a TWAP order (Epic 1.2.6, task 7.3.4). Unlike {@link LimitOrderParams}
 * or {@link MarketOrderParams} — which match as a single order — Hyperliquid
 * slices this into child orders over `durationMinutes` instead.
 */
export interface TwapOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  reduceOnly?: boolean;
  /** TWAP duration in minutes; Hyperliquid enforces 5-1440. */
  durationMinutes: number;
  /** Randomize child-order timing within each slice. Defaults to `true`. */
  randomize?: boolean;
}

export interface TwapOrderResult {
  status: string;
  response?: unknown;
}

/**
 * Cancel a running TWAP order (Epic 1.2.6, task 7.3.4), identified by `coin`
 * (→ asset index) plus its TWAP id — a distinct identifier space from a
 * regular resting order's `oid` (see {@link CancelOrderParams}).
 */
export interface TwapCancelParams {
  coin: string;
  twapId: number;
}

export interface TwapCancelResult {
  status: string;
  response?: unknown;
}

/**
 * One currently-running TWAP order (task 7.3.4), read from the `twapHistory`
 * info endpoint and filtered to `status: 'activated'` — the account surface
 * this feeds (the TWAP tab) only displays what's still executing.
 */
export interface RunningTwapOrder {
  twapId: number;
  coin: string;
  isBuy: boolean;
  size: string;
  executedSize: string;
  durationMinutes: number;
  reduceOnly: boolean;
  /** Start time, in ms since epoch. */
  startedAt: number;
}

/**
 * An entry order with a take-profit and/or stop-loss attached ([#826]).
 *
 * Hyperliquid expresses this as **one** `order` action carrying the entry plus
 * its trigger children under `normalTpsl` grouping — so it is one signed
 * action, one signature, and the children are cancelled by the exchange when
 * the position closes. Two separate submissions would be neither atomic nor
 * self-cancelling.
 *
 * At least one of `tpPrice` / `slPrice` must be set; with neither, the caller
 * wants a plain order and should use {@link PerpsClient.placeMarketOrder} or
 * {@link PerpsClient.placeLimitOrder}.
 */
export interface OrderWithTpSlParams {
  coin: string;
  isBuy: boolean;
  size: string;
  /** Entry limit price. Ignored when `isMarket` — the crossing price is derived. */
  px?: string;
  /** Entry crosses the book (`FrontendMarket` tif) rather than resting. */
  isMarket: boolean;
  /** Time-in-force for a resting entry; ignored when `isMarket`. */
  tif?: 'Gtc' | 'Ioc' | 'Alo';
  /** Mark/mid price for a market entry's crossing price; fetched when omitted. */
  midPx?: string;
  /** Fraction, e.g. 0.08 for 8%. Defaults to the wrapper's standard market slippage. */
  slippage?: number;
  tpPrice?: string;
  slPrice?: string;
}

/**
 * Attach a take-profit and/or stop-loss to an **already open** position
 * ([#828]).
 *
 * Distinct from {@link OrderWithTpSlParams} in the grouping, and the difference
 * matters: `normalTpsl` carries an entry order whose children bind to the
 * position that entry opens, while `positionTpsl` carries **only** the trigger
 * children and binds them to the position that already exists. Sending an entry
 * here would open a second position rather than protect the first.
 */
export interface PositionTpSlParams {
  coin: string;
  /** The side the trigger children trade — the opposite of the position's. */
  isBuy: boolean;
  size: string;
  tpPrice?: string;
  slPrice?: string;
}

/**
 * Add or remove isolated margin on an open position (Epic 1.2.7, task 7.3.5).
 * A per-position risk-config change — it moves collateral into or out of the
 * isolated position, opening no new exposure — so it relays like
 * {@link updateLeverage} rather than an order.
 */
export interface IsolatedMarginParams {
  coin: string;
  /** Position side the margin adjusts: `true` for long, `false` for short. */
  isBuy: boolean;
  /**
   * Signed USDC collateral delta: positive adds margin to the position,
   * negative removes it. Converted to Hyperliquid's 1e6-integer `ntli` wire
   * form by {@link PerpsClient.adjustIsolatedMargin}.
   */
  usd: string;
}

export interface IsolatedMarginResult {
  status: string;
  response?: unknown;
}

/**
 * Set the account's leverage and margin mode for one market ([#825]).
 *
 * `isCross` is deliberately **not optional**. The call underneath defaults a
 * missing value to `false` — isolated — which is the opposite of Hyperliquid's
 * account default, so an omitted flag silently moves the position to isolated
 * margin. Every caller states the mode it means.
 */
export interface LeverageParams {
  coin: string;
  /** Integer multiplier; the caller must have clamped it to the market's `maxLeverage`. */
  leverage: number;
  /** `true` for cross margin, `false` for isolated. */
  isCross: boolean;
}

export interface LeverageResult {
  status: string;
  response?: unknown;
}

/**
 * Flatten every open position at once (Epic 1.2.8, task 7.3.8) — the panic
 * button. `PerpsClient.closeAllPositions` composes the reads (open positions,
 * asset index/szDecimals, mid prices) itself; the only caller-facing knob is
 * an optional slippage override for the reduce-only crossing price, same as
 * {@link MarketOrderParams.slippage}.
 */
export interface CloseAllPositionsParams {
  /** Fraction, e.g. 0.08 for 8%. Defaults to the wrapper's standard market slippage. */
  slippage?: number;
}

export interface CloseAllPositionsResult {
  status: string;
  /** Coin symbols whose position was closed, in wire order; empty when flat (no-op). */
  closedCoins: string[];
  response?: unknown;
}

export interface WithdrawParams {
  amount: string;
  destination: HexAddress;
  isHypeWithdraw?: boolean;
  targetAsset?: string;
}

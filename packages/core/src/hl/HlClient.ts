import { HttpTransport } from '@nktkas/hyperliquid';
import type { IRequestTransport } from '@nktkas/hyperliquid';
import { createL1ActionHash, getWalletAddress, signL1Action } from '@nktkas/hyperliquid/signing';
import {
  ApiRequestError,
  agentSetAbstraction as sdkAgentSetAbstraction,
  approveAgent as sdkApproveAgent,
  approveBuilderFee as sdkApproveBuilderFee,
  batchModify as sdkBatchModify,
  cancel as sdkCancel,
  createSubAccount as sdkCreateSubAccount,
  modify as sdkModify,
  order as sdkOrder,
  sendAsset as sdkSendAsset,
  sendToEvmWithData as sdkSendToEvmWithData,
  setReferrer as sdkSetReferrer,
  spotSend as sdkSpotSend,
  usdClassTransfer as sdkUsdClassTransfer,
  subAccountSpotTransfer as sdkSubAccountSpotTransfer,
  subAccountTransfer as sdkSubAccountTransfer,
  twapCancel as sdkTwapCancel,
  twapOrder as sdkTwapOrder,
  updateIsolatedMargin as sdkUpdateIsolatedMargin,
  scheduleCancel as sdkScheduleCancel,
  updateLeverage as sdkUpdateLeverage,
  usdSend as sdkUsdSend,
  userSetAbstraction as sdkUserSetAbstraction,
  withdraw3 as sdkWithdraw3,
} from '@nktkas/hyperliquid/api/exchange';
import type {
  ApproveAgentParameters,
  ApproveBuilderFeeParameters,
  BatchModifyParameters,
  CancelParameters,
  CreateSubAccountParameters,
  ExchangeSingleWalletConfig,
  ModifyParameters,
  OrderParameters,
  SendAssetParameters,
  SendToEvmWithDataParameters,
  SetReferrerParameters,
  SpotSendParameters,
  UsdClassTransferParameters,
  SubAccountSpotTransferParameters,
  SubAccountTransferParameters,
  TwapCancelParameters,
  TwapOrderParameters,
  UpdateIsolatedMarginParameters,
  ScheduleCancelParameters,
  UpdateLeverageParameters,
  UsdSendParameters,
  Withdraw3Parameters,
} from '@nktkas/hyperliquid/api/exchange';
import {
  allMids as sdkAllMids,
  candleSnapshot as sdkCandleSnapshot,
  clearinghouseState as sdkClearinghouseState,
  extraAgents as sdkExtraAgents,
  fundingHistory as sdkFundingHistory,
  historicalOrders as sdkHistoricalOrders,
  l2Book as sdkL2Book,
  recentTrades as sdkRecentTrades,
  maxBuilderFee as sdkMaxBuilderFee,
  meta as sdkMeta,
  metaAndAssetCtxs as sdkMetaAndAssetCtxs,
  openOrders as sdkOpenOrders,
  referral as sdkReferral,
  spotClearinghouseState as sdkSpotClearinghouseState,
  spotMeta as sdkSpotMeta,
  subAccounts as sdkSubAccounts,
  twapHistory as sdkTwapHistory,
  userFills as sdkUserFills,
  userAbstraction as sdkUserAbstraction,
  userFunding as sdkUserFunding,
  userNonFundingLedgerUpdates as sdkUserNonFundingLedgerUpdates,
  userRole as sdkUserRole,
  portfolio as sdkPortfolio,
  userFees as sdkUserFees,
} from '@nktkas/hyperliquid/api/info';
import type {
  AllMidsParameters,
  CandleSnapshotParameters,
  ClearinghouseStateParameters,
  ExtraAgentsParameters,
  FundingHistoryParameters,
  HistoricalOrdersParameters,
  L2BookParameters,
  RecentTradesParameters,
  MaxBuilderFeeParameters,
  MetaAndAssetCtxsParameters,
  MetaParameters,
  OpenOrdersParameters,
  ReferralParameters,
  SpotClearinghouseStateParameters,
  SubAccountsParameters,
  TwapHistoryParameters,
  UserAbstractionParameters,
  UserFillsParameters,
  UserFundingParameters,
  UserNonFundingLedgerUpdatesParameters,
  UserRoleParameters,
  PortfolioParameters,
  UserFeesParameters,
} from '@nktkas/hyperliquid/api/info';
import { RelayRejectionError } from '../client/relay-rejection';
import { encodeAgentName } from './agent-name';
import { computeSlippagePrice } from './pricing';
import { HL_API_URLS, HL_DEFAULT_MARKET_SLIPPAGE, HL_SIGNATURE_CHAIN_IDS } from './types';
import type {
  HlAllMidsParams,
  HlAllMidsResult,
  HlApproveAgentParams,
  HlApproveBuilderFeeParams,
  HlAsyncSigner,
  HlBatchCancelParams,
  HlBatchModifyParams,
  HlCancelOrderParams,
  HlCancelResult,
  HlCandleSnapshotParams,
  HlCandleSnapshotResult,
  HlClearinghouseState,
  HlClearinghouseStateParams,
  HlClientConfig,
  HlCloseAllPositionsParams,
  HlCloseAllPositionsResult,
  HlCreateSubAccountParams,
  HlCreateSubAccountResult,
  HlExtraAgentsParams,
  HlExtraAgentsResult,
  HlFundingHistoryParams,
  HlFundingHistoryResult,
  HlHex,
  HlHistoricalOrdersParams,
  HlHistoricalOrdersResult,
  HlL1RequestOptions,
  HlFrontendOpenOrder,
  HlTrailingStopParams,
  HlTrailingStopResult,
  HlL2BookParams,
  HlL2BookResult,
  HlRecentTradesParams,
  HlRecentTradesResult,
  HlLimitOrderParams,
  HlMarketOrderParams,
  HlMaxBuilderFeeParams,
  HlMaxBuilderFeeResult,
  HlMetaAndAssetCtxsParams,
  HlMetaAndAssetCtxsResult,
  HlMetaParams,
  HlMetaResult,
  HlModifyParams,
  HlNetwork,
  HlOpenOrdersParams,
  HlOpenOrdersResult,
  HlOrderInput,
  HlOrderParams,
  HlOrderResult,
  HlReferralStatusParams,
  HlReferralStatusResult,
  HlRequestOptions,
  HlSendAssetParams,
  HlSendToEvmWithDataParams,
  HlSetReferrerParams,
  HlSignPayload,
  HlSpotClearinghouseState,
  HlSpotClearinghouseStateParams,
  HlSpotMetaResult,
  HlSpotSendParams,
  HlUsdClassTransferParams,
  HlSubAccountSpotTransferParams,
  HlSubAccountsParams,
  HlSubAccountsResult,
  HlSubAccountTransferParams,
  HlSuccessResult,
  HlTransport,
  HlTriggerOrderParams,
  HlTwapCancelParams,
  HlTwapCancelResult,
  HlTwapHistoryParams,
  HlTwapHistoryResult,
  HlTwapOrderParams,
  HlTwapOrderResult,
  HlUpdateIsolatedMarginParams,
  HlScheduleCancelParams,
  HlAbstractionCode,
  HlUpdateLeverageParams,
  HlUsdSendParams,
  HlUserAbstractionParams,
  HlUserAbstractionResult,
  HlUserSetAbstractionParams,
  HlUserFillsParams,
  HlUserFillsResult,
  HlUserFeesParams,
  HlUserFeesResult,
  HlUserFundingParams,
  HlUserFundingResult,
  HlUserPortfolioParams,
  HlUserPortfolioResult,
  HlLedgerUpdatesParams,
  HlLedgerUpdatesResult,
  HlUserRoleParams,
  HlUserRoleResult,
  HlWithdrawParams,
} from './types';

/**
 * L1 action hashing for wrapper-internal callers — the signing handshake
 * (./handshake.ts) builds unsigned actions and needs their hash without
 * signing or relaying. Lives here because this file is the package's single
 * SDK seam: action hashing is the one primitive that must never be
 * reimplemented in-house (Epic 0.1's verification gate exists so we can trust
 * the SDK's), and no other module may import the SDK directly.
 */
export function hashHlL1Action(args: {
  action: object;
  nonce: number;
  vaultAddress?: HlHex;
  expiresAfter?: number;
}): HlHex {
  return createL1ActionHash({
    action: args.action as never,
    nonce: args.nonce,
    vaultAddress: args.vaultAddress,
    expiresAfter: args.expiresAfter,
  });
}

type SignerTier = 'agent' | 'master';

const TIER_ROLES: Record<SignerTier, string> = {
  agent: 'L1 actions (orders, cancels) require config.agentSigner',
  master: 'user-signed actions (transfers, approvals) require config.masterSigner',
};

function toSdkTransport(transport: HlTransport, network: HlNetwork): IRequestTransport {
  return {
    isTestnet: network === 'testnet',
    request<T>(endpoint: 'info' | 'exchange', payload: unknown, signal?: AbortSignal): Promise<T> {
      return transport.request(endpoint, payload, signal) as Promise<T>;
    },
  };
}

// Adapts an async signer to the SDK's viem-local-account wallet shape; the
// signer only ever receives the ready-to-sign EIP-712 payload.
function toSdkWallet(signer: HlAsyncSigner) {
  return {
    address: signer.address,
    signTypedData: (payload: HlSignPayload): Promise<HlHex> => signer.sign(payload),
  };
}

/**
 * The thin internal wrapper around the Hyperliquid SDK (Epic 1.1.3). All SDK
 * access inside packages/core goes through this class so the dependency stays
 * swappable: the public surface is defined entirely by ./types.
 */
export class HlClient {
  readonly network: HlNetwork;
  readonly #config: HlClientConfig;
  #transport: IRequestTransport | null = null;

  constructor(config: HlClientConfig) {
    this.network = config.network;
    this.#config = config;
  }

  get apiUrl(): string {
    return this.#config.apiUrl ?? HL_API_URLS[this.network];
  }

  #sdkTransport(): IRequestTransport {
    if (!this.#transport) {
      this.#transport = this.#config.transport
        ? toSdkTransport(this.#config.transport, this.network)
        : new HttpTransport({
            isTestnet: this.network === 'testnet',
            timeout: this.#config.timeout,
            apiUrl: this.#config.apiUrl,
          });
    }
    return this.#transport;
  }

  #tierConfig(tier: SignerTier): ExchangeSingleWalletConfig {
    const signer = tier === 'agent' ? this.#config.agentSigner : this.#config.masterSigner;
    if (!signer) {
      throw new Error(`No ${tier} signer configured: ${TIER_ROLES[tier]}`);
    }
    const { nonceSource } = this.#config;
    return {
      transport: this.#sdkTransport(),
      wallet: toSdkWallet(signer),
      signatureChainId: this.#config.signatureChainId ?? HL_SIGNATURE_CHAIN_IDS[this.network],
      nonceManager: nonceSource ? (address) => nonceSource(address as HlHex) : undefined,
    };
  }

  /**
   * [#789] The SDK throws `ApiRequestError` for the exchange's own rejection
   * of an order, cancel, modify or withdrawal — this is the one seam allowed
   * to know that type exists (see `relay-rejection.ts`'s module doc), so it
   * rethrows `RelayRejectionError` in its place for every other caller in
   * this package (and, through it, every relay route in `apps/api`) to match
   * against. Not used by `approveAgent`/`approveBuilderFee`: those already
   * have their own carrier (`AgentApprovalError`, thrown one layer up in
   * `PerpsClient.ensureApprovals()`).
   */
  async #relayed<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        throw new RelayRejectionError({ cause: error });
      }
      throw error;
    }
  }

  #lastRawNonce = 0;

  /**
   * Ported from PerpX (packages/core HlClient.#executeRawL1, commit 4737a56b there). shortcut: the pinned SDK (0.33.x) has no
   * `trailingStop` helper and does not export its `executeL1Action`, so this mirrors that shell (nonce, sign, post, throw on
   * `status: "err"`). Replace it with the SDK method once one ships. Field order in `action` is part of the signed hash.
   */
  async #executeRawL1(action: Record<string, unknown>, opts?: HlL1RequestOptions): Promise<unknown> {
    const { wallet, nonceManager } = this.#tierConfig('agent');
    const address = await getWalletAddress(wallet as Parameters<typeof getWalletAddress>[0]);
    const nonce = nonceManager ? await nonceManager(address) : (this.#lastRawNonce = Math.max(Date.now(), this.#lastRawNonce + 1));
    const signature = await signL1Action({
      wallet: wallet as Parameters<typeof signL1Action>[0]['wallet'],
      action,
      nonce,
      isTestnet: this.network === 'testnet',
      vaultAddress: opts?.vaultAddress,
      expiresAfter: opts?.expiresAfter,
    });
    const response = await this.#sdkTransport().request(
      'exchange',
      {
        action,
        signature,
        nonce,
        ...(opts?.vaultAddress ? { vaultAddress: opts.vaultAddress } : {}),
        ...(opts?.expiresAfter ? { expiresAfter: opts.expiresAfter } : {}),
      },
      opts?.signal,
    );
    const failure = response as { status?: unknown; response?: unknown };
    if (failure.status === 'err') {
      throw new ApiRequestError(response, typeof failure.response === 'string' ? failure.response : undefined);
    }
    return response;
  }

  /**
   * Open a trailing stop (perps only): a `trailingStop` L1 action, not a variant of `order`. Hyperliquid tracks the mark price
   * itself, so nothing here re-prices anything. Signs via the agent tier, same as {@link order}.
   * Verified on testnet by PerpX; mainnet support is not verified here.
   */
  async trailingStopOpen(params: HlTrailingStopParams, opts?: HlL1RequestOptions): Promise<HlTrailingStopResult> {
    const action = {
      type: 'trailingStop',
      asset: params.asset,
      isBuy: params.isBuy,
      sz: params.size,
      reduceOnly: params.reduceOnly ?? false,
      retracement: params.retracement,
      activationPx: params.activationPx ?? null,
    };
    return (await this.#relayed(() => this.#executeRawL1(action, opts))) as HlTrailingStopResult;
  }

  async order(params: HlOrderParams, opts?: HlL1RequestOptions): Promise<HlOrderResult> {
    const { builder, ...rest } = params;
    const sdkParams = {
      ...rest,
      ...(builder ? { builder: { b: builder.address, f: builder.fee } } : {}),
    };
    const result = await this.#relayed(() =>
      sdkOrder(this.#tierConfig('agent'), sdkParams as OrderParameters, opts)
    );
    return result as HlOrderResult;
  }

  /**
   * Market order convenience wrapper (Epic 1.2.1): computes the
   * slippage-adjusted crossing price from `midPx` (see ./pricing.ts) and
   * places a `FrontendMarket`-tif limit order via {@link order} — the exact
   * construction the previously-shipped @rabby-wallet/hyperliquid-sdk's
   * `marketOrderOpen` used (same TIF, same 5-sig-fig/decimal rounding), so
   * output is compatible for identical inputs. Signs via the agent tier,
   * same as {@link order}.
   */
  async placeMarketOrder(
    params: HlMarketOrderParams,
    opts?: HlL1RequestOptions
  ): Promise<HlOrderResult> {
    const price = computeSlippagePrice(
      params.midPx,
      params.slippage ?? HL_DEFAULT_MARKET_SLIPPAGE,
      params.isBuy,
      params.szDecimals
    );
    const order: HlOrderInput = {
      a: params.asset,
      b: params.isBuy,
      p: price,
      s: params.size,
      r: params.reduceOnly ?? false,
      t: { limit: { tif: 'FrontendMarket' } },
      ...(params.c ? { c: params.c } : {}),
    };
    return this.order(
      { orders: [order], grouping: params.priority ?? 'na', builder: params.builder },
      opts
    );
  }

  /**
   * Open a resting limit order with an explicit time-in-force (Epic 1.2.4):
   * `Gtc`, `Ioc`, or `Alo`. Same `order` L1 action as {@link order} — the
   * `tif` is the only thing distinguishing the wire order from
   * {@link placeMarketOrder}'s `FrontendMarket` construction — so it signs
   * via the agent tier, same as {@link order}.
   */
  async limitOrderOpen(params: HlLimitOrderParams, opts?: HlL1RequestOptions): Promise<HlOrderResult> {
    const order: HlOrderInput = {
      a: params.asset,
      b: params.isBuy,
      p: params.price,
      s: params.size,
      r: params.reduceOnly ?? false,
      t: { limit: { tif: params.tif } },
      ...(params.c ? { c: params.c } : {}),
    };
    return this.order(
      { orders: [order], grouping: params.priority ?? 'na', builder: params.builder },
      opts
    );
  }

  /**
   * Open a TP/SL trigger order (Epic 1.2.5): the same `order` L1 action as
   * {@link order}, but the wire order's `t` carries a `trigger`
   * (`isMarket`/`triggerPx`/`tpsl`) instead of a `limit` (`tif`). Covers all
   * four variants — `tp`/`sl` × market (`isMarket: true`, executes as a market
   * order when the trigger fires) / limit (`isMarket: false`, rests at
   * {@link HlTriggerOrderParams.price} once triggered). Defaults to `na`
   * grouping (standalone); pass `normalTpsl`/`positionTpsl` to attach to a
   * position. Signs via the agent tier, same as {@link order}.
   */
  async triggerOrderOpen(
    params: HlTriggerOrderParams,
    opts?: HlL1RequestOptions
  ): Promise<HlOrderResult> {
    const order: HlOrderInput = {
      a: params.asset,
      b: params.isBuy,
      p: params.price,
      s: params.size,
      r: params.reduceOnly ?? false,
      t: { trigger: { isMarket: params.isMarket, triggerPx: params.triggerPx, tpsl: params.tpsl } },
      ...(params.c ? { c: params.c } : {}),
    };
    return this.order(
      { orders: [order], grouping: params.grouping ?? 'na', builder: params.builder },
      opts
    );
  }

  /**
   * Open a TWAP (time-weighted average price) order (Epic 1.2.6): a distinct
   * `twapOrder` L1 action — not a variant of the `order` action {@link order}/
   * {@link limitOrderOpen}/{@link triggerOrderOpen} share, since Hyperliquid
   * slices it into child orders over `durationMinutes` (5-1440) instead of
   * resting/matching as a single order. Signs via the agent tier, same as
   * {@link order}.
   */
  async twapOrderOpen(params: HlTwapOrderParams, opts?: HlL1RequestOptions): Promise<HlTwapOrderResult> {
    const sdkParams: TwapOrderParameters = {
      twap: {
        a: params.asset,
        b: params.isBuy,
        s: params.size,
        r: params.reduceOnly ?? false,
        m: params.durationMinutes,
        t: params.randomize ?? true,
      },
    };
    const result = await this.#relayed(() => sdkTwapOrder(this.#tierConfig('agent'), sdkParams, opts));
    return result as HlTwapOrderResult;
  }

  /**
   * Cancel a running TWAP order by asset + TWAP id (Epic 1.2.6): a distinct
   * `twapCancel` L1 action, signed exactly like {@link order} — the TWAP id
   * (`twapOrderOpen`'s `running.twapId`) is a different identifier space from
   * {@link cancelOrder}'s per-order `oid`, so it cannot cancel a TWAP.
   */
  async twapOrderCancel(params: HlTwapCancelParams, opts?: HlL1RequestOptions): Promise<HlTwapCancelResult> {
    const sdkParams: TwapCancelParameters = { a: params.asset, t: params.twapId };
    const result = await this.#relayed(() => sdkTwapCancel(this.#tierConfig('agent'), sdkParams, opts));
    return result as HlTwapCancelResult;
  }

  /**
   * Cancel order(s) by asset + order ID (Epic 1.2.2): an L1 action, signed
   * exactly like {@link order}. Batch semantics: the response's `statuses`
   * array has one entry per cancel request, in the same order — each is
   * `"success"` or `{ error }`, so one entry failing (e.g. already filled)
   * doesn't fail the rest of the batch. Signs via the agent tier, same as
   * {@link order}.
   */
  async batchCancel(params: HlBatchCancelParams, opts?: HlL1RequestOptions): Promise<HlCancelResult> {
    // `fast` → `f`, and only ever as literal `true`: the SDK schema is
    // `LiteralSchema<true>`, so an explicit `f: false` fails validation before
    // signing. Absence is how "not fast" is expressed. See HlFastCancelFlag.
    const sdkParams: CancelParameters = {
      cancels: params.cancels,
      ...(params.fast ? { f: true as const } : {}),
    } as CancelParameters;
    const result = await this.#relayed(() =>
      sdkCancel(this.#tierConfig('agent'), sdkParams, opts)
    );
    return result as HlCancelResult;
  }

  /**
   * Cancel a single order by asset + order ID — a convenience wrapper over
   * {@link batchCancel} with a one-entry `cancels` array, the same
   * relationship {@link placeMarketOrder} has to {@link order}.
   */
  async cancelOrder(params: HlCancelOrderParams, opts?: HlL1RequestOptions): Promise<HlCancelResult> {
    return this.batchCancel(
      { cancels: [{ a: params.asset, o: params.oid }], fast: params.fast },
      opts
    );
  }

  /**
   * Close every open position via reduce-only orders (Epic 1.2.8): reads
   * `clearinghouseState` for `params.user`, then builds one reduce-only
   * `FrontendMarket` order per non-zero position — same construction as
   * {@link placeMarketOrder}, using the caller-resolved asset index/
   * szDecimals/midPx from `params.assets` — and sends them as a single
   * batched {@link order} action. No open positions → no-op: the read still
   * runs, but no exchange request is sent and the result's `order` is
   * `undefined`. Signs via the agent tier, same as {@link order}.
   */
  async closeAllPositions(
    params: HlCloseAllPositionsParams,
    opts?: HlL1RequestOptions
  ): Promise<HlCloseAllPositionsResult> {
    const state = await this.clearinghouseState({ user: params.user });

    const openPositions = (state.assetPositions ?? []).filter(
      (ap) => Number(ap.position.szi) !== 0
    );
    if (openPositions.length === 0) {
      return { closedCoins: [] };
    }

    const orders: HlOrderInput[] = openPositions.map(({ position }) => {
      const { coin, szi } = position;
      const assetInfo = params.assets[coin];
      if (!assetInfo) {
        throw new Error(`closeAllPositions: no asset info provided for open position in "${coin}"`);
      }
      const isBuy = szi.startsWith('-');
      const size = isBuy ? szi.slice(1) : szi;
      const price = computeSlippagePrice(
        assetInfo.midPx,
        params.slippage ?? HL_DEFAULT_MARKET_SLIPPAGE,
        isBuy,
        assetInfo.szDecimals
      );
      return {
        a: assetInfo.asset,
        b: isBuy,
        p: price,
        s: size,
        r: true,
        t: { limit: { tif: 'FrontendMarket' } },
      };
    });

    const order = await this.order({ orders, grouping: 'na', builder: params.builder }, opts);
    return { closedCoins: openPositions.map(({ position }) => position.coin), order };
  }

  /**
   * Modify a single resting order (Epic 1.2.3). L1 action, signed exactly
   * like {@link order} — the official Python SDK has no standalone
   * single-modify convenience method (it always calls the batch form
   * underneath), but the Hyperliquid API and this wrapper's actual SDK
   * dependency expose `modify` as its own action type. Signs via the agent
   * tier; requires config.agentSigner.
   */
  async modifyOrder(params: HlModifyParams, opts?: HlL1RequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkModify(this.#tierConfig('agent'), params as ModifyParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * Modify multiple resting orders in one action (Epic 1.2.3), mirroring
   * `Exchange.bulk_modify_orders_new()`. L1 action, signed exactly like
   * {@link order}. Signs via the agent tier; requires config.agentSigner.
   */
  async batchModifyOrder(params: HlBatchModifyParams, opts?: HlL1RequestOptions): Promise<HlOrderResult> {
    const result = await this.#relayed(() =>
      sdkBatchModify(this.#tierConfig('agent'), params as BatchModifyParameters, opts)
    );
    return result as HlOrderResult;
  }

  async usdSend(params: HlUsdSendParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const result = await sdkUsdSend(this.#tierConfig('master'), params as UsdSendParameters, opts);
    return result as HlSuccessResult;
  }

  /** User-signed EIP-712 action; requires config.masterSigner. */
  async withdraw(params: HlWithdrawParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkWithdraw3(this.#tierConfig('master'), params as Withdraw3Parameters, opts)
    );
    return result as HlSuccessResult;
  }

  /** User-signed EIP-712 action; requires config.masterSigner. */
  async sendAsset(params: HlSendAssetParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkSendAsset(this.#tierConfig('master'), params as SendAssetParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * Withdraw from HyperCore to an external EVM chain over Circle CCTP ([#811]).
   * User-signed EIP-712 action; requires config.masterSigner.
   *
   * Relayed like every other action — the fee, the finality threshold and the
   * delivery hook are all chosen by `CoreDepositWallet` on HyperEVM, not by
   * this payload. Build the params through `planCctpWithdrawal` rather than by
   * hand: `destinationChainId` is a CCTP domain, and the SDK's own doc example
   * gets that wrong.
   */
  async sendToEvmWithData(
    params: HlSendToEvmWithDataParams,
    opts?: HlRequestOptions
  ): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkSendToEvmWithData(this.#tierConfig('master'), params as SendToEvmWithDataParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * Spot token transfer to another address ([#743]). User-signed EIP-712
   * action; requires config.masterSigner. Sending to HyperCore's system
   * address is the split-account payout leg of the HyperEVM withdrawal rail —
   * a **unified** account refuses this action outright and uses
   * {@link sendAsset} instead (ADR 7.9, spike 7.9 Q4).
   */
  async spotSend(params: HlSpotSendParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkSpotSend(this.#tierConfig('master'), params as SpotSendParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * Move USDC across the perp/spot class boundary ([#743]). User-signed EIP-712
   * action; requires config.masterSigner. Refused on a unified account, which
   * has no boundary to cross.
   */
  async usdClassTransfer(
    params: HlUsdClassTransferParams,
    opts?: HlRequestOptions
  ): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkUsdClassTransfer(this.#tierConfig('master'), params as UsdClassTransferParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * User-signed EIP-712 action; requires config.masterSigner.
   *
   * `validUntil` leaves here folded into the NAME (`hl/agent-name.ts`), because
   * that is the only place the wire has for it. Folded here rather than at the
   * call sites so no caller can hand-roll a suffix the SDK's strip does not
   * match — such a name is measured with the suffix attached and fails the
   * 16-char check for a reason the caller cannot see.
   */
  async approveAgent(params: HlApproveAgentParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const { validUntil, agentName, ...rest } = params;
    const named =
      agentName === undefined || agentName === ''
        ? { ...rest, ...(agentName === undefined ? {} : { agentName }) }
        : { ...rest, agentName: encodeAgentName(agentName, validUntil) };
    const result = await sdkApproveAgent(this.#tierConfig('master'), named as ApproveAgentParameters, opts);
    return result as HlSuccessResult;
  }

  /** User-signed EIP-712 action; requires config.masterSigner. */
  async approveBuilderFee(
    params: HlApproveBuilderFeeParams,
    opts?: HlRequestOptions
  ): Promise<HlSuccessResult> {
    const result = await sdkApproveBuilderFee(
      this.#tierConfig('master'),
      params as ApproveBuilderFeeParameters,
      opts
    );
    return result as HlSuccessResult;
  }

  /**
   * L1 action (phantom-agent scheme), signed exactly like {@link order} —
   * despite being grouped with the user-signed endpoints in Epic 1.2.9,
   * setReferrer is *not* a `sign_user_signed_action` action in either the
   * official Python SDK or this wrapper's own dependency. Requires
   * config.agentSigner.
   */
  async setReferrer(params: HlSetReferrerParams, opts?: HlL1RequestOptions): Promise<HlSuccessResult> {
    const result = await sdkSetReferrer(this.#tierConfig('agent'), params as SetReferrerParameters, opts);
    return result as HlSuccessResult;
  }

  /**
   * L1 action (phantom-agent scheme), signed exactly like {@link order} —
   * see {@link setReferrer}'s note. Requires config.agentSigner.
   */
  /**
   * Dead-man switch (L1 action, agent tier): cancels ALL of the account's open orders at `time` (ms since epoch, at least
   * 5 s ahead). Re-arming replaces the previous time; omitting `time` removes it. Hyperliquid limits the number of
   * triggers per day, and (per its docs) requires prior trading volume on the account.
   */
  async scheduleCancel(params: HlScheduleCancelParams = {}, opts?: HlL1RequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkScheduleCancel(this.#tierConfig('agent'), params as ScheduleCancelParameters, opts)
    );
    return result as HlSuccessResult;
  }

  async updateLeverage(params: HlUpdateLeverageParams, opts?: HlL1RequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkUpdateLeverage(this.#tierConfig('agent'), params as UpdateLeverageParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * L1 action (phantom-agent scheme), signed exactly like {@link order}
   * (Epic 1.2.7). Adjusts isolated-margin on a per-position basis —
   * per-position risk config with no external fund movement, so it shares
   * the agent tier with {@link updateLeverage}. Requires config.agentSigner.
   */
  async updateIsolatedMargin(
    params: HlUpdateIsolatedMarginParams,
    opts?: HlL1RequestOptions
  ): Promise<HlSuccessResult> {
    const result = await this.#relayed(() =>
      sdkUpdateIsolatedMargin(this.#tierConfig('agent'), params as UpdateIsolatedMarginParameters, opts)
    );
    return result as HlSuccessResult;
  }

  /**
   * Create a sub-account (Epic 1.2.10). L1 action (phantom-agent scheme),
   * signed exactly like {@link order} — despite being an account-management
   * action, not a trade, requires config.agentSigner.
   */
  async createSubAccount(
    params: HlCreateSubAccountParams,
    opts?: HlL1RequestOptions
  ): Promise<HlCreateSubAccountResult> {
    const result = await sdkCreateSubAccount(
      this.#tierConfig('agent'),
      params as CreateSubAccountParameters,
      opts
    );
    return result as HlCreateSubAccountResult;
  }

  /**
   * Transfer perpetual USDC into/out of a sub-account (Epic 1.2.10). L1
   * action, signed exactly like {@link order} — requires config.agentSigner.
   */
  async subAccountTransfer(
    params: HlSubAccountTransferParams,
    opts?: HlL1RequestOptions
  ): Promise<HlSuccessResult> {
    const result = await sdkSubAccountTransfer(
      this.#tierConfig('agent'),
      params as SubAccountTransferParameters,
      opts
    );
    return result as HlSuccessResult;
  }

  /**
   * Transfer a spot token into/out of a sub-account (Epic 1.2.10). L1
   * action, signed exactly like {@link order} — requires config.agentSigner.
   */
  async subAccountSpotTransfer(
    params: HlSubAccountSpotTransferParams,
    opts?: HlL1RequestOptions
  ): Promise<HlSuccessResult> {
    const result = await sdkSubAccountSpotTransfer(
      this.#tierConfig('agent'),
      params as SubAccountSpotTransferParameters,
      opts
    );
    return result as HlSuccessResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async portfolio(
    params: HlUserPortfolioParams,
    opts?: HlRequestOptions
  ): Promise<HlUserPortfolioResult> {
    const result = await sdkPortfolio(
      { transport: this.#sdkTransport() },
      params as PortfolioParameters,
      opts?.signal
    );
    return result as HlUserPortfolioResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async userFees(params: HlUserFeesParams, opts?: HlRequestOptions): Promise<HlUserFeesResult> {
    const result = await sdkUserFees(
      { transport: this.#sdkTransport() },
      params as UserFeesParameters,
      opts?.signal
    );
    return result as HlUserFeesResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async userFills(params: HlUserFillsParams, opts?: HlRequestOptions): Promise<HlUserFillsResult> {
    const result = await sdkUserFills(
      { transport: this.#sdkTransport() },
      params as UserFillsParameters,
      opts?.signal
    );
    return result as HlUserFillsResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async historicalOrders(
    params: HlHistoricalOrdersParams,
    opts?: HlRequestOptions
  ): Promise<HlHistoricalOrdersResult> {
    const result = await sdkHistoricalOrders(
      { transport: this.#sdkTransport() },
      params as HistoricalOrdersParameters,
      opts?.signal
    );
    return result as HlHistoricalOrdersResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async openOrders(
    params: HlOpenOrdersParams,
    opts?: HlRequestOptions
  ): Promise<HlOpenOrdersResult> {
    const result = await sdkOpenOrders(
      { transport: this.#sdkTransport() },
      params as OpenOrdersParameters,
      opts?.signal
    );
    return result as HlOpenOrdersResult;
  }

  /**
   * Open orders with their trigger details (trigger price and condition, order type, TP/SL and position-TP/SL flags), which
   * `openOrders` leaves out. Raw `frontendOpenOrders` info request: the pinned SDK has no wrapper. Read-only; requires no signer.
   */
  async frontendOpenOrders(params: { user: string }, opts?: HlRequestOptions): Promise<HlFrontendOpenOrder[]> {
    return (await this.#sdkTransport().request('info', { type: 'frontendOpenOrders', user: params.user }, opts?.signal)) as HlFrontendOpenOrder[];
  }

  /** Read-only info endpoint; requires no signer. */
  async userFunding(
    params: HlUserFundingParams,
    opts?: HlRequestOptions
  ): Promise<HlUserFundingResult> {
    const result = await sdkUserFunding(
      { transport: this.#sdkTransport() },
      params as UserFundingParameters,
      opts?.signal
    );
    return result as HlUserFundingResult;
  }

  /**
   * Every non-funding movement of value in or out of the account — bridge
   * deposits and withdrawals, spot sends, internal transfers. Read-only.
   *
   * This endpoint was deliberately dropped as an account-EXISTENCE probe (ADR
   * 7.9.10 replaced that use with `userRole`, because it returned an address's
   * whole history to answer one bit). That objection was to the signal, not the
   * endpoint: as a transfer history it is exactly the right read, and it is the
   * only one that is complete and cross-device without us storing anything.
   *
   * Bound the window at the caller — `startTime: 0` returns everything.
   */
  async userNonFundingLedgerUpdates(
    params: HlLedgerUpdatesParams,
    opts?: HlRequestOptions
  ): Promise<HlLedgerUpdatesResult> {
    const result = await sdkUserNonFundingLedgerUpdates(
      { transport: this.#sdkTransport() },
      params as UserNonFundingLedgerUpdatesParameters,
      opts?.signal
    );
    return result as HlLedgerUpdatesResult;
  }

  /**
   * The user's TWAP order history (task 7.3.4): every TWAP the account has
   * ever opened, each with its lifecycle status (`activated` while running,
   * plus `finished`/`terminated`/`error`). Read-only info endpoint; requires
   * no signer.
   */
  async twapHistory(
    params: HlTwapHistoryParams,
    opts?: HlRequestOptions
  ): Promise<HlTwapHistoryResult> {
    const result = await sdkTwapHistory(
      { transport: this.#sdkTransport() },
      params as TwapHistoryParameters,
      opts?.signal
    );
    return result as HlTwapHistoryResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async fundingHistory(
    params: HlFundingHistoryParams,
    opts?: HlRequestOptions
  ): Promise<HlFundingHistoryResult> {
    const result = await sdkFundingHistory(
      { transport: this.#sdkTransport() },
      params as FundingHistoryParameters,
      opts?.signal
    );
    return result as HlFundingHistoryResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async referralStatus(
    params: HlReferralStatusParams,
    opts?: HlRequestOptions
  ): Promise<HlReferralStatusResult> {
    const result = await sdkReferral(
      { transport: this.#sdkTransport() },
      params as ReferralParameters,
      opts?.signal
    );
    return result as HlReferralStatusResult;
  }

  /** Read-only info endpoint; requires no signer. */
  async userRole(
    params: HlUserRoleParams,
    opts?: HlRequestOptions
  ): Promise<HlUserRoleResult> {
    const result = await sdkUserRole(
      { transport: this.#sdkTransport() },
      params as UserRoleParameters,
      opts?.signal
    );
    return result as HlUserRoleResult;
  }

  /**
   * Perpetuals trading metadata (Epic 1.3.8): the `universe` array backing
   * {@link HlAssetIndexResolver}'s coin → asset-index resolution — a coin's
   * numeric asset index is its position in this array, which Hyperliquid
   * never returns explicitly. Read-only info endpoint; requires no signer.
   */
  async meta(params?: HlMetaParams, opts?: HlRequestOptions): Promise<HlMetaResult> {
    const result = await sdkMeta(
      { transport: this.#sdkTransport() },
      (params ?? {}) as MetaParameters,
      opts?.signal
    );
    return result as HlMetaResult;
  }

  /**
   * List the given user's sub-accounts (Epic 1.3.7), each with its own
   * perp/spot clearinghouse state. `null` when the user has none.
   * Read-only info endpoint; requires no signer.
   */
  async subAccounts(
    params: HlSubAccountsParams,
    opts?: HlRequestOptions
  ): Promise<HlSubAccountsResult> {
    const result = await sdkSubAccounts(
      { transport: this.#sdkTransport() },
      params as SubAccountsParameters,
      opts?.signal
    );
    return result as HlSubAccountsResult;
  }

  /**
   * Perpetuals account summary (positions, margin, withdrawable balance) for
   * `params.user`. Read-only info endpoint; requires no signer. (Epic 1.5.4 —
   * re-homed from the legacy SDK's `getClearingHouseState`.)
   */
  async clearinghouseState(
    params: HlClearinghouseStateParams,
    opts?: HlRequestOptions
  ): Promise<HlClearinghouseState> {
    const result = await sdkClearinghouseState(
      { transport: this.#sdkTransport() },
      params as ClearinghouseStateParameters,
      opts?.signal
    );
    return result as HlClearinghouseState;
  }

  /**
   * The user's spot token balances (task 7.8.7). Read-only info endpoint;
   * requires no signer. Under a `unifiedAccount` this is where **all** of the
   * account's money is reported — the perp `clearinghouseState` reads zero by
   * design (see {@link userAbstraction}).
   */
  async spotClearinghouseState(
    params: HlSpotClearinghouseStateParams,
    opts?: HlRequestOptions
  ): Promise<HlSpotClearinghouseState> {
    const result = await sdkSpotClearinghouseState(
      { transport: this.#sdkTransport() },
      params as SpotClearinghouseStateParameters,
      opts?.signal
    );
    return result as HlSpotClearinghouseState;
  }

  /**
   * Spot trading metadata ([#743]). Read-only info endpoint; requires no
   * signer. Carries `tokens[].tokenId` — the `USDC:0x…` reference every spot
   * transfer action takes — and `tokens[].evmContract`, the contract the token
   * is linked to on HyperEVM. ADR 7.9: that linkage is a runtime read, never
   * hardcoded. [#788] It is not necessarily the ERC-20 — for USDC it is
   * HyperCore's `CoreDepositWallet` on both networks — so anything reading a
   * balance must resolve it first (`resolveHyperEvmPayoutToken`).
   */
  async spotMeta(opts?: HlRequestOptions): Promise<HlSpotMetaResult> {
    const result = await sdkSpotMeta({ transport: this.#sdkTransport() }, opts?.signal);
    return result as HlSpotMetaResult;
  }

  /**
   * The account's abstraction mode (task 7.8.7). Read-only info endpoint;
   * requires no signer. `unifiedAccount` merges spot and perp balances into a
   * single per-asset balance, and Hyperliquid's own docs state that under it
   * "individual perp dex user states are not meaningful" — so the mode decides
   * which clearinghouse state a balance may be read from at all.
   */
  async userAbstraction(
    params: HlUserAbstractionParams,
    opts?: HlRequestOptions
  ): Promise<HlUserAbstractionResult> {
    const result = await sdkUserAbstraction(
      { transport: this.#sdkTransport() },
      params as UserAbstractionParameters,
      opts?.signal
    );
    return result as HlUserAbstractionResult;
  }

  /**
   * Set the account's abstraction mode as an L1 action signed by an approved agent wallet (`i` disabled, `u` unified,
   * `p` portfolio margin). Hyperliquid accepts it only while the account is still in default mode. Requires config.agentSigner.
   */
  async agentSetAbstraction(abstraction: HlAbstractionCode, opts?: HlL1RequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() => sdkAgentSetAbstraction(this.#tierConfig('agent'), { abstraction }, opts));
    return result as HlSuccessResult;
  }

  /** The same change signed by the account's own master key (user-signed EIP-712). Requires config.masterSigner. */
  async userSetAbstraction(params: HlUserSetAbstractionParams, opts?: HlRequestOptions): Promise<HlSuccessResult> {
    const result = await this.#relayed(() => sdkUserSetAbstraction(this.#tierConfig('master'), params, opts));
    return result as HlSuccessResult;
  }

  /**
   * Live mid prices for every coin (Epic 1.5.4 — re-homed from the legacy
   * SDK's `getAllMids`). Read-only info endpoint; requires no signer.
   */
  async allMids(params?: HlAllMidsParams, opts?: HlRequestOptions): Promise<HlAllMidsResult> {
    const result = await sdkAllMids(
      { transport: this.#sdkTransport() },
      (params ?? {}) as AllMidsParameters,
      opts?.signal
    );
    return result as HlAllMidsResult;
  }

  /**
   * L2 order book snapshot for one coin (Epic 1.5.4 — re-homed from the
   * legacy SDK's `getL2Book`). Read-only info endpoint; requires no signer.
   */
  async l2Book(params: HlL2BookParams, opts?: HlRequestOptions): Promise<HlL2BookResult> {
    const result = await sdkL2Book(
      { transport: this.#sdkTransport() },
      params as L2BookParameters,
      opts?.signal
    );
    return result as HlL2BookResult;
  }

  /** Recent public trades for one coin (read-only info endpoint, no signer). */
  async recentTrades(
    params: HlRecentTradesParams,
    opts?: HlRequestOptions
  ): Promise<HlRecentTradesResult> {
    const result = await sdkRecentTrades(
      { transport: this.#sdkTransport() },
      params as RecentTradesParameters,
      opts?.signal
    );
    return result as HlRecentTradesResult;
  }

  /**
   * Candlestick snapshot for one coin + interval (Epic 1.5.4 — re-homed from
   * the legacy SDK's `candleSnapshot`). Read-only info endpoint; requires no
   * signer.
   */
  async candleSnapshot(
    params: HlCandleSnapshotParams,
    opts?: HlRequestOptions
  ): Promise<HlCandleSnapshotResult> {
    const result = await sdkCandleSnapshot(
      { transport: this.#sdkTransport() },
      params as CandleSnapshotParameters,
      opts?.signal
    );
    return result as HlCandleSnapshotResult;
  }

  /**
   * Trading metadata plus live asset contexts (mark/mid price, funding, open
   * interest) for every perp, aligned by index with `meta`'s `universe`
   * (Epic 1.5.4 — re-homed from the legacy SDK's `metaAndAssetCtxs`).
   * Read-only info endpoint; requires no signer.
   */
  async metaAndAssetCtxs(
    params?: HlMetaAndAssetCtxsParams,
    opts?: HlRequestOptions
  ): Promise<HlMetaAndAssetCtxsResult> {
    const result = await sdkMetaAndAssetCtxs(
      { transport: this.#sdkTransport() },
      (params ?? {}) as MetaAndAssetCtxsParameters,
      opts?.signal
    );
    return result as HlMetaAndAssetCtxsResult;
  }

  /**
   * The approved extra agents (trade-agent wallets) for `params.user` (Epic
   * 1.5.4 — re-homed from the legacy SDK's `extraAgents`). Read-only info
   * endpoint; requires no signer.
   */
  async extraAgents(
    params: HlExtraAgentsParams,
    opts?: HlRequestOptions
  ): Promise<HlExtraAgentsResult> {
    const result = await sdkExtraAgents(
      { transport: this.#sdkTransport() },
      params as ExtraAgentsParameters,
      opts?.signal
    );
    return result as HlExtraAgentsResult;
  }

  /**
   * The maximum builder fee `params.user` has approved for `params.builder`
   * (Epic 1.5.4 — re-homed from the legacy SDK's `getMaxBuilderFee`).
   * Read-only info endpoint; requires no signer.
   */
  async maxBuilderFee(
    params: HlMaxBuilderFeeParams,
    opts?: HlRequestOptions
  ): Promise<HlMaxBuilderFeeResult> {
    const result = await sdkMaxBuilderFee(
      { transport: this.#sdkTransport() },
      params as MaxBuilderFeeParameters,
      opts?.signal
    );
    return result as HlMaxBuilderFeeResult;
  }
}

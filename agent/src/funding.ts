// Funding a leg through NEAR Intents 1Click: any supported token on any supported chain -> HyperCore spot USDC on the leg's own
// address, swapped on the way by the intents network (that is the NEAR hop; nothing else is built for it).
// The agent never holds the funds: a real quote returns a one-off deposit address and the user sends to it from their own wallet.
// 1Click is mainnet-only, so off mainnet every quote is a dry one (a price preview, no deposit address). Lands on the leg's SPOT
// balance: moving it to the trading balance is an owner-signed usdClassTransfer (toPerp).
import type { Activation } from './activation.ts';
import { HttpError } from './relayer.ts';

export const ONECLICK_API = process.env.ONECLICK_API ?? 'https://1click.chaindefuser.com';

/** HyperCore spot USDC (HL token 0); the `erc20` hypercore asset is HyperEVM USDC, not what a leg trades with. */
export const HYPERCORE_USDC = { id: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8 } as const;

export interface FundToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  /** USD per unit (1Click's own price feed), for the limits and the preview */
  price: number;
  label: string;
}

/** Which symbols on which chains are offered: stables and ETH on the big chains. Anything else 1Click lists is ignored. */
const OFFER: Record<string, string[]> = {
  USDC: ['near', 'arb', 'base', 'eth', 'op', 'pol', 'sol', 'bsc', 'avax'],
  USDT: ['eth', 'arb', 'near'],
  ETH: ['eth', 'arb', 'base'],
};
const CHAIN_NAME: Record<string, string> = { near: 'NEAR', arb: 'Arbitrum', base: 'Base', eth: 'Ethereum', op: 'Optimism', pol: 'Polygon', sol: 'Solana', bsc: 'BNB Chain', avax: 'Avalanche' };
const EVM = new Set(['eth', 'arb', 'base', 'op', 'pol', 'bsc', 'avax']);

/** Used when /v0/tokens cannot be reached: the two assets the runbook was checked with (2026-11-07). */
const FALLBACK: FundToken[] = [
  { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', blockchain: 'near', decimals: 6, price: 1, label: 'USDC on NEAR' },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', symbol: 'USDC', blockchain: 'arb', decimals: 6, price: 1, label: 'USDC on Arbitrum' },
];

export interface FundingOptions {
  /** Hyperliquid network of the legs. Only mainnet may ask for real deposit addresses. */
  network: 'testnet' | 'mainnet';
  minUsd?: number;
  maxUsd?: number;
  fetchFn?: typeof fetch;
  api?: string;
  tokensTtlMs?: number;
}

export interface FundQuote {
  /** true: a price preview, no deposit address exists */
  dry: boolean;
  token: string;
  amountIn: number;
  amountInUsd: number | null;
  /** HyperCore USDC the swap delivers */
  amountOut: number;
  minAmountOut: number;
  /** what the leg ends up holding: 1Click is a HyperCore sender, so the 1 USDC activation fee of a never-seen leg is paid by 1Click, not taken from the leg (owner-reported on mainnet; check the first real deposit) */
  expectedCredit: number;
  activationFeeUsd: number;
  firstTransferOutFeeUsd: number;
  withdrawFeeUsd: number;
  etaSec: number | null;
  depositAddress: string | null;
  deadline: string | null;
  correlationId: string | null;
}

export interface QuoteRequest {
  /** assetId from /fund/info */
  token: string;
  amount: string;
  /** the leg's address */
  recipient: string;
  /** the user's own address on the origin chain: where a failed swap sends the money back */
  refundTo: string;
  activation: Activation;
  dry?: boolean;
}

const AMOUNT = /^\d{1,9}(\.\d{1,18})?$/;

function units(amount: string, decimals: number): string {
  const [i = '', f = ''] = amount.split('.');
  if (f.length > decimals) throw new HttpError(400, `amount has more than ${decimals} decimals`);
  return (BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals))).toString();
}
const num = (raw: unknown, decimals: number) => (raw === undefined || raw === null || Number.isNaN(Number(raw)) ? 0 : Number(raw) / 10 ** decimals);

export function validRefund(chain: string, addr: string): boolean {
  if (EVM.has(chain)) return /^0x[0-9a-fA-F]{40}$/.test(addr);
  if (chain === 'near') return /^[0-9a-f]{64}$/.test(addr) || (/^([a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(addr) && addr.length >= 2 && addr.length <= 64);
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  return /^\S{10,100}$/.test(addr);
}

export function fundingService(o: FundingOptions) {
  const api = o.api ?? ONECLICK_API;
  const doFetch = o.fetchFn ?? fetch;
  const minUsd = o.minUsd ?? 3;
  const maxUsd = o.maxUsd ?? 50;
  const ttl = o.tokensTtlMs ?? 10 * 60_000;
  let cached: { at: number; tokens: FundToken[] } | undefined;

  async function call(path: string, init?: RequestInit): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`; // stays on the server
    let r: Response;
    try {
      r = await doFetch(`${api}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new HttpError(502, `could not reach 1Click: ${(e as Error).message}`);
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status === 400 ? 422 : 502, `1Click: ${String((body as { message?: string }).message ?? JSON.stringify(body)).slice(0, 300)}`);
    return body;
  }

  async function tokens(): Promise<{ tokens: FundToken[]; live: boolean }> {
    if (cached && Date.now() - cached.at < ttl) return { tokens: cached.tokens, live: true };
    try {
      const all = (await call('/v0/tokens')) as { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number }[];
      const picked = all
        .filter((t) => OFFER[t.symbol]?.includes(t.blockchain))
        .map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: Number(t.price) || 0, label: `${t.symbol} on ${CHAIN_NAME[t.blockchain] ?? t.blockchain}` }))
        .sort((a, b) => Object.keys(OFFER).indexOf(a.symbol) - Object.keys(OFFER).indexOf(b.symbol) || (OFFER[a.symbol]!.indexOf(a.blockchain) - OFFER[b.symbol]!.indexOf(b.blockchain)));
      if (picked.length === 0) throw new Error('no offered token in the list');
      cached = { at: Date.now(), tokens: picked };
      return { tokens: picked, live: true };
    } catch {
      return { tokens: FALLBACK, live: false };
    }
  }

  return {
    async info() {
      const t = await tokens();
      return { network: o.network, realDeposits: o.network === 'mainnet', minUsd, maxUsd, tokens: t.tokens, tokenList: t.live ? 'live' : 'fallback' };
    },

    async quote(q: QuoteRequest): Promise<FundQuote> {
      const token = (await tokens()).tokens.find((t) => t.assetId === q.token);
      if (!token) throw new HttpError(400, 'token is not one this agent funds from');
      if (!AMOUNT.test(q.amount) || Number(q.amount) <= 0) throw new HttpError(400, 'amount must be a positive decimal number');
      if (!/^0x[0-9a-fA-F]{40}$/.test(q.recipient)) throw new HttpError(400, 'recipient must be a leg address');
      if (typeof q.refundTo !== 'string' || !validRefund(token.blockchain, q.refundTo)) throw new HttpError(400, `refundTo must be your own ${CHAIN_NAME[token.blockchain] ?? token.blockchain} address, where a failed swap returns the money`);
      const usd = Number(q.amount) * token.price;
      if (token.price > 0 && usd < minUsd) throw new HttpError(400, `the minimum is about $${minUsd} (this is $${usd.toFixed(2)})`);
      if (token.price > 0 && usd > maxUsd) throw new HttpError(400, `the maximum per deposit is $${maxUsd} (this is $${usd.toFixed(2)})`);
      const activationFee = q.activation === 'owed-on-credit' ? 1 : 0; // the fee a new leg's first credit carries; the sender pays it
      const dry = o.network !== 'mainnet' || q.dry !== false; // a real address only ever comes from an explicit request on mainnet
      const res = await call('/v0/quote', {
        method: 'POST',
        body: JSON.stringify({
          dry,
          swapType: 'EXACT_INPUT',
          slippageTolerance: 100, // bps
          originAsset: token.assetId,
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: HYPERCORE_USDC.id,
          amount: units(q.amount, token.decimals),
          refundTo: q.refundTo,
          refundType: 'ORIGIN_CHAIN',
          recipient: q.recipient,
          recipientType: 'DESTINATION_CHAIN',
          deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      });
      const r = res.quote ?? {};
      const amountOut = num(r.amountOut, HYPERCORE_USDC.decimals);
      return {
        dry,
        token: token.label,
        amountIn: Number(q.amount),
        amountInUsd: token.price > 0 ? usd : null,
        amountOut,
        minAmountOut: num(r.minAmountOut, HYPERCORE_USDC.decimals),
        expectedCredit: amountOut,
        activationFeeUsd: activationFee,
        firstTransferOutFeeUsd: q.activation === 'owed-on-first-send' ? 1 : 0,
        withdrawFeeUsd: num(r.withdrawFee, HYPERCORE_USDC.decimals),
        etaSec: typeof r.timeEstimate === 'number' ? r.timeEstimate : null,
        depositAddress: dry ? null : (r.depositAddress ?? null),
        deadline: r.deadline ?? null,
        correlationId: res.correlationId ?? null,
      };
    },

    async status(depositAddress: string): Promise<{ status: string; updatedAt?: string }> {
      if (!/^[A-Za-z0-9._:-]{8,120}$/.test(depositAddress)) throw new HttpError(400, 'depositAddress is not a deposit address');
      const s = await call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      return { status: String(s.status), updatedAt: s.updatedAt };
    },
  };
}

export type FundingService = ReturnType<typeof fundingService>;

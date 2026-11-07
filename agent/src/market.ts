// Small Hyperliquid helpers shared by legs and hedge.
import { HlClient, type HlAsyncSigner, type HlClearinghouseState, type HlHex } from '@perps-platform/core';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, TypedDataDefinition } from 'viem';

/** The domain chain id the hypernear contract signs user-signed actions under (HlClient defaults mainnet to 0xa4b1). */
export const HYPERNEAR_SIGNATURE_CHAIN_ID = '0x66eee' as const;

/** HL API wallet (agent) signer from a raw key: the agent keys are stored by design (legs.ts), unlike master keys. */
export function agentKeySigner(key: Hex): HlAsyncSigner {
  const account = privateKeyToAccount(key);
  return { address: account.address, sign: (payload) => account.signTypedData(payload as TypedDataDefinition) as Promise<HlHex> };
}

export function hlClient(network: 'testnet' | 'mainnet', signers: { master?: HlAsyncSigner; agent?: HlAsyncSigner } = {}) {
  return new HlClient({
    network,
    signatureChainId: HYPERNEAR_SIGNATURE_CHAIN_ID,
    ...(signers.master ? { masterSigner: signers.master } : {}),
    ...(signers.agent ? { agentSigner: signers.agent } : {}),
  });
}

export interface MarketAsset {
  name: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
}

/** What a hedge decision needs to know about the market, captured with the leg states (also the fixture format). */
export interface Market {
  assets: MarketAsset[];
  mids: Record<string, string>;
}

export async function readMarket(hl: HlClient, coins: string[]): Promise<Market> {
  const [meta, mids] = await Promise.all([hl.meta(), hl.allMids()]);
  const assets = meta.universe
    .map((u, asset) => ({ name: u.name, asset, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }))
    .filter((a) => coins.includes(a.name));
  return { assets, mids: Object.fromEntries(coins.filter((c) => mids[c]).map((c) => [c, mids[c]!])) };
}

/** HL perp price rule: <= 5 significant figures and <= (6 - szDecimals) decimals. */
export function roundPx(px: number, szDecimals: number): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  return String(Number(Number(px.toPrecision(5)).toFixed(maxDec)));
}

/** Rounds a size DOWN to szDecimals (never trade more than asked). */
export function floorSize(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return (Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals);
}

export function position(ch: HlClearinghouseState, coin: string) {
  return ch.assetPositions.find((p) => p.position.coin === coin)?.position;
}

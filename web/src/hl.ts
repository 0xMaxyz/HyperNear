// Candles and open orders straight from Hyperliquid's public info API (CORS is open), so the agent needs no new route.
// --dry-run shows recorded candles instead, so the page works with no network and no keys.
import type { Hex } from 'viem';

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface OpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  reduceOnly?: boolean;
}

export const INTERVALS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 } as const;
export type Interval = keyof typeof INTERVALS;

const infoUrl = (network: 'testnet' | 'mainnet') => `https://api.hyperliquid${network === 'testnet' ? '-testnet' : ''}.xyz/info`;

async function info<T>(network: 'testnet' | 'mainnet', body: unknown): Promise<T> {
  const r = await fetch(infoUrl(network), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}`);
  return (await r.json()) as T;
}

export async function liveCandles(network: 'testnet' | 'mainnet', coin: string, interval: Interval, count = 96): Promise<Candle[]> {
  const end = Date.now();
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>(network, {
    type: 'candleSnapshot',
    req: { coin, interval, startTime: end - count * INTERVALS[interval], endTime: end },
  });
  return rows.map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}

export interface RecordedCandles {
  coin: string;
  interval: Interval;
  source: string;
  recordedFor: string;
  candles: Candle[];
}
export async function recordedCandles(): Promise<RecordedCandles> {
  const r = await fetch('/demo/candles-BTC-15m.json');
  if (!r.ok) throw new Error('recorded candles are missing');
  return (await r.json()) as RecordedCandles;
}

export const liveOpenOrders = (network: 'testnet' | 'mainnet', user: Hex) => info<OpenOrder[]>(network, { type: 'openOrders', user });

// Live market data for the Trade terminal straight from Hyperliquid's public WebSocket: order book, trades, candles and the
// asset context (mark, oracle, 24h, open interest, funding). The agent is not in this path: its owner view refreshes every
// 10 s, too slow for a book. --dry-run has no network, so the terminal shows the recorded candles and says the book is live only.
import { useEffect, useRef, useState } from 'react';
import { liveCandles, recordedCandles, type Candle, type Interval } from './hl';

export interface Level {
  px: number;
  sz: number;
  /** cumulative size from the touch */
  total: number;
}
export interface Book {
  bids: Level[];
  asks: Level[];
  time: number;
}
export interface Trade {
  side: 'buy' | 'sell';
  px: number;
  sz: number;
  time: number;
  tid: number;
}
export interface AssetCtx {
  markPx: number;
  oraclePx: number;
  midPx: number | null;
  prevDayPx: number;
  dayNtlVlm: number;
  openInterest: number;
  /** hourly funding rate */
  funding: number;
}
export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'recorded';

export interface Market {
  state: FeedState;
  candles: Candle[];
  book?: Book;
  trades: Trade[];
  ctx?: AssetCtx;
  /** what the chart shows, in words */
  note: string;
  error?: string;
}

const wsUrl = (network: 'testnet' | 'mainnet') => `wss://api.hyperliquid${network === 'testnet' ? '-testnet' : ''}.xyz/ws`;
const BOOK_DEPTH = 14;
const MAX_TRADES = 40;

function levels(rows: { px: string; sz: string }[]): Level[] {
  let total = 0;
  return rows.slice(0, BOOK_DEPTH).map((r) => {
    const sz = Number(r.sz);
    total += sz;
    return { px: Number(r.px), sz, total };
  });
}

/** One socket per (network, coin, interval, grouping); reconnects with backoff, pings every 45 s so HL keeps it open. */
export function useMarket(opts: { network: 'testnet' | 'mainnet'; coin: string; interval: Interval; nSigFigs?: number; recorded: boolean }): Market {
  const { network, coin, interval, nSigFigs, recorded } = opts;
  const [m, setM] = useState<Market>({ state: recorded ? 'recorded' : 'connecting', candles: [], trades: [], note: '' });
  const candlesRef = useRef<Candle[]>([]);

  useEffect(() => {
    let live = true;
    candlesRef.current = [];
    setM({ state: recorded ? 'recorded' : 'connecting', candles: [], trades: [], note: '' });

    if (recorded) {
      recordedCandles().then(
        (r) => live && setM((x) => ({ ...x, candles: r.candles, note: `Recorded ${r.source} candles, ${r.coin} ${r.interval}, from when the fixtures were taken. The order book and trades are live only.` })),
        (e) => live && setM((x) => ({ ...x, error: (e as Error).message })),
      );
      return () => {
        live = false;
      };
    }

    // REST snapshot for history, then the socket keeps the last bar moving
    liveCandles(network, coin, interval, 300).then(
      (c) => {
        if (!live) return;
        candlesRef.current = c;
        setM((x) => ({ ...x, candles: c, note: `Hyperliquid ${network}, ${coin} ${interval}` }));
      },
      (e) => live && setM((x) => ({ ...x, error: `Could not load candles: ${(e as Error).message}` })),
    );

    let ws: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      ws = new WebSocket(wsUrl(network));
      ws.onopen = () => {
        attempt = 0;
        const sub = (subscription: Record<string, unknown>) => ws!.send(JSON.stringify({ method: 'subscribe', subscription }));
        sub({ type: 'l2Book', coin, ...(nSigFigs ? { nSigFigs } : {}) });
        sub({ type: 'trades', coin });
        sub({ type: 'candle', coin, interval });
        sub({ type: 'activeAssetCtx', coin });
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ method: 'ping' })), 45_000);
        live && setM((x) => ({ ...x, state: 'live', error: undefined }));
      };
      ws.onmessage = (ev) => {
        if (!live) return;
        let msg: { channel?: string; data?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.channel) {
          case 'l2Book': {
            const d = msg.data as { coin: string; time: number; levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] };
            if (d.coin !== coin) return;
            setM((x) => ({ ...x, book: { bids: levels(d.levels[0]), asks: levels(d.levels[1]), time: d.time } }));
            return;
          }
          case 'trades': {
            const d = (msg.data as { coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; tid: number }[]).filter((t) => t.coin === coin);
            if (!d.length) return;
            const add = d.map((t) => ({ side: t.side === 'B' ? ('buy' as const) : ('sell' as const), px: Number(t.px), sz: Number(t.sz), time: t.time, tid: t.tid })).reverse();
            setM((x) => ({ ...x, trades: [...add, ...x.trades].slice(0, MAX_TRADES) }));
            return;
          }
          case 'candle': {
            const d = msg.data as { s: string; i: string; t: number; o: string; h: string; l: string; c: string; v: string };
            if (d.s !== coin || d.i !== interval) return;
            const bar: Candle = { t: d.t, o: +d.o, h: +d.h, l: +d.l, c: +d.c, v: +d.v };
            const cs = candlesRef.current;
            const last = cs[cs.length - 1];
            const next = last && last.t === bar.t ? [...cs.slice(0, -1), bar] : !last || bar.t > last.t ? [...cs, bar].slice(-500) : cs;
            candlesRef.current = next;
            setM((x) => ({ ...x, candles: next }));
            return;
          }
          case 'activeAssetCtx': {
            const d = msg.data as { coin: string; ctx: Record<string, string | null> };
            if (d.coin !== coin) return;
            const c = d.ctx;
            setM((x) => ({
              ...x,
              ctx: {
                markPx: Number(c.markPx),
                oraclePx: Number(c.oraclePx),
                midPx: c.midPx === null || c.midPx === undefined ? null : Number(c.midPx),
                prevDayPx: Number(c.prevDayPx),
                dayNtlVlm: Number(c.dayNtlVlm),
                openInterest: Number(c.openInterest),
                funding: Number(c.funding),
              },
            }));
            return;
          }
          default:
        }
      };
      ws.onclose = () => {
        if (ping) clearInterval(ping);
        if (!live) return;
        setM((x) => ({ ...x, state: 'reconnecting' }));
        retry = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      live = false;
      if (ping) clearInterval(ping);
      if (retry) clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [network, coin, interval, nSigFigs, recorded]);

  return m;
}

/** Seconds to the next hourly funding payment (Hyperliquid pays on the hour). */
export const fundingCountdown = (now = Date.now()) => 3600 - Math.floor((now % 3_600_000) / 1000);

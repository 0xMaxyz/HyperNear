// The Trade terminal's panels: market bar, price chart with each leg's lines, order book and trades, the blotter
// (positions grouped by hedge, open orders, TWAP, history, activity) and the selected leg's account and margin health.
// The order ticket itself stays in trade.tsx. Market data comes from Hyperliquid (market.ts); account data from the agent.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { AgentEvent, LegSnap, OwnerView } from './api';
import type { Candle, Interval } from './hl';
import { fundingCountdown, type Book, type FeedState, type Market, type Trade } from './market';
import { clock, pct, pxFmt, signedUsd, tone, when } from './fmt';
import { Paged, useMedia } from './pager';
import { n, summarize, usd } from './panels';
import { PositionsTable, type ProtectTarget } from './positions';
import type { Composite, HistoryRow, LegPosition, OpenOrder, RunningTwap } from './trading';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const compact = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : usd(v));

/* ---------- market bar ---------- */

export type Layout = 'standard' | 'chart' | 'book-left';
const LAYOUTS: { id: Layout; label: string; title: string }[] = [
  { id: 'standard', label: 'Standard', title: 'Chart, book and ticket' },
  { id: 'chart', label: 'Chart focus', title: 'Wider chart, no order book' },
  { id: 'book-left', label: 'Book left', title: 'Order book on the left of the chart' },
];

export function MarketBar({ coin, coins, onCoin, market, fallbackMark, network, layout, onLayout, onHelp }: { coin: string; coins: string[]; onCoin: (c: string) => void; market: Market; fallbackMark: number; network?: string; layout?: Layout; onLayout?: (l: Layout) => void; onHelp?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const c = market.ctx;
  const mark = c?.markPx ?? fallbackMark;
  const change = c && c.prevDayPx > 0 ? (c.markPx - c.prevDayPx) / c.prevDayPx : undefined;
  const left = fundingCountdown();
  const cd = `${String(Math.floor(left / 3600)).padStart(2, '0')}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  return (
    <section className="t-panel t-bar" aria-label="Market">
      <label className="t-coin">
        <span className="sr-only">Market</span>
        <select value={coin} onChange={(e) => onCoin(e.target.value)}>
          {coins.map((x) => <option key={x} value={x}>{x}-USD</option>)}
        </select>
      </label>
      <div className={`t-last ${change !== undefined ? tone(change) : ''}`} aria-label="Mark price">{mark ? pxFmt(mark) : '—'}</div>
      <Stat label="Oracle" value={c ? pxFmt(c.oraclePx) : '—'} />
      <Stat label="24h change" value={c && change !== undefined ? `${signedUsd(c.markPx - c.prevDayPx, 1).replace('$', '')} / ${pct(change)}` : '—'} cls={change !== undefined ? tone(change) : ''} />
      <Stat label="24h volume" value={c ? compact(c.dayNtlVlm) : '—'} />
      <Stat label="Open interest" value={c ? compact(c.openInterest * c.markPx) : '—'} />
      <Stat label="Funding / countdown" value={c ? `${pct(c.funding, 4)} · ${cd}` : `— · ${cd}`} cls={c ? tone(c.funding) : ''} />
      <span className="t-spacer" />
      {onLayout && (
        <div role="group" aria-label="Layout" className="t-seg t-layouts">
          {LAYOUTS.map((l) => <button key={l.id} aria-pressed={layout === l.id} title={l.title} onClick={() => onLayout(l.id)}>{l.label}</button>)}
        </div>
      )}
      {onHelp && <button className="t-keys" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">⌨</button>}
      <FeedChip state={market.state} network={network} />
    </section>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="t-stat">
      <span className="t-stat-l">{label}</span>
      <span className={`t-num ${cls}`}>{value}</span>
    </div>
  );
}

function FeedChip({ state, network }: { state: FeedState; network?: string }) {
  const text = state === 'live' ? `Live · Hyperliquid ${network ?? ''}` : state === 'recorded' ? 'Recorded data' : state === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <span className={`t-chip ${state}`} role="status">
      <span className="t-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/* ---------- chart ---------- */

export interface ChartLine {
  price: number;
  title: string;
  /** a CSS custom property name */
  color: string;
  style: LineStyle;
  /** a resting limit order: its line can be dragged to a new price */
  drag?: { oid: number; leg: number };
}

export const CHART_INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function PriceChart({ candles, lines, interval, onInterval, note, error, fixed, onDrag, overlay }: { candles: Candle[]; lines: ChartLine[]; interval: Interval; onInterval: (i: Interval) => void; note: string; error?: string; fixed: boolean; onDrag?: (line: ChartLine, price: number) => void; overlay?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const dragTo = useRef(onDrag);
  dragTo.current = onDrag;
  const chart = useRef<IChartApi>();
  const bars = useRef<ISeriesApi<'Candlestick'>>();
  const vols = useRef<ISeriesApi<'Histogram'>>();
  const drawn = useRef<IPriceLine[]>([]);
  const seeded = useRef<string>('');
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  // the chart itself: made once per theme
  useEffect(() => {
    if (!box.current) return;
    const line = css('--line');
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--surface') }, textColor: css('--muted'), fontFamily: 'system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: css('--grid') || line }, horzLines: { color: css('--grid') || line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false, minBarSpacing: 0.1 },
      crosshair: { mode: 0 },
    });
    bars.current = c.addSeries(CandlestickSeries, {
      upColor: css('--buy'), borderUpColor: css('--buy'), wickUpColor: css('--buy'),
      downColor: css('--sell'), borderDownColor: css('--sell'), wickDownColor: css('--sell'),
    });
    vols.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    seeded.current = '';
    drawn.current = [];
    // the plot can start narrow (0 wide on the first frame, a wide price axis before the data) and changes on rotate or a
    // layout switch; a fit done at the old width leaves the bars in a strip, so refit when the plot's width really changes
    let width = 0;
    const onSize = (w: number) => {
      if (Math.abs(w - width) > 40) c.timeScale().fitContent();
      width = w;
    };
    c.timeScale().subscribeSizeChange(onSize);
    return () => {
      c.timeScale().unsubscribeSizeChange(onSize);
      c.remove();
      chart.current = undefined;
    };
  }, [theme]);

  // data: a full set when the series changes, one bar update while it streams
  useEffect(() => {
    const s = bars.current;
    const v = vols.current;
    if (!s || !v) return;
    if (candles.length === 0) {
      s.setData([]);
      v.setData([]);
      seeded.current = '';
      return;
    }
    const up = css('--buy');
    const down = css('--sell');
    const toBar = (k: Candle) => ({ time: Math.floor(k.t / 1000) as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c });
    const toVol = (k: Candle) => ({ time: Math.floor(k.t / 1000) as UTCTimestamp, value: k.v, color: `${k.c >= k.o ? up : down}55` });
    const key = `${candles[0]!.t}:${interval}:${theme}`;
    if (seeded.current !== key) {
      s.setData(candles.map(toBar));
      v.setData(candles.map(toVol));
      chart.current?.timeScale().fitContent();
      seeded.current = key;
    } else {
      const last = candles[candles.length - 1]!;
      s.update(toBar(last));
      v.update(toVol(last));
    }
  }, [candles, interval, theme]);

  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    const s = bars.current;
    if (!s) return;
    for (const l of drawn.current) s.removePriceLine(l);
    drawn.current = lines.map((l) => s.createPriceLine({ price: l.price, color: css(l.color), lineStyle: l.style, lineWidth: 1, axisLabelVisible: true, title: l.title }));
  }, [linesKey, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // drag a resting limit order's line: grab within 6 px of it, the chart stops panning, a solid line follows the pointer,
  // and the drop proposes the new price (the page asks before anything is signed)
  useEffect(() => {
    const el = box.current;
    const s = bars.current;
    const c = chart.current;
    if (!el || !s || !c) return;
    const drags = lines.filter((l) => l.drag);
    if (drags.length === 0) return;
    let active: { line: ChartLine; pl: IPriceLine } | null = null;
    const yOf = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;
    const near = (y: number) => drags.find((l) => {
      const cy = s.priceToCoordinate(l.price);
      return cy !== null && Math.abs(cy - y) <= 6;
    });
    const down = (e: PointerEvent) => {
      const l = near(yOf(e));
      if (!l || !dragTo.current) return;
      e.preventDefault();
      e.stopPropagation();
      c.applyOptions({ handleScroll: false, handleScale: false });
      active = { line: l, pl: s.createPriceLine({ price: l.price, color: css('--info'), lineStyle: LineStyle.Solid, lineWidth: 2, axisLabelVisible: true, title: `Move: ${l.title}` }) };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const y = yOf(e);
      if (active) {
        const p = s.coordinateToPrice(y);
        if (p !== null) active.pl.applyOptions({ price: p });
      } else el.style.cursor = near(y) ? 'ns-resize' : '';
    };
    const up = (e: PointerEvent) => {
      if (!active) return;
      const p = s.coordinateToPrice(yOf(e));
      s.removePriceLine(active.pl);
      c.applyOptions({ handleScroll: true, handleScale: true });
      const l = active.line;
      active = null;
      if (p !== null && Math.abs(p - l.price) / l.price > 1e-5) dragTo.current?.(l, p);
    };
    el.addEventListener('pointerdown', down, { capture: true });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true });
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.style.cursor = '';
    };
  }, [linesKey, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = candles[candles.length - 1];
  return (
    <section className="t-panel t-chart" aria-label="Price chart">
      <div className="t-toolbar">
        <div role="group" aria-label="Candle size" className="t-seg">
          {CHART_INTERVALS.map((i) => (
            <button key={i} aria-pressed={interval === i} disabled={fixed && i !== interval} onClick={() => onInterval(i)}>{i}</button>
          ))}
        </div>
        <span className="t-spacer" />
        {last && <span className="t-ohlc t-num">O {pxFmt(last.o)} H {pxFmt(last.h)} L {pxFmt(last.l)} C {pxFmt(last.c)}</span>}
      </div>
      <div className="t-chart-wrap">
        <div className="t-chart-box" ref={box} role="img" aria-label={last ? `${note}: ${candles.length} candles, last close ${pxFmt(last.c)}` : 'No candles yet'} />
        {overlay}
      </div>
      {error && <p className="t-note err" role="alert">{error}</p>}
      <p className="t-note">{note}{lines.length > 0 ? ' · Lines: solid entry, dashed liquidation, dotted resting orders' : ''}{lines.some((l) => l.drag) ? ' (drag a limit order to move it)' : ''}.</p>
    </section>
  );
}

/* ---------- order book and trades ---------- */

export function BookPanel({ book, trades, mark, coin, recorded, grouping, onGrouping, onPrice, tab: shown, onTab }: { book?: Book; trades: Trade[]; mark: number; coin: string; recorded: boolean; grouping: number; onGrouping: (g: number) => void; onPrice: (px: number) => void; tab?: 'book' | 'trades'; onTab?: (t: 'book' | 'trades') => void }) {
  // controlled by the phone's Chart | Book | Trades switch when given, otherwise its own
  const [own, setOwn] = useState<'book' | 'trades'>('book');
  const tab = shown ?? own;
  const setTab = (t: 'book' | 'trades') => (onTab ? onTab(t) : setOwn(t));
  const max = book ? Math.max(book.bids[book.bids.length - 1]?.total ?? 0, book.asks[book.asks.length - 1]?.total ?? 0) : 0;
  const bestBid = book?.bids[0]?.px;
  const bestAsk = book?.asks[0]?.px;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : undefined;
  const row = (l: { px: number; sz: number; total: number }, side: 'bid' | 'ask') => (
    <li key={`${side}${l.px}`}>
      <button className={`t-lvl ${side}`} onClick={() => onPrice(l.px)} aria-label={`${side === 'bid' ? 'Bid' : 'Ask'} ${pxFmt(l.px)}, size ${l.sz}. Use this price`}>
        <span className="t-depth" style={{ width: `${max ? (l.total / max) * 100 : 0}%` }} aria-hidden="true" />
        <span className="t-num px">{pxFmt(l.px)}</span>
        <span className="t-num">{l.sz.toFixed(4)}</span>
        <span className="t-num muted">{l.total.toFixed(4)}</span>
      </button>
    </li>
  );
  return (
    <section className="t-panel t-book" aria-label="Order book and trades">
      <div className="t-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'book'} onClick={() => setTab('book')}>Order book</button>
        <button role="tab" aria-selected={tab === 'trades'} onClick={() => setTab('trades')}>Trades</button>
        <span className="t-spacer" />
        {tab === 'book' && (
          <label className="t-group">
            <span className="sr-only">Group prices</span>
            <select value={grouping} onChange={(e) => onGrouping(Number(e.target.value))} disabled={recorded}>
              <option value={5}>Finest</option>
              <option value={4}>Coarser</option>
              <option value={3}>Coarsest</option>
            </select>
          </label>
        )}
      </div>
      {recorded ? (
        <p className="t-empty">The order book and trades are live only. Recorded data has neither; the mark is {pxFmt(mark)}.</p>
      ) : tab === 'book' ? (
        !book ? (
          <p className="t-empty">Reading the {coin} book…</p>
        ) : (
          <div className="t-ladder">
            <div className="t-lvl head" aria-hidden="true"><span>Price</span><span>Size ({coin})</span><span>Total</span></div>
            <ol className="asks">{book.asks.slice().reverse().map((l) => row(l, 'ask'))}</ol>
            <div className="t-mid">
              <span className="t-num">{pxFmt(mark)}</span>
              <span className="muted">{spread !== undefined ? `Spread ${pxFmt(spread)} · ${((spread / mark) * 100).toFixed(3)}%` : ''}</span>
            </div>
            <ol className="bids">{book.bids.map((l) => row(l, 'bid'))}</ol>
          </div>
        )
      ) : trades.length === 0 ? (
        <p className="t-empty">Waiting for {coin} trades…</p>
      ) : (
        <ol className="t-trades">
          <li className="head" aria-hidden="true"><span>Price</span><span>Size</span><span>Time</span></li>
          {trades.map((t) => (
            <li key={t.tid}>
              <span className={`t-num ${t.side === 'buy' ? 'up' : 'down'}`}>{pxFmt(t.px)}<span className="sr-only"> {t.side}</span></span>
              <span className="t-num">{t.sz}</span>
              <span className="t-num muted">{clock(t.time)}</span>
            </li>
          ))}
        </ol>
      )}
      {!recorded && <p className="t-note">Click a price to put it in the ticket.</p>}
    </section>
  );
}

/* ---------- blotter ---------- */

type BlotterTab = 'positions' | 'orders' | 'twap' | 'history' | 'activity';
const KIND_TEXT: Record<HistoryRow['kind'], string> = { 'hedge-open': 'Hedge', 'hedge-close': 'Hedge', open: 'One-sided', reduce: 'One-sided', protect: 'Protective', strategy: 'Strategy', twap: 'TWAP', external: 'Outside', funding: 'Funding', transfer: 'Transfer' };
const KIND_CLASS: Partial<Record<HistoryRow['kind'], string>> = { 'hedge-open': 'info', 'hedge-close': 'info', protect: 'warn', strategy: 'violet', twap: 'violet' };

export interface BlotterProps {
  positions?: Composite[];
  orders?: { orders: OpenOrder[]; twaps: RunningTwap[] };
  history?: HistoryRow[];
  events: AgentEvent[];
  coin: string;
  legs: number[];
  locked: boolean;
  why?: string;
  decimals: (coin: string) => number;
  onReduce: (p: LegPosition, frac: number) => void;
  onCloseHedge: (c: Composite) => void;
  onTpsl: (t: ProtectTarget) => void;
  onLimit: (p: LegPosition) => void;
  maxLev?: (coin: string) => number | undefined;
  onCancel: (o: OpenOrder | RunningTwap) => void;
  onCancelAll: (pairs: { leg: number; coin: string }[]) => void;
}

export function Blotter(p: BlotterProps) {
  const [tab, setTab] = useState<BlotterTab>('positions');
  const [leg, setLeg] = useState<'all' | number>('all');
  const [onlyCoin, setOnlyCoin] = useState(false);
  // wide screens: the dock has a fixed share of the viewport and pages its tables to fit it
  const fit = useMedia('(min-width: 1281px)');
  const keep = (l: number, c: string) => (leg === 'all' || l === leg) && (!onlyCoin || c === p.coin);

  const comps = (p.positions ?? []).map((c) => ({ ...c, legs: c.legs.filter((l) => keep(l.leg, l.coin)) })).filter((c) => c.legs.length > 0);
  const orders = (p.orders?.orders ?? []).filter((o) => keep(o.leg, o.coin));
  const twaps = (p.orders?.twaps ?? []).filter((t) => keep(t.leg, t.coin));
  const hist = (p.history ?? []).filter((r) => (leg === 'all' || r.legs.includes(leg)) && (!onlyCoin || !r.coin || r.coin === p.coin));
  const legCount = comps.reduce((s, c) => s + c.legs.length, 0);
  const totals = comps.reduce((t, c) => ({ u: t.u + c.totals.unrealized, r: t.r + c.totals.realized, f: t.f + c.totals.fees, fu: t.fu + c.totals.funding, net: t.net + c.totals.netIfClosed }), { u: 0, r: 0, f: 0, fu: 0, net: 0 });

  const tabs: { id: BlotterTab; label: string; count?: number }[] = [
    { id: 'positions', label: 'Positions', count: legCount },
    { id: 'orders', label: 'Open orders', count: orders.length },
    { id: 'twap', label: 'TWAP', count: twaps.length },
    { id: 'history', label: 'Trade history' },
    { id: 'activity', label: 'Activity' },
  ];
  const pairs = [...new Map(orders.map((o) => [`${o.leg}:${o.coin}`, { leg: o.leg, coin: o.coin }])).values()];

  return (
    <section className="t-panel t-blotter" aria-label="Positions and orders">
      <div className="t-tabs wrap">
        <div role="tablist" aria-label="Blotter" className="t-tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="t-count">{t.count}</span> : null}
            </button>
          ))}
        </div>
        <span className="t-spacer" />
        <label className="t-filter">
          <span className="sr-only">Legs</span>
          <select value={String(leg)} onChange={(e) => setLeg(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All legs</option>
            {p.legs.map((l) => <option key={l} value={l}>Leg {l}</option>)}
          </select>
        </label>
        <label className="t-check"><input type="checkbox" checked={onlyCoin} onChange={(e) => setOnlyCoin(e.target.checked)} /> Only {p.coin}</label>
        {tab === 'orders' && orders.length > 0 && (
          <button disabled={p.locked} title={p.why} onClick={() => p.onCancelAll(pairs)}>Cancel all</button>
        )}
      </div>

      <div className="t-scroll">
        {tab === 'positions' &&
          (!p.positions ? <p className="t-empty">Reading positions…</p> : comps.length === 0 ? <p className="t-empty">No open positions{leg !== 'all' ? ` on leg ${leg}` : ''}. Place an order from the ticket, or open a hedge.</p> : (
            <>
              <PositionsTable comps={comps} fit={fit} locked={p.locked} why={p.why} decimals={p.decimals} maxLev={p.maxLev} onReduce={p.onReduce} onCloseHedge={p.onCloseHedge} onTpsl={p.onTpsl} onLimit={p.onLimit} />
              <p className="t-totals">
                <span>Unrealized <b className={`t-num ${tone(totals.u)}`}>{signedUsd(totals.u)}</b></span>
                <span>Realized <b className="t-num">{signedUsd(totals.r)}</b></span>
                <span>Fees <b className="t-num">{signedUsd(-totals.f)}</b></span>
                <span>Funding <b className="t-num">{signedUsd(totals.fu)}</b></span>
                <span>Net if all closed now <b className={`t-num ${tone(totals.net)}`}>{signedUsd(totals.net)}</b></span>
              </p>
            </>
          ))}
        {tab === 'orders' &&
          (!p.orders ? <p className="t-empty">Reading open orders…</p> : orders.length === 0 ? <p className="t-empty">Nothing is resting{leg !== 'all' ? ` on leg ${leg}` : ''}. A freeze cancels resting orders, protective ones included.</p> : (
            <Paged items={orders} fit={fit} fallbackRows={8} reservedPx={34}>{(pg) => (
            <>
            <ul className="t-cards phone">
              {pg.map((o) => (
                <li key={o.oid} className="t-pcard">
                  <div className="t-pcard-top">
                    <span className="t-leg">Leg {o.leg}</span>
                    <b>{o.coin}</b>
                    <span className={o.side === 'buy' ? 'up' : 'down'}>{o.orderType} {o.side}</span>
                    <span className="t-spacer" />
                    <button disabled={p.locked} title={p.why} onClick={() => p.onCancel(o)}>Cancel</button>
                  </div>
                  <div className="t-pcard-row t-num muted">
                    <span>{o.isPositionTpsl ? 'Position' : o.size}</span>
                    <span>@ {o.isTrigger && o.orderType.includes('Market') ? 'Market' : pxFmt(Number(o.limitPx))}</span>
                    {o.isTrigger && Number(o.triggerPx) > 0 && <span>trigger {pxFmt(Number(o.triggerPx))}</span>}
                  </div>
                </li>
              ))}
            </ul>
            <table className="t-table desk">
              <thead><tr><th>Leg</th><th>Placed</th><th>Coin</th><th>Type</th><th className="num">Size</th><th className="num">Price</th><th className="num">Trigger</th><th>Flags</th><th className="end" /></tr></thead>
              <tbody>
                {pg.map((o) => (
                  <tr key={o.oid}>
                    <td><span className="t-leg">Leg {o.leg}</span></td>
                    <td className="t-num muted">{when(o.placedAt)}</td>
                    <td><b>{o.coin}</b></td>
                    <td className={o.side === 'buy' ? 'up' : 'down'}>{o.orderType} {o.side}</td>
                    <td className="num t-num">{o.isPositionTpsl ? 'Position' : o.size}</td>
                    <td className="num t-num">{o.isTrigger && o.orderType.includes('Market') ? 'Market' : pxFmt(Number(o.limitPx))}</td>
                    <td className="num t-num">{o.isTrigger && Number(o.triggerPx) > 0 ? `${o.triggerCondition || ''} ${pxFmt(Number(o.triggerPx))}`.trim() : '—'}</td>
                    <td className="muted">{[o.isPositionTpsl && 'Follows position', o.reduceOnly && 'Reduce only', o.label].filter(Boolean).join(' · ')}</td>
                    <td className="end"><button disabled={p.locked} title={p.why} onClick={() => p.onCancel(o)}>Cancel</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
            )}</Paged>
          ))}

        {tab === 'twap' &&
          (twaps.length === 0 ? <p className="t-empty">No TWAP is running. Start one from the ticket's Pro menu.</p> : (
            <Paged items={twaps} fit={fit} fallbackRows={8} reservedPx={34}>{(pg) => (
            <table className="t-table">
              <thead><tr><th>Leg</th><th>Started</th><th>Coin</th><th>Side</th><th className="num">Done</th><th className="num">Minutes</th><th className="end" /></tr></thead>
              <tbody>
                {pg.map((t) => (
                  <tr key={t.twapId}>
                    <td><span className="t-leg">Leg {t.leg}</span></td>
                    <td className="t-num muted">{when(t.startedAt)}</td>
                    <td><b>{t.coin}</b></td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side}</td>
                    <td className="num t-num">{t.executedSize} of {t.size}</td>
                    <td className="num t-num">{t.minutes}</td>
                    <td className="end"><button disabled={p.locked} title={p.why} onClick={() => p.onCancel(t)}>Stop</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}</Paged>
          ))}

        {tab === 'history' &&
          (!p.history ? <p className="t-empty">Reading history…</p> : hist.length === 0 ? <p className="t-empty">Nothing here yet.</p> : (
            <Paged items={hist} fit={fit} fallbackRows={10} reservedPx={34} resetKey={`${leg}${onlyCoin}`}>{(pg) => (
            <table className="t-table">
              <thead><tr><th>When</th><th>Legs</th><th>Label</th><th>What happened</th><th className="num">Size</th><th className="num">Price</th><th className="num">Result</th></tr></thead>
              <tbody>
                {pg.map((r, i) => (
                  <tr key={`${r.time}-${i}`}>
                    <td className="t-num muted">{when(r.time)}</td>
                    <td>{r.legs.map((l) => <span key={l} className="t-leg">Leg {l}</span>)}</td>
                    <td><span className={`t-tag ${KIND_CLASS[r.kind] ?? ''}`}>{KIND_TEXT[r.kind]}</span></td>
                    <td>{r.label}</td>
                    <td className={`num t-num ${r.side === 'buy' ? 'up' : r.side === 'sell' ? 'down' : ''}`}>{r.size ? n(r.size, 5) : ''}</td>
                    <td className="num t-num">{r.px ? pxFmt(r.px) : ''}</td>
                    <td className="num t-num">{r.kind === 'funding' || r.kind === 'transfer' ? signedUsd(r.amount ?? 0, 4) : r.closedPnl ? signedUsd(r.closedPnl - (r.fee ?? 0), 4) : r.fee ? signedUsd(-r.fee, 4) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}</Paged>
          ))}

        {tab === 'activity' &&
          (p.events.length === 0 ? <p className="t-empty">No events yet. Orders, guard checks and rebalances appear here as the agent emits them.</p> : (
            <Paged items={p.events} fit={fit} fallbackRows={10} reservedPx={4}>{(pg) => (
            <ol className="t-events">
              {pg.map((e) => (
                <li key={e.id} className={e.type.startsWith('guard.trigger') || e.type === 'guard.error' ? 'flag' : ''}>
                  <time className="t-num muted" dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
                  <span className="t-tag">{e.type}</span>
                  <span>{summarize(e)}</span>
                </li>
              ))}
            </ol>
            )}</Paged>
          ))}
      </div>
    </section>
  );
}

/* ---------- the selected leg's account ---------- */

export function LegAccount({ leg, snap, guardFloor, onGo }: { leg: number; snap?: LegSnap; guardFloor: number; onGo: (to: string) => void }) {
  const ch = snap?.clearinghouse;
  const value = Number(ch?.marginSummary.accountValue ?? 0);
  const maint = Number(ch?.crossMaintenanceMarginUsed ?? 0);
  const unreal = (ch?.assetPositions ?? []).reduce((s, a) => s + Number(a.position.unrealizedPnl), 0);
  const ratio = maint > 0 ? value / maint : Infinity;
  // the bar spans 1x (liquidation) to 10x maintenance; the marker is where the guard tops the leg up
  const span = (x: number) => Math.max(0, Math.min(1, (x - 1) / 9)) * 100;
  const state = ratio === Infinity ? 'No margin in use' : ratio <= guardFloor ? 'At the guard line' : ratio <= guardFloor * 2 ? 'Watch' : 'Healthy';
  const cls = ratio <= guardFloor ? 'down' : ratio <= guardFloor * 2 ? 'warn' : 'up';
  return (
    <section className="t-panel t-account" aria-labelledby="acct-h">
      <div className="t-head">
        <h2 id="acct-h">Leg {leg} account</h2>
        <span className="muted small">{snap ? `${snap.address.slice(0, 6)}…${snap.address.slice(-4)}` : ''}</span>
      </div>
      {!snap ? <p className="t-empty">Leg {leg} has no data yet.</p> : (
        <>
          <dl className="t-kv">
            <dt>Equity</dt><dd className="t-num">{usd(value)}</dd>
            <dt>Withdrawable</dt><dd className="t-num">{usd(ch?.withdrawable)}</dd>
            {snap.abstraction !== 'unifiedAccount' && <><dt>Spot USDC (not trading)</dt><dd className="t-num">{usd(snap.spotUsdc)}</dd></>}
            <dt>Unrealized PnL</dt><dd className={`t-num ${tone(unreal)}`}>{signedUsd(unreal)}</dd>
          </dl>
          <div className="t-health">
            <div className="t-health-l"><span className="muted">Margin health</span><span className={cls}>{state}{ratio !== Infinity ? ` · ${ratio.toFixed(1)}× maint.` : ''}</span></div>
            <div className="t-meter" aria-hidden="true">
              <span className={`t-fill ${cls}`} style={{ width: `${ratio === Infinity ? 100 : span(ratio)}%` }} />
              <span className="t-mark" style={{ left: `${span(guardFloor)}%` }} />
            </div>
            <p className="muted small">The guard moves USDC in from a healthier leg at {guardFloor}× maintenance.</p>
          </div>
          <div className="t-actions three">
            <button onClick={() => onGo(`fund?leg=${leg}`)}>Deposit</button>
            <button onClick={() => onGo(`legs`)}>Move</button>
            <button onClick={() => onGo(`fund?leg=${leg}`)}>Withdraw</button>
          </div>
        </>
      )}
    </section>
  );
}

/** Each leg's entry, liquidation and resting orders on this coin, as chart lines. */
export function chartLines(view: OwnerView | undefined, coin: string, orders?: OpenOrder[]): ChartLine[] {
  const out: ChartLine[] = [];
  for (const l of view?.snapshot.legs ?? []) {
    for (const { position: p } of l.clearinghouse.assetPositions) {
      if (p.coin !== coin || Number(p.szi) === 0) continue;
      const long = Number(p.szi) > 0;
      out.push({ price: Number(p.entryPx), title: `Leg ${l.leg} ${long ? 'long' : 'short'} ${Math.abs(Number(p.szi))}`, color: long ? '--buy' : '--sell', style: LineStyle.Solid });
      if (p.liquidationPx) out.push({ price: Number(p.liquidationPx), title: `Leg ${l.leg} liq.`, color: '--accent', style: LineStyle.Dashed });
    }
  }
  for (const o of orders ?? []) {
    if (o.coin !== coin) continue;
    const price = o.isTrigger && Number(o.triggerPx) > 0 ? Number(o.triggerPx) : Number(o.limitPx);
    const movable = o.orderType === 'Limit' && !o.isTrigger;
    if (price > 0) out.push({ price, title: `Leg ${o.leg} ${o.orderType} ${o.side}`, color: '--info', style: LineStyle.Dotted, ...(movable ? { drag: { oid: o.oid, leg: o.leg } } : {}) });
  }
  return out;
}

import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, LineStyle, createChart, type UTCTimestamp } from 'lightweight-charts';
import type { OwnerView } from './api';
import { INTERVALS, liveCandles, liveOpenOrders, recordedCandles, type Candle, type Interval, type OpenOrder } from './hl';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const px = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

interface Line {
  price: number;
  title: string;
  /** a CSS custom property, resolved when the chart is drawn so a colour-scheme change is picked up */
  color: string;
  style: LineStyle;
}

function Chart({ candles, lines, summary }: { candles: Candle[]; lines: Line[]; summary: string }) {
  const box = useRef<HTMLDivElement>(null);
  const linesKey = JSON.stringify(lines);
  const [scheme, setScheme] = useState(0); // bumps when the colour scheme changes, so the chart is redrawn with the new tokens
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const bump = () => setScheme((n) => n + 1);
    m.addEventListener('change', bump);
    return () => m.removeEventListener('change', bump);
  }, []);
  useEffect(() => {
    if (!box.current || candles.length === 0) return;
    const ink = css('--ink');
    const line = css('--line');
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--surface') }, textColor: ink, fontFamily: 'system-ui, sans-serif' },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
    });
    // up candles are hollow, down candles filled: direction does not depend on colour alone
    const series = chart.addSeries(CandlestickSeries, {
      upColor: css('--surface'),
      borderUpColor: css('--ok'),
      wickUpColor: css('--ok'),
      downColor: css('--accent'),
      borderDownColor: css('--accent'),
      wickDownColor: css('--accent'),
      priceLineVisible: false,
    });
    series.setData(candles.map((c) => ({ time: Math.floor(c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    for (const l of lines) series.createPriceLine({ price: l.price, color: css(l.color), lineStyle: l.style, lineWidth: 1, axisLabelVisible: true, title: l.title });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, linesKey, scheme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} className="chart" role="img" aria-label={summary} />;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

export function LegPanel({ view, demo }: { view?: OwnerView; demo: boolean }) {
  const legs = view?.snapshot.legs ?? [];
  const network = view?.config?.hlNetwork ?? 'testnet';
  const coins = view?.orderPolicy.allowedCoins ?? ['BTC'];
  const [leg, setLeg] = useState<number>();
  const [coin, setCoin] = useState('BTC');
  const [interval, setInterval_] = useState<Interval>('15m');
  const dry = Boolean(view?.dryRun);
  const active = legs.find((l) => l.leg === leg) ?? legs.find((l) => l.clearinghouse.assetPositions.some((p) => Number(p.position.szi) !== 0)) ?? legs[0];

  const [candles, setCandles] = useState<Load<{ candles: Candle[]; note: string }>>({ state: 'loading' });
  useEffect(() => {
    if (!view) return;
    let live = true;
    setCandles({ state: 'loading' });
    const load = dry
      ? recordedCandles().then((r) => ({ candles: r.candles, note: `Recorded ${r.source} candles, ${r.coin} ${r.interval}, for the time the fixtures were taken.` }))
      : liveCandles(network, coin, interval).then((c) => ({ candles: c, note: `Hyperliquid ${network} candles, ${coin} ${interval}.` }));
    load.then(
      (data) => live && setCandles({ state: 'ok', data }),
      (e) => live && setCandles({ state: 'error', message: `Could not load candles: ${(e as Error).message}` })
    );
    return () => {
      live = false;
    };
  }, [view === undefined, dry, network, coin, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  const [orders, setOrders] = useState<Load<OpenOrder[]>>({ state: 'loading' });
  const addr = active?.address;
  useEffect(() => {
    if (!addr) return;
    if (dry) return setOrders({ state: 'ok', data: [] });
    let live = true;
    const read = () =>
      liveOpenOrders(network, addr).then(
        (data) => live && setOrders({ state: 'ok', data }),
        (e) => live && setOrders({ state: 'error', message: `Could not load open orders: ${(e as Error).message}` })
      );
    setOrders({ state: 'loading' });
    void read();
    const t = window.setInterval(read, 15_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [addr, dry, network]);

  if (!view || legs.length === 0 || !active) {
    return (
      <section className="card wide" aria-labelledby="leg-h">
        <h2 id="leg-h">Leg detail</h2>
        <p className="state">{view ? 'Register legs first. Each leg gets its own chart, positions and orders here.' : demo ? 'Waiting for data.' : 'Log in to see a leg.'}</p>
      </section>
    );
  }

  const positions = active.clearinghouse.assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);
  const shown = positions.find((p) => p.coin === coin);
  const lines: Line[] = [];
  if (shown) {
    lines.push({ price: Number(shown.entryPx), title: 'entry', color: '--ink', style: LineStyle.Dashed });
    if (shown.liquidationPx) lines.push({ price: Number(shown.liquidationPx), title: 'liquidation', color: '--accent', style: LineStyle.Solid });
  }
  const mine = orders.state === 'ok' ? orders.data.filter((o) => o.coin === coin) : [];
  for (const o of mine) lines.push({ price: Number(o.limitPx), title: `${o.side === 'B' ? 'buy' : 'sell'} ${o.sz}`, color: '--muted', style: LineStyle.Dotted });
  const cs = candles.state === 'ok' ? candles.data.candles : [];
  const last = cs.at(-1);
  const summary = last ? `${coin} ${dry ? '15m' : interval} candles, ${cs.length} bars, last close ${px(last.c)}, range ${px(Math.min(...cs.map((c) => c.l)))} to ${px(Math.max(...cs.map((c) => c.h)))}` : 'No candles';

  return (
    <section className="card wide" aria-labelledby="leg-h">
      <h2 id="leg-h">Leg detail</h2>
      <div className="leg-controls">
        <fieldset className="mode">
          <legend>Leg</legend>
          {legs.map((l) => (
            <label key={l.leg} className={active.leg === l.leg ? 'on' : ''}>
              <input type="radio" name="leg" checked={active.leg === l.leg} onChange={() => setLeg(l.leg)} />
              Leg {l.leg}
            </label>
          ))}
        </fieldset>
        <label>
          Coin
          <select value={coin} onChange={(e) => setCoin(e.target.value)} disabled={dry}>
            {coins.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>
          Candle
          <select value={dry ? '15m' : interval} onChange={(e) => setInterval_(e.target.value as Interval)} disabled={dry}>
            {Object.keys(INTERVALS).map((i) => <option key={i}>{i}</option>)}
          </select>
        </label>
      </div>
      {candles.state === 'loading' && <p className="state">Loading candles…</p>}
      {candles.state === 'error' && <p className="state err" role="alert">{candles.message}</p>}
      {candles.state === 'ok' && (cs.length === 0 ? <p className="state">No candles for {coin} in this window.</p> : <Chart candles={cs} lines={lines} summary={summary} />)}
      {candles.state === 'ok' && <p className="muted small">{candles.data.note} {dry && 'Coin and candle size are fixed in dry-run. '}Lines: dashed entry, solid liquidation, dotted resting orders.</p>}

      <div className="two">
        <div>
          <h3>Positions on leg {active.leg}</h3>
          {positions.length === 0 ? (
            <p className="state">Flat. Account value ${Number(active.clearinghouse.marginSummary.accountValue).toFixed(2)}, withdrawable ${Number(active.clearinghouse.withdrawable).toFixed(2)}.</p>
          ) : (
            <div className="scroll">
              <table className="mini">
                <thead>
                  <tr><th>Coin</th><th className="num">Size</th><th className="num">Entry</th><th className="num">Liquidation</th><th className="num">Unrealized</th></tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.coin}>
                      <td data-label="Coin">{p.coin} {Number(p.szi) > 0 ? 'long' : 'short'} {p.leverage.value}x</td>
                      <td data-label="Size" className="num">{Math.abs(Number(p.szi))}</td>
                      <td data-label="Entry" className="num">{px(Number(p.entryPx))}</td>
                      <td data-label="Liquidation" className="num">{p.liquidationPx ? px(Number(p.liquidationPx)) : 'none'}</td>
                      <td data-label="Unrealized" className="num">{px(Number(p.unrealizedPnl))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3>Open orders on leg {active.leg}</h3>
          {orders.state === 'loading' && <p className="state">Reading open orders…</p>}
          {orders.state === 'error' && <p className="state err" role="alert">{orders.message}</p>}
          {orders.state === 'ok' && orders.data.length === 0 && <p className="state">{dry ? 'The recorded fixtures hold no open orders.' : 'No resting orders on this leg.'}</p>}
          {orders.state === 'ok' && orders.data.length > 0 && (
            <div className="scroll">
              <table className="mini">
                <thead>
                  <tr><th>Coin</th><th>Side</th><th className="num">Size</th><th className="num">Price</th></tr>
                </thead>
                <tbody>
                  {orders.data.map((o) => (
                    <tr key={o.oid}>
                      <td data-label="Coin">{o.coin}</td>
                      <td data-label="Side">{o.side === 'B' ? 'buy' : 'sell'}{o.reduceOnly ? ', reduce-only' : ''}</td>
                      <td data-label="Size" className="num">{o.sz}</td>
                      <td data-label="Price" className="num">{px(Number(o.limitPx))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

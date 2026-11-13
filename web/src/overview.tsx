// Overview tab: what is open now as the owner thinks of it (a hedge of two legs, a one-sided trade), what it has earned or cost line by line,
// tools to shrink or close it, a PnL-over-time chart and the labelled trade history. Numbers come from the agent (agent/src/positions.ts).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ColorType, LineSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import type { Hex } from 'viem';
import type { OwnerView } from './api';
import { n, usd } from './panels';
import { getHistory, getPositions, placeOrder, reduceSpec, type Composite, type HistoryRow, type LegPosition, type Sign } from './trading';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const signed = (v: number, dp = 4) => `${v < 0 ? '-' : '+'}${usd(Math.abs(v), dp)}`;
const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (t: number | null) => {
  if (!t) return 'opening time unknown';
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 90 ? `open ${m} min` : m < 2880 ? `open ${Math.round(m / 60)} h` : `open ${Math.round(m / 1440)} days`;
};
const utcHour = (t: number) => `${String(new Date(t).getUTCHours()).padStart(2, '0')}:00 UTC`;

export interface OverviewProps {
  view?: OwnerView;
  owner: Hex;
  canSign: boolean;
  locked: boolean;
  why?: string;
  sign: Sign;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  done: (out: Record<string, unknown>, what: string) => string;
  onCloseHedge: (coin: string) => void;
  onGo: (to: string) => void;
}

/** PnL over time: realized steps from the history (price result - fees + funding), then today's open PnL on top. */
export function pnlSeries(rows: HistoryRow[], openPnl: number): { t: number; v: number }[] {
  const steps = rows.filter((r) => r.kind !== 'transfer').sort((a, b) => a.time - b.time);
  let sum = 0;
  const pts = steps.map((r) => {
    sum += (r.closedPnl ?? 0) - (r.fee ?? 0) + (r.kind === 'funding' ? (r.amount ?? 0) : 0);
    return { t: r.time, v: sum };
  });
  return pts.length ? [...pts, { t: Date.now(), v: sum + openPnl }] : [];
}

function PnlChart({ points }: { points: { t: number; v: number }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(points);
  useEffect(() => {
    if (!box.current || points.length < 2) return;
    const line = css('--line');
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--surface') }, textColor: css('--ink'), fontFamily: 'system-ui, sans-serif' },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
    });
    const s = chart.addSeries(LineSeries, { color: css('--ink'), lineWidth: 2, priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } });
    // lightweight-charts wants strictly increasing seconds
    let last = 0;
    s.setData(
      points
        .filter((p) => Number.isFinite(p.v))
        .map((p) => {
          last = Math.max(last + 1, Math.floor(p.t / 1000));
          return { time: last as UTCTimestamp, value: p.v };
        }),
    );
    s.createPriceLine({ price: 0, color: css('--muted'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = points[0];
  const lastP = points.at(-1);
  return <div ref={box} className="chart" role="img" aria-label={points.length < 2 ? 'No PnL history yet' : `PnL since ${first ? when(first.t) : ''}: ${lastP ? signed(lastP.v) : ''}`} />;
}

/** Trading fees by component. Rate is amount / notional of those fills, so a fee tier or discount shows in it. */
function FeeTable({ c }: { c: Composite }) {
  const t = c.totals;
  const rows = (lines: Composite['totals']['feeLines']) =>
    lines.map((l) => (
      <tr key={l.label}>
        <td>{l.label}</td>
        <td className="num">{l.fills}</td>
        <td className="num">{usd(l.notional)}</td>
        <td className="num">{l.ratePct.toFixed(4)}%</td>
        <td className="num">{signed(-l.amount, 4)}</td>
      </tr>
    ));
  return (
    <details className="fees">
      <summary>Fee components</summary>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Component</th><th className="num">Fills</th><th className="num">Traded</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {c.legs.length > 1 && c.legs.map((l) => l.feeLines.length > 0 && (
              <FragmentRows key={l.leg} head={`Leg ${l.leg}`}>{rows(l.feeLines)}</FragmentRows>
            ))}
            {c.legs.length > 1 ? null : rows(t.feeLines)}
            <tr className="total"><td><b>Paid so far</b></td><td className="num">{t.feeLines.reduce((s, l) => s + l.fills, 0)}</td><td className="num">{usd(t.feeLines.reduce((s, l) => s + l.notional, 0))}</td><td /><td className="num"><b>{signed(-t.fees, 4)}</b></td></tr>
            <tr className="est"><td>Closing everything now (estimate)</td><td /><td className="num">{usd(c.legs.reduce((s, l) => s + l.size * l.markPx, 0))}</td><td className="num">{t.closeRatePct.toFixed(4)}%</td><td className="num">{signed(-t.closeFeesEst, 4)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="muted small">Taker fees are paid when an order takes liquidity, maker fees when it rests on the book first. Funding and the one-off account setup fee are shown above, not in here.</p>
    </details>
  );
}
function FragmentRows({ head, children }: { head: string; children: ReactNode }) {
  return (
    <>
      <tr className="sub"><td colSpan={5} className="muted small">{head}</td></tr>
      {children}
    </>
  );
}

function Pnl({ c }: { c: Composite }) {
  const t = c.totals;
  const hedge = c.kind === 'hedge';
  const countdown = Math.max(0, Math.round((c.nextFundingAt - Date.now()) / 60_000));
  return (
    <>
      <dl className="kv">
        <dt>Price result so far (realized)</dt><dd>{signed(t.realized)}</dd>
        <dt>Open profit or loss (unrealized)</dt><dd>{signed(t.unrealized)}</dd>
        <dt>Trading fees paid</dt><dd>{signed(-t.fees)}</dd>
        <dt>Funding received or paid</dt><dd>{signed(t.funding)}</dd>
        <dt>Account setup fee (one-off per leg)</dt><dd>{signed(-t.activationFee, 2)}</dd>
        <dt>Position PnL</dt><dd className="big">{signed(t.pnl)}</dd>
        <dt>Closing fees (estimate)</dt><dd>{signed(-t.closeFeesEst)}</dd>
        <dt>Net if closed now (estimate)</dt><dd>{signed(t.netIfClosed)}</dd>
      </dl>
      <FeeTable c={c} />
      <p className="muted small">
        Next funding in {countdown} min, at {utcHour(c.nextFundingAt)}: about {signed(t.nextFundingEstimate)} {hedge ? `net of both legs (${c.legs.map((l) => `leg ${l.leg} ${signed(l.nextFundingEstimate, 5)}`).join(', ')}). A balanced hedge pays and receives almost the same, so this stays close to zero.` : `for this ${c.legs[0]?.side}. A long pays when the hourly rate is positive and a short receives it.`}
      </p>
    </>
  );
}

function LegRow({ p, szDecimals, maxLev, locked, why, onReduce }: { p: LegPosition; szDecimals: number; maxLev?: number; locked: boolean; why?: string; onReduce: (frac: number) => void }) {
  const [frac, setFrac] = useState('1');
  return (
    <tr>
      <td>{p.leg}</td>
      <td>{p.side} {n(p.size, szDecimals)}<br /><span className="muted small">{p.leverage.value}x {p.leverage.type}{maxLev ? `, max ${maxLev}x` : ''}</span></td>
      <td className="num">{usd(p.entryPx)}<br /><span className="muted small">mark {usd(p.markPx)}</span></td>
      <td className="num">{p.liquidationPx === null ? 'none' : usd(p.liquidationPx)}</td>
      <td className="num">{signed(p.unrealized, 4)}</td>
      <td>
        <select value={frac} onChange={(e) => setFrac(e.target.value)} aria-label={`Reduce leg ${p.leg} by`} style={{ width: 'auto' }}>
          <option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">Close</option>
        </select>{' '}
        <button disabled={locked} title={why} onClick={() => onReduce(Number(frac))}>{frac === '1' ? 'Close leg' : 'Reduce'}</button>
      </td>
    </tr>
  );
}

const FILTERS = { all: 'Everything', trades: 'Trades', funding: 'Funding', transfers: 'Transfers' } as const;
const KIND_TEXT: Record<HistoryRow['kind'], string> = { 'hedge-open': 'Hedge', 'hedge-close': 'Hedge', open: 'One-sided', reduce: 'One-sided', protect: 'Protective', strategy: 'Strategy', twap: 'TWAP', external: 'Outside', funding: 'Funding', transfer: 'Transfer' };

export function OverviewTab(p: OverviewProps) {
  const [pos, setPos] = useState<Composite[]>();
  const [rows, setRows] = useState<HistoryRow[]>();
  const [err, setErr] = useState<string>();
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const [version, setVersion] = useState(0);
  const tick = p.view?.snapshot.at;
  useEffect(() => {
    let live = true;
    Promise.all([getPositions(p.owner), getHistory(p.owner)]).then(
      ([a, b]) => live && (setPos(a.positions), setRows(b.rows), setErr(undefined)),
      (e) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [p.owner, tick, version]);

  const assets = p.view?.snapshot.market.assets;
  const decimals = (coin: string) => assets?.find((a) => a.name === coin)?.szDecimals ?? 5;
  const maxLevOf = (coin: string) => {
    const m = assets?.find((a) => a.name === coin)?.maxLeverage;
    return m === undefined ? undefined : Math.min(m, p.view?.orderPolicy.maxLeverage ?? m);
  };
  const legs = p.view?.snapshot.legs ?? [];
  const equity = legs.reduce((s, l) => s + Number(l.clearinghouse.marginSummary.accountValue) + l.spotUsdc, 0);
  const sum = (f: (c: Composite) => number) => (pos ?? []).reduce((s, c) => s + f(c), 0);
  const openPnl = sum((c) => c.totals.pnl);

  const reduce = (leg: LegPosition, frac: number) =>
    p.run('reduce', async () => {
      const spec = reduceSpec(leg, frac, decimals(leg.coin));
      const out = await placeOrder(p.sign, p.owner, spec);
      setVersion((v) => v + 1);
      return p.done(out, frac >= 1 ? `Closed leg ${leg.leg}'s ${leg.coin}` : `Reduced leg ${leg.leg}'s ${leg.coin} by ${frac * 100}%`);
    });

  if (!p.view) return <p className="state">Waiting for data.</p>;
  const shownRows = (rows ?? []).filter((r) => filter === 'all' || (filter === 'trades' ? r.kind !== 'funding' && r.kind !== 'transfer' : filter === 'funding' ? r.kind === 'funding' : r.kind === 'transfer'));

  return (
    <div className="stack-cards">
      <section className="card" aria-labelledby="ov-h">
        <h2 id="ov-h">Overview</h2>
        <dl className="kv">
          <dt>Total balance on all legs</dt><dd className="big">{usd(equity)}</dd>
          <dt>Open positions</dt><dd>{pos ? pos.length : '…'}</dd>
          <dt>Open PnL, after fees and funding</dt><dd>{pos ? signed(openPnl) : '…'}</dd>
          <dt>Net if all closed now (estimate)</dt><dd>{pos ? signed(sum((c) => c.totals.netIfClosed)) : '…'}</dd>
        </dl>
        {err && <p className="state err" role="alert">{err}</p>}
      </section>

      {pos && pos.length === 0 && (
        <section className="card" aria-labelledby="ov-empty-h">
          <h2 id="ov-empty-h">No open positions</h2>
          <p className="state">Open one on a single leg from Trade, then hedge it on another leg from the ticket's Hedge mode.</p>
          <div className="actions"><button className="primary" onClick={() => p.onGo('trade')}>Open a trade</button><button onClick={() => p.onGo('trade?mode=hedge')}>Hedge</button></div>
        </section>
      )}

      {(pos ?? []).map((c) => (
        <section className="card" key={c.id} aria-labelledby={`pos-${c.id}`}>
          <h2 id={`pos-${c.id}`}>
            {c.coin} {c.kind === 'hedge' ? 'hedge' : c.kind === 'strategy' ? 'strategy position' : `${c.legs[0]?.side}, one leg`}
          </h2>
          <p className="muted small">
            {c.kind === 'hedge' ? `Leg 0 and leg 1 hold opposite sides, net ${n(c.netSize, decimals(c.coin))} ${c.coin}. ` : ''}
            {ago(c.openedAt)}.
          </p>
          <div className="scroll">
            <table className="mini">
              <thead><tr><th>Leg</th><th>Position</th><th className="num">Entry</th><th className="num">Liquidation</th><th className="num">Unrealized</th><th /></tr></thead>
              <tbody>
                {c.legs.map((l) => <LegRow key={l.leg} p={l} szDecimals={decimals(c.coin)} maxLev={maxLevOf(c.coin)} locked={p.locked} why={p.why} onReduce={(f) => reduce(l, f)} />)}
              </tbody>
            </table>
          </div>
          <Pnl c={c} />
          <div className="actions">
            {c.kind === 'hedge' && <button className="primary" disabled={p.locked} title={p.why} onClick={() => p.onCloseHedge(c.coin)}>Close the hedge</button>}
            <button onClick={() => p.onGo(`strategies?protect=${c.legs[0]!.leg}&coin=${c.coin}`)}>Protect…</button>
            <button onClick={() => p.onGo(`trade?leg=${c.legs[0]!.leg}&coin=${c.coin}`)}>Trade this leg</button>
            {c.kind === 'one-sided' && <button onClick={() => p.onGo(`trade?leg=0&coin=${c.coin}&mode=hedge`)}>Hedge it</button>}
          </div>
        </section>
      ))}

      <section className="card" aria-labelledby="ov-chart-h">
        <h2 id="ov-chart-h">PnL over time</h2>
        <p className="muted small">Steps are realized results minus fees plus funding, from the history below; the last point adds today's open PnL.</p>
        <PnlChart points={rows ? pnlSeries(rows, openPnl) : []} />
      </section>

      <section className="card" aria-labelledby="ov-hist-h">
        <h2 id="ov-hist-h">History</h2>
        <div className="fields inline" style={{ maxWidth: 280 }}>
          <label>
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value as keyof typeof FILTERS)}>
              {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        {!rows ? <p className="state">Reading history…</p> : shownRows.length === 0 ? <p className="state">Nothing here yet.</p> : (
          <div className="scroll">
            <table className="mini">
              <thead><tr><th>When</th><th>Type</th><th>What happened</th><th className="num">Size</th><th className="num">Price</th><th className="num">Result</th></tr></thead>
              <tbody>
                {shownRows.slice(0, 100).map((r, i) => (
                  <tr key={`${r.time}-${i}`}>
                    <td>{when(r.time)}</td>
                    <td>{KIND_TEXT[r.kind]}</td>
                    <td>{r.label}</td>
                    <td className="num">{r.size ? n(r.size, 5) : ''}</td>
                    <td className="num">{r.px ? usd(r.px) : ''}</td>
                    <td className="num">{r.kind === 'funding' || r.kind === 'transfer' ? signed(r.amount ?? 0) : r.closedPnl !== undefined && r.closedPnl !== 0 ? `${signed(r.closedPnl - (r.fee ?? 0))}` : r.fee ? signed(-r.fee) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">Result of a trade is its realized profit minus its fee. Rows marked Outside were placed from another tool, not by HyperNear. Hyperliquid keeps the latest 2000 fills per leg.</p>
      </section>
    </div>
  );
}


/** Hedge tab, right column: what the hedge is exposed to now. A hedge has no break-even price (the legs cancel), so this shows delta, funding and what closing would net. */
export function HedgeSummary({ owner, tick, onGo }: { owner: Hex; tick?: number; onGo: (to: string) => void }) {
  const [pos, setPos] = useState<Composite[]>();
  useEffect(() => {
    let live = true;
    getPositions(owner).then((r) => live && setPos(r.positions), () => live && setPos([]));
    return () => {
      live = false;
    };
  }, [owner, tick]);
  const hedges = (pos ?? []).filter((c) => c.kind === 'hedge');
  return (
    <section className="card" aria-labelledby="hs-h">
      <h2 id="hs-h">Hedge summary</h2>
      {!pos ? (
        <p className="state">Waiting for data.</p>
      ) : hedges.length === 0 ? (
        <p className="state">No open hedge. Open a position on leg 0 from the Trade tab, then hedge it here.</p>
      ) : (
        hedges.map((c) => (
          <dl key={c.id} className="kv">
            <dt>{c.coin}</dt>
            <dd className="big">{Math.abs(c.netSize) < 1e-9 ? 'Fully hedged' : `${n(Math.abs(c.netSize), 5)} ${c.coin} net ${c.netSize > 0 ? 'long' : 'short'}`}</dd>
            {c.legs.map((l) => (
              <FragmentRow key={l.leg} label={`Leg ${l.leg}`} value={`${l.side} ${n(l.size, 5)} at ${l.leverage.value}x ${l.leverage.type}, liquidation ${l.liquidationPx === null ? 'none' : usd(l.liquidationPx)}`} />
            ))}
            <dt>Next funding, both legs</dt>
            <dd>{signed(c.totals.nextFundingEstimate, 5)}</dd>
            <dt>Position PnL</dt>
            <dd>{signed(c.totals.pnl)}</dd>
            <dt>Net if closed now (estimate)</dt>
            <dd>{signed(c.totals.netIfClosed)}</dd>
          </dl>
        ))
      )}
      <div className="actions"><button onClick={() => onGo('portfolio')}>Full breakdown in Portfolio</button></div>
    </section>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

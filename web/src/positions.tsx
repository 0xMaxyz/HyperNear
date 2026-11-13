// One way to show open positions everywhere. A hedge (a long and a short in the same coin on two legs) is ONE row that expands to its legs;
// a single position is one row; a strategy leg is tagged. Pages never split a group, and the page size follows the space (pager.tsx).
import { useState } from 'react';
import { pct, pxFmt, signedUsd, tone } from './fmt';
import { Paged } from './pager';
import { n, usd } from './panels';
import type { Composite, LegPosition } from './trading';

export interface ProtectTarget {
  coin: string;
  legs: LegPosition[];
  hedge: boolean;
}

export interface PositionActions {
  locked: boolean;
  why?: string;
  decimals: (coin: string) => number;
  /** the market's maximum leverage, shown next to a position's leverage */
  maxLev?: (coin: string) => number | undefined;
  onReduce: (l: LegPosition, frac: number) => void;
  onCloseHedge: (c: Composite) => void;
  onTpsl: (t: ProtectTarget) => void;
  onLimit: (l: LegPosition) => void;
}

const roeOf = (unrealized: number, margin: number) => (margin > 0 ? unrealized / margin : 0);
/** the liquidation price closest to the mark: the one that matters first */
const nearestLiq = (legs: LegPosition[]) => {
  const near = legs.filter((l) => l.liquidationPx !== null).sort((a, b) => Math.abs(a.liquidationPx! - a.markPx) / a.markPx - Math.abs(b.liquidationPx! - b.markPx) / b.markPx)[0];
  return near?.liquidationPx ?? null;
};

/** Desktop: one body per composite so a hedge and its legs stay together. */
function LegRow({ l, kind, grouped, a }: { l: LegPosition; kind: Composite['kind']; grouped: boolean; a: PositionActions }) {
  const [frac, setFrac] = useState('1');
  const long = l.side === 'long';
  const dp = a.decimals(l.coin);
  const max = a.maxLev?.(l.coin);
  return (
    <tr className={grouped ? 't-leg-row' : ''}>
      <td><span className="t-leg">Leg {l.leg}</span>{kind === 'strategy' && <span className="t-tag violet">Strategy</span>}</td>
      <td><b>{l.coin}</b> <span className={`small ${long ? 'up' : 'down'}`}>{long ? 'Long' : 'Short'} {l.leverage.value}x {l.leverage.type}{max ? <span className="muted"> (max {max}x)</span> : null}</span></td>
      <td className={`num t-num ${long ? 'up' : 'down'}`}>{long ? '+' : '−'}{n(l.size, dp)}</td>
      <td className="num t-num">{usd(l.size * l.markPx)}</td>
      <td className="num t-num">{pxFmt(l.entryPx)}</td>
      <td className="num t-num">{pxFmt(l.markPx)}</td>
      <td className={`num t-num ${tone(l.unrealized)}`}>{signedUsd(l.unrealized)} ({pct(roeOf(l.unrealized, l.marginUsed), 1)})</td>
      <td className="num t-num liq">{l.liquidationPx === null ? 'None' : pxFmt(l.liquidationPx)}</td>
      <td className="num t-num">{usd(l.marginUsed)}</td>
      <td className={`num t-num ${tone(l.funding)}`}>{signedUsd(l.funding, 4)}</td>
      <td className="end">
        <div className="t-actions">
          <button disabled={a.locked} title={a.why} onClick={() => a.onTpsl({ coin: l.coin, legs: [l], hedge: false })}>TP/SL</button>
          <button disabled={a.locked} title={a.why ?? 'Close with a limit order at a price you choose'} onClick={() => a.onLimit(l)}>Limit</button>
          <select value={frac} onChange={(e) => setFrac(e.target.value)} aria-label={`How much of leg ${l.leg}'s ${l.coin} to close at market`}>
            <option value="0.25">25%</option><option value="0.5">50%</option><option value="1">100%</option>
          </select>
          <button disabled={a.locked} title={a.why} onClick={() => a.onReduce(l, Number(frac))}>Market</button>
        </div>
      </td>
    </tr>
  );
}

function GroupRow({ c, open, onToggle, a }: { c: Composite; open: boolean; onToggle: () => void; a: PositionActions }) {
  const long = c.legs.find((l) => l.side === 'long');
  const short = c.legs.find((l) => l.side === 'short');
  const dp = a.decimals(c.coin);
  const unreal = c.totals.unrealized;
  const margin = c.legs.reduce((s, l) => s + l.marginUsed, 0);
  const liq = nearestLiq(c.legs);
  return (
    <tr className="t-group-row">
      <td>
        <button className="t-chev" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the legs of the ${c.coin} hedge`} onClick={onToggle}>{open ? '▾' : '▸'}</button>
        <span className="t-tag info">Hedge</span>
      </td>
      <td><b>{c.coin}</b> <span className="muted small">legs {c.legs.map((l) => l.leg).join(' + ')}</span></td>
      <td className="num t-num"><span className="up">+{n(long?.size ?? 0, dp)}</span> / <span className="down">−{n(short?.size ?? 0, dp)}</span></td>
      <td className="num t-num">{usd(c.legs.reduce((s, l) => s + l.size * l.markPx, 0))}</td>
      <td className="num t-num muted" title="Each leg has its own entry price">—</td>
      <td className="num t-num">{pxFmt(c.legs[0]!.markPx)}</td>
      <td className={`num t-num ${tone(unreal)}`}>{signedUsd(unreal)} ({pct(roeOf(unreal, margin), 1)})</td>
      <td className="num t-num liq">{liq === null ? 'None' : pxFmt(liq)}</td>
      <td className="num t-num">{usd(margin)}</td>
      <td className={`num t-num ${tone(c.totals.funding)}`}>{signedUsd(c.totals.funding, 4)}</td>
      <td className="end">
        <div className="t-actions">
          <button disabled={a.locked} title={a.why ?? 'Take-profit and stop-loss levels for both legs'} onClick={() => a.onTpsl({ coin: c.coin, legs: c.legs, hedge: true })}>TP/SL</button>
          <button disabled={a.locked} title={a.why ?? 'Closes both legs at market'} onClick={() => a.onCloseHedge(c)}>Close hedge</button>
        </div>
      </td>
    </tr>
  );
}

function Card({ l, kind, a }: { l: LegPosition; kind: Composite['kind']; a: PositionActions }) {
  const long = l.side === 'long';
  const max = a.maxLev?.(l.coin);
  return (
    <div className="t-pcard">
      <div className="t-pcard-top">
        <span className="t-leg">Leg {l.leg}</span>
        {kind === 'strategy' && <span className="t-tag violet">Strategy</span>}
        <b>{l.coin}</b>
        <span className={`small ${long ? 'up' : 'down'}`}>{long ? 'Long' : 'Short'} {l.leverage.value}x{max ? ` (max ${max}x)` : ''}</span>
        <span className="t-spacer" />
        <span className={`t-num ${tone(l.unrealized)}`}>{signedUsd(l.unrealized)} ({pct(roeOf(l.unrealized, l.marginUsed), 1)})</span>
      </div>
      <dl className="t-pcard-kv t-num">
        <dt>Size</dt><dd>{n(l.size, a.decimals(l.coin))}</dd>
        <dt>Entry</dt><dd>{pxFmt(l.entryPx)}</dd>
        <dt>Mark</dt><dd>{pxFmt(l.markPx)}</dd>
        <dt>Liq.</dt><dd className="liq">{l.liquidationPx === null ? 'None' : pxFmt(l.liquidationPx)}</dd>
      </dl>
      <div className="t-actions">
        <button disabled={a.locked} title={a.why} onClick={() => a.onTpsl({ coin: l.coin, legs: [l], hedge: false })}>TP/SL</button>
        <button disabled={a.locked} title={a.why} onClick={() => a.onLimit(l)}>Limit close</button>
        <button disabled={a.locked} title={a.why} onClick={() => a.onReduce(l, 1)}>Market close</button>
      </div>
    </div>
  );
}

export function PositionsTable({ comps, fit, ...a }: PositionActions & { comps: Composite[]; fit: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));
  const weight = (c: Composite) => (c.kind === 'hedge' ? 1 + (open.has(c.id) ? c.legs.length : 0) : 1);
  return (
    <Paged items={comps} weight={weight} fit={fit} resetKey={comps.map((c) => c.id).join()} fallbackRows={8} reservedPx={34}>
      {(page) => (
        <>
          <div className="t-cards phone">
            {page.map((c) => (
              <div key={c.id} className="t-cardgroup">
                {c.kind === 'hedge' ? (
                  <>
                    <div className="t-group-line card-head">
                      <button className="t-chev" aria-expanded={open.has(c.id)} aria-label={`${open.has(c.id) ? 'Hide' : 'Show'} the legs of the ${c.coin} hedge`} onClick={() => toggle(c.id)}>{open.has(c.id) ? '▾' : '▸'}</button>
                      <span className="t-tag info">Hedge</span>
                      <b>{c.coin}</b>
                      <span className="t-spacer" />
                      <span className={`t-num ${tone(c.totals.unrealized)}`}>{signedUsd(c.totals.unrealized)}</span>
                    </div>
                    <div className="t-actions">
                      <button disabled={a.locked} title={a.why} onClick={() => a.onTpsl({ coin: c.coin, legs: c.legs, hedge: true })}>TP/SL</button>
                      <button disabled={a.locked} title={a.why} onClick={() => a.onCloseHedge(c)}>Close hedge</button>
                    </div>
                    {open.has(c.id) && c.legs.map((l) => <Card key={l.leg} l={l} kind={c.kind} a={a} />)}
                  </>
                ) : (
                  c.legs.map((l) => <Card key={l.leg} l={l} kind={c.kind} a={a} />)
                )}
              </div>
            ))}
          </div>
          <table className="t-table desk">
            <thead>
              <tr><th>Leg</th><th>Coin</th><th className="num">Size</th><th className="num">Value</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">PnL (ROE)</th><th className="num">Liq. price</th><th className="num">Margin</th><th className="num">Funding</th><th className="end" /></tr>
            </thead>
            {page.map((c) => (
              <tbody key={c.id} className={c.kind === 'hedge' ? 't-group' : ''}>
                {c.kind === 'hedge' && <GroupRow c={c} open={open.has(c.id)} onToggle={() => toggle(c.id)} a={a} />}
                {(c.kind !== 'hedge' || open.has(c.id)) && c.legs.map((l) => <LegRow key={l.leg} l={l} kind={c.kind} grouped={c.kind === 'hedge'} a={a} />)}
              </tbody>
            ))}
          </table>
        </>
      )}
    </Paged>
  );
}

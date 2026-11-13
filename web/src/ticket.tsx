// The order ticket. Single leg: Market | Limit | Pro (stop, take-profit, TWAP, trailing, TP/SL for a position), size in the
// coin or in USD with a slider, TP/SL attached to an opening order, and the agent's policy checked before anything is signed,
// with a one-click fix when an order is over a limit. Hedge: leg 0's position mirrored on leg 1 at a ratio (the agent's
// openHedge). Every order is a signed command carrying its exact spec (trading.ts).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { post, type OwnerView } from './api';
import { newCommand } from './hypernear';
import { n, usd } from './panels';
import { buildSpec, CLOSING_TYPES, describeSpec, TYPE_LABEL, type OrderForm } from './orderForm';
import { SessionControl, type SessionApi } from './session';
import { floorSize, placeOrder, roundPx, sendSpec, type HedgeSpec, type OrderType, type Sign } from './trading';

const PRO_TYPES: OrderType[] = ['stopMarket', 'stopLimit', 'takeMarket', 'takeLimit', 'twap', 'trailing', 'bracket'];
const PRO_LABEL: Partial<Record<OrderType, string>> = { bracket: 'TP/SL for the position' };

export interface TicketProps {
  view: OwnerView;
  owner: Hex;
  f: OrderForm;
  set: (patch: Partial<OrderForm>) => void;
  /** mark price of f.coin */
  mid: number;
  locked: boolean;
  why?: string;
  sign: Sign;
  session?: SessionApi;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  done: (out: Record<string, unknown>, what: string) => string;
  onPlaced: () => void;
  onCloseHedge: (coin: string) => void;
  onGo: (to: string) => void;
  /** from a link: #/trade?mode=hedge opens the hedge mode */
  initialMode?: 'single' | 'hedge';
}

export function Ticket(p: TicketProps) {
  const { view, f, set, mid } = p;
  const [mode, setMode] = useState<'single' | 'hedge'>(p.initialMode ?? 'single');
  useEffect(() => {
    if (p.initialMode) setMode(p.initialMode);
  }, [p.initialMode]);
  const legs = view.legs ?? [];
  const ready = legs.filter((l) => l.agent?.approvedAt);
  const coins = view.orderPolicy.allowedCoins;
  const asset = view.snapshot.market.assets?.find((a) => a.name === f.coin);
  const dp = asset?.szDecimals ?? 5;
  const leg = view.snapshot.legs.find((l) => l.leg === f.leg);
  const pos = leg?.clearinghouse.assetPositions.map((x) => x.position).find((x) => x.coin === f.coin && Number(x.szi) !== 0);
  const posSize = Math.abs(Number(pos?.szi ?? 0));
  const closingSide = pos ? (Number(pos.szi) > 0 ? 'sell' : 'buy') : undefined;
  const closingType = CLOSING_TYPES.includes(f.type);
  const protective = closingType || f.reduceOnly;
  const policyLev = view.orderPolicy.maxLeverage;
  const maxLev = Math.min(policyLev, asset?.maxLeverage ?? 40);
  const cap = view.orderPolicy.maxNotionalUsd;
  const pro = PRO_TYPES.includes(f.type);

  // a new leg or coin starts from that leg's own leverage and margin mode when it already holds the coin
  const posKey = `${f.leg}:${f.coin}:${pos ? `${pos.leverage.value}${pos.leverage.type}` : 'flat'}`;
  useEffect(() => {
    // a flat leg keeps what was typed, held under the new coin's own maximum
    set(pos ? { keepLeverage: true, leverage: String(pos.leverage.value), isCross: pos.leverage.type === 'cross' } : { keepLeverage: false, leverage: String(Math.min(Number(f.leverage) || 5, maxLev)) });
  }, [posKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // a closing order is on the position's other side
  useEffect(() => {
    if (closingType && closingSide && f.side !== closingSide) set({ side: closingSide });
  }, [closingType, closingSide, f.side]); // eslint-disable-line react-hooks/exhaustive-deps

  // size: typed in the coin or in USD; the spec always carries the coin size
  const [unit, setUnit] = useState<'coin' | 'usd'>('coin');
  const [usdText, setUsdText] = useState('');
  const refPx = Number(f.type === 'limit' || f.type.endsWith('Limit') ? f.limitPx || mid : f.type.startsWith('stop') || f.type.startsWith('take') ? f.triggerPx || mid : mid) || mid;
  const sizeNum = Number(f.size) || 0;
  const notional = sizeNum * refPx;
  const maxSize = protective ? posSize : refPx > 0 ? cap / refPx : 0;
  const floorTo = (x: number) => floorSize(Math.max(0, x), dp);
  const setSize = (coinSize: number) => {
    const s = coinSize > 0 ? String(Number(floorTo(coinSize))) : '';
    set({ size: s });
    setUsdText(s ? (Number(s) * refPx).toFixed(2) : '');
  };
  const onSizeText = (t: string) => {
    if (unit === 'coin') {
      set({ size: t });
      setUsdText(Number(t) ? (Number(t) * refPx).toFixed(2) : '');
    } else {
      setUsdText(t);
      const c = Number(t) / refPx;
      set({ size: c > 0 && Number.isFinite(c) ? String(Number(floorTo(c))) : '' });
    }
  };
  const pctOfMax = maxSize > 0 ? Math.min(100, Math.round((sizeNum / maxSize) * 100)) : 0;

  const built = useMemo(() => buildSpec(f, dp), [f, dp]);
  const err = 'error' in built ? built.error : undefined;
  const opens = !protective;
  const lev = f.keepLeverage && pos ? pos.leverage.value : Number(f.leverage) || 0;
  const overCap = opens && notional > cap + 1e-9;
  const overLev = opens && !f.keepLeverage && lev > maxLev;
  const highLev = opens && lev >= 10 && !overLev;
  const blocked = overCap ? `${usd(notional)} is over the ${usd(cap)} per-order cap. The agent would refuse it.` : overLev ? `${lev}x is above the ${maxLev}x maximum.` : undefined;
  const [levOpen, setLevOpen] = useState(false);

  // what TP / SL would make or lose on this size, from the entry reference
  const pnlAt = (px: string) => {
    const x = Number(px);
    if (!x || !sizeNum || !refPx) return '';
    const d = (f.side === 'buy' ? x - refPx : refPx - x) * sizeNum;
    return `${d >= 0 ? '+' : '−'}${usd(Math.abs(d))} · ${d >= 0 ? '+' : '−'}${Math.abs(((x - refPx) / refPx) * 100).toFixed(1)}%`;
  };

  const submit = () =>
    p.run('order', async () => {
      if ('error' in built) throw new Error(built.error);
      const out = await placeOrder(p.sign, p.owner, built.spec);
      p.onPlaced();
      return p.done(out, describeSpec(built.spec, mid).replace(/\.$/, ''));
    });

  if (ready.length === 0) {
    return (
      <section className="t-panel t-ticket" aria-labelledby="ticket-h">
        <h2 id="ticket-h">Order ticket</h2>
        <p className="t-empty">No leg can trade yet: a leg needs its agent key approved in Setup, and some USDC on its trading balance.</p>
        <button onClick={() => p.onGo('setup')}>Go to Setup</button>
      </section>
    );
  }

  const field = (label: string, key: keyof OrderForm, extra: { placeholder?: string; suffix?: ReactNode; mode?: 'decimal' | 'numeric' } = {}) => (
    <label className="t-input">
      <span>{label}</span>
      <input value={String(f[key])} onChange={(e) => set({ [key]: e.target.value } as Partial<OrderForm>)} inputMode={extra.mode ?? 'decimal'} placeholder={extra.placeholder} spellCheck={false} />
      {extra.suffix}
    </label>
  );

  return (
    <section className="t-panel t-ticket" aria-labelledby="ticket-h">
      <h2 id="ticket-h" className="sr-only">Order ticket</h2>

      <div className="t-row tight">
        <label className="t-chipsel grow">
          <span className="sr-only">Trade on</span>
          <select value={f.leg} onChange={(e) => set({ leg: Number(e.target.value) })}>
            {ready.map((l) => <option key={l.leg} value={l.leg}>Leg {l.leg} · {l.address.slice(0, 6)}…{l.address.slice(-4)}</option>)}
          </select>
        </label>
        <button className="t-chip-btn" disabled={!opens} aria-label={`Margin mode ${f.isCross ? 'cross' : 'isolated'}, switch`} onClick={() => set({ isCross: !f.isCross, keepLeverage: false })}>{f.isCross ? 'Cross' : 'Isolated'}</button>
        <button className="t-chip-btn" disabled={!opens} aria-expanded={levOpen} aria-controls="lev-edit" onClick={() => setLevOpen((x) => !x)}>{lev || '—'}x</button>
      </div>
      {levOpen && opens && (
        <div id="lev-edit" className="t-lev">
          <label className="sr-only" htmlFor="lev-range">Leverage</label>
          <input id="lev-range" type="range" min={1} max={maxLev} step={1} value={Math.min(lev || 1, maxLev)} onChange={(e) => set({ leverage: e.target.value, keepLeverage: false })} />
          <span className="t-num">{lev}x</span>
          <span className="muted small">max {maxLev}x for {f.coin}{pos && f.keepLeverage ? ' · leg\'s current' : ''}</span>
        </div>
      )}
      {highLev && <p className="t-hint" role="note">At {lev}x a {(100 / lev).toFixed(0)}% move against the position liquidates it.</p>}

      <div role="tablist" aria-label="Ticket mode" className="t-modes">
        <button role="tab" aria-selected={mode === 'single'} onClick={() => setMode('single')}>Single leg</button>
        <button role="tab" aria-selected={mode === 'hedge'} onClick={() => setMode('hedge')}>Hedge (2 legs)</button>
      </div>

      {mode === 'hedge' ? (
        <HedgeTicket {...p} />
      ) : (
        <>
          <div className="t-types" role="tablist" aria-label="Order type">
            <button role="tab" aria-selected={f.type === 'market'} onClick={() => set({ type: 'market' })}>Market</button>
            <button role="tab" aria-selected={f.type === 'limit'} onClick={() => set({ type: 'limit', limitPx: f.limitPx || (mid ? roundPx(mid, dp) : '') })}>Limit</button>
            <label className={`t-pro ${pro ? 'on' : ''}`}>
              <span className="sr-only">Pro order types</span>
              <select value={pro ? f.type : ''} onChange={(e) => e.target.value && set({ type: e.target.value as OrderType, reduceOnly: CLOSING_TYPES.includes(e.target.value as OrderType) ? false : f.reduceOnly, attach: false })}>
                <option value="" disabled>Pro</option>
                {PRO_TYPES.map((t) => <option key={t} value={t}>{PRO_LABEL[t] ?? TYPE_LABEL[t]}{CLOSING_TYPES.includes(t) ? ' (closes only)' : ''}</option>)}
              </select>
              <span aria-hidden="true">▾</span>
            </label>
          </div>

          <div role="group" aria-label="Side" className="t-sides">
            {(['buy', 'sell'] as const).map((s) => (
              <button key={s} aria-pressed={f.side === s} className={`t-side ${s}`} disabled={closingType && Boolean(closingSide)} onClick={() => set({ side: s })}>
                {s === 'buy' ? 'Buy / Long' : 'Sell / Short'}
              </button>
            ))}
          </div>
          {closingType && (
            <p className="t-hint">{closingSide ? `Closes leg ${f.leg}'s ${n(posSize, dp)} ${f.coin} ${closingSide === 'sell' ? 'long' : 'short'}: the side is fixed.` : `Leg ${f.leg} has no ${f.coin} position to close.`}</p>
          )}

          <dl className="t-kv">
            <dt>Available to trade</dt><dd className="t-num">{usd(leg?.clearinghouse.withdrawable)}</dd>
            <dt>Leg {f.leg} position</dt>
            <dd className={`t-num ${pos ? (Number(pos.szi) > 0 ? 'up' : 'down') : ''}`}>{pos ? `${n(posSize, dp)} ${f.coin} ${Number(pos.szi) > 0 ? 'long' : 'short'}` : 'Flat'}</dd>
          </dl>

          {(f.type === 'stopMarket' || f.type === 'takeMarket' || f.type === 'stopLimit' || f.type === 'takeLimit') && field('Trigger price', 'triggerPx', { suffix: <span className="t-unit">USD</span> })}
          {(f.type === 'limit' || f.type === 'stopLimit' || f.type === 'takeLimit') &&
            field('Limit price', 'limitPx', { suffix: <button className="t-mini" onClick={() => set({ limitPx: mid ? roundPx(mid, dp) : '' })}>Mid</button> })}
          {f.type === 'limit' && (
            <div className="t-tif" role="group" aria-label="Time in force">
              {(['Gtc', 'Ioc', 'Alo'] as const).map((t) => (
                <button key={t} aria-pressed={f.tif === t} onClick={() => set({ tif: t })} title={t === 'Gtc' ? 'Good till cancelled' : t === 'Ioc' ? 'Immediate or cancel' : 'Post only (maker)'}>{t === 'Alo' ? 'Post only' : t.toUpperCase()}</button>
              ))}
            </div>
          )}
          {f.type === 'bracket' && (
            <div className="t-row">
              {field('Take-profit price', 'tpPx')}
              {field('Stop-loss price', 'slPx')}
            </div>
          )}
          {f.type === 'twap' && field('Duration, minutes', 'minutes', { mode: 'numeric', suffix: <span className="t-unit">5–1440</span> })}
          {f.type === 'trailing' && (
            <>
              <div className="t-row">
                <div className="t-tif" role="group" aria-label="Trail by">
                  <button aria-pressed={f.trailBy === 'pct'} onClick={() => set({ trailBy: 'pct', trailValue: '5' })}>%</button>
                  <button aria-pressed={f.trailBy === 'px'} onClick={() => set({ trailBy: 'px', trailValue: '' })}>USD</button>
                </div>
                {field('Trail', 'trailValue')}
              </div>
              {field('Activate at (optional)', 'activationPx')}
            </>
          )}

          {f.type !== 'bracket' && (
            <>
              <label className="t-input strong">
                <span>Size</span>
                <input value={unit === 'coin' ? f.size : usdText} onChange={(e) => onSizeText(e.target.value)} inputMode="decimal" spellCheck={false} placeholder={maxSize ? `max ${unit === 'coin' ? floorTo(maxSize) : (maxSize * refPx).toFixed(2)}` : undefined} />
                <button className="t-mini" aria-label={`Size in ${unit === 'coin' ? f.coin : 'USD'}; switch to ${unit === 'coin' ? 'USD' : f.coin}`} onClick={() => setUnit((u) => (u === 'coin' ? 'usd' : 'coin'))}>{unit === 'coin' ? f.coin : 'USD'} ⇄</button>
              </label>
              <p className="t-hint t-num">{sizeNum ? (unit === 'coin' ? `≈ ${usd(notional)}` : `≈ ${f.size} ${f.coin}`) : protective ? `Position: ${n(posSize, dp)} ${f.coin}` : `Up to ${usd(cap)} per order`}</p>
              <div className="t-slider">
                <input type="range" min={0} max={100} step={1} value={pctOfMax} aria-label={`Size as a share of ${protective ? 'the position' : 'the per-order cap'}`} disabled={!maxSize} onChange={(e) => setSize((maxSize * Number(e.target.value)) / 100)} />
                <div className="t-fracs">
                  {[0.25, 0.5, 0.75, 1].map((x) => (
                    <button key={x} disabled={!maxSize} onClick={() => setSize(maxSize * x)}>{x === 1 ? (protective ? 'All' : 'Max') : `${x * 100}%`}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          {(f.type === 'market' || f.type === 'limit') && (
            <div className="t-checks">
              <label className="t-check"><input type="checkbox" checked={f.reduceOnly} onChange={(e) => set({ reduceOnly: e.target.checked, attach: e.target.checked ? false : f.attach })} /> Reduce only</label>
              <label className="t-check"><input type="checkbox" checked={f.attach} disabled={f.reduceOnly} onChange={(e) => set({ attach: e.target.checked })} /> Take profit / Stop loss</label>
            </div>
          )}
          {(f.type === 'market' || f.type === 'limit') && f.attach && !f.reduceOnly && (
            <div className="t-row">
              <label className="t-input stack">
                <span>TP price</span>
                <input className="up" value={f.tpPx} onChange={(e) => set({ tpPx: e.target.value })} inputMode="decimal" spellCheck={false} />
                <small className="muted">{pnlAt(f.tpPx)}</small>
              </label>
              <label className="t-input stack">
                <span>SL price</span>
                <input className="down" value={f.slPx} onChange={(e) => set({ slPx: e.target.value })} inputMode="decimal" spellCheck={false} />
                <small className="muted">{pnlAt(f.slPx)}</small>
              </label>
            </div>
          )}

          {opens && (
            <div className={`t-policy ${blocked ? 'over' : ''}`}>
              <div className="t-policy-l"><span>Agent policy</span><span className="muted">{coins.join(', ')} · ≤ {maxLev}x for {f.coin} · ≤ {usd(cap, 0)} per order</span></div>
              <div className="t-meter" aria-hidden="true"><span className={`t-fill ${overCap ? 'down' : 'info'}`} style={{ width: `${Math.min(100, (notional / cap) * 100)}%` }} /></div>
              <div className="t-policy-l muted"><span>This order {notional ? usd(notional) : '—'}</span><span>{overCap ? `${usd(notional - cap)} over` : `${usd(Math.max(0, cap - notional))} left`}</span></div>
              {blocked && (
                <div className="t-fixes" role="alert">
                  <span>{blocked}</span>
                  {overCap && <button onClick={() => setSize(cap / refPx)}>Fit to cap · {floorTo(cap / refPx)} {f.coin}</button>}
                  {overCap && f.type === 'market' && <button onClick={() => set({ type: 'twap', minutes: '30' })}>Split as TWAP</button>}
                  {overLev && <button onClick={() => set({ leverage: String(maxLev) })}>Use {maxLev}x</button>}
                </div>
              )}
            </div>
          )}

          <dl className="t-kv">
            <dt>Order value</dt><dd className="t-num">{notional ? usd(notional) : '—'}</dd>
            {opens && <><dt>Margin required</dt><dd className="t-num">{notional && lev ? usd(notional / lev) : '—'}</dd></>}
            {f.type === 'market' && <><dt>Max slippage</dt><dd className="t-num">{(view.orderPolicy.slippage * 100).toFixed(2)}%</dd></>}
          </dl>

          <p className={err && !blocked ? 't-msg err' : 't-msg'} role={err && !blocked ? 'alert' : undefined}>{blocked ? '' : err ?? ('spec' in built ? describeSpec(built.spec, mid) : '')}</p>
          <button className={`t-submit ${f.side}`} disabled={p.locked || Boolean(err) || Boolean(blocked)} title={p.why} onClick={submit}>
            {p.session?.spec ? '' : 'Sign · '}
            {f.type === 'bracket' ? `Protect leg ${f.leg} ${f.coin}` : `${f.side === 'buy' ? 'Buy / Long' : 'Sell / Short'}${'spec' in built && built.spec.size ? ` ${built.spec.size} ${f.coin}` : ''}`}
          </button>
        </>
      )}
      {p.session && <SessionControl s={p.session} run={p.run} locked={p.locked} why={p.why} />}
    </section>
  );
}

/** Hedge mode: the agent shorts (or longs) `ratio` of leg 0's position on leg 1, at leg 1's own leverage if set. */
function HedgeTicket(p: TicketProps) {
  const { view, f } = p;
  const [ratio, setRatio] = useState(50);
  const [lev1, setLev1] = useState<'same' | string>('same');
  const [margin1, setMargin1] = useState<'same' | 'cross' | 'isolated'>('same');
  const dp = view.snapshot.market.assets?.find((a) => a.name === f.coin)?.szDecimals ?? 5;
  const posOf = (legNo: number) => view.snapshot.legs.find((l) => l.leg === legNo)?.clearinghouse.assetPositions.map((x) => x.position).find((x) => x.coin === f.coin && Number(x.szi) !== 0);
  const p0 = posOf(0);
  const p1 = posOf(1);
  const leg1Ready = (view.legs ?? []).some((l) => l.leg === 1 && l.agent?.approvedAt);
  const s0 = Number(p0?.szi ?? 0);
  const hedgeSize = Number(floorSize((Math.abs(s0) * ratio) / 100, dp));
  const maxLev = Math.min(view.orderPolicy.maxLeverage, view.snapshot.market.assets?.find((a) => a.name === f.coin)?.maxLeverage ?? 40);
  const spec: HedgeSpec | undefined =
    lev1 === 'same' && margin1 === 'same' ? undefined : { ...(lev1 !== 'same' ? { leg1Leverage: Number(lev1) } : {}), ...(margin1 !== 'same' ? { leg1IsCross: margin1 === 'cross' } : {}) };
  const why = !p0 ? `Leg 0 holds no ${f.coin}. A hedge mirrors leg 0's position on leg 1, so open it on leg 0 first.` : !leg1Ready ? 'Leg 1 has no approved agent key yet (Home).' : p1 ? `Leg 1 already holds ${n(Math.abs(Number(p1.szi)), dp)} ${f.coin}: close that hedge before opening another.` : hedgeSize * p.mid < 10 ? 'That is below the $10 Hyperliquid minimum: raise the ratio.' : undefined;

  const open = () =>
    p.run('open', async () => {
      // a spec only when leg 1 gets its own leverage or margin mode; otherwise the command signs a zero spec hash
      const out = spec
        ? await sendSpec(p.sign, p.owner, 'openHedge', '/hedge/open', spec, f.coin, String(ratio / 100))
        : await (async () => {
            const command = newCommand(p.owner, 'openHedge', f.coin, String(ratio / 100));
            return post('/hedge/open', { command, sig: await p.sign(command) });
          })();
      p.onPlaced();
      return p.done(out, `Hedge on ${f.coin} opened: leg 1 ${s0 > 0 ? 'short' : 'long'} ${hedgeSize} at ratio ${ratio}%`);
    });

  return (
    <>
      <dl className="t-kv">
        <dt>Leg 0 {f.coin}</dt>
        <dd className={`t-num ${s0 > 0 ? 'up' : s0 < 0 ? 'down' : ''}`}>{p0 ? `${n(Math.abs(s0), dp)} ${s0 > 0 ? 'long' : 'short'} · ${p0.leverage.value}x` : 'Flat'}</dd>
        <dt>Leg 1 {f.coin}</dt>
        <dd className="t-num">{p1 ? `${n(Math.abs(Number(p1.szi)), dp)} ${Number(p1.szi) > 0 ? 'long' : 'short'}` : 'Flat'}</dd>
      </dl>
      <div className="t-slider">
        <div className="t-line"><span className="muted">Hedge ratio</span><span className="t-num">{ratio}%</span></div>
        <input type="range" min={10} max={100} step={5} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} aria-label="Hedge ratio" />
        <div className="t-fracs">
          {[25, 50, 75, 100].map((x) => <button key={x} aria-pressed={ratio === x} onClick={() => setRatio(x)}>{x}%</button>)}
        </div>
      </div>
      <div className="t-row">
        <label className="t-input stack">
          <span>Leg 1 leverage</span>
          <select value={lev1} onChange={(e) => setLev1(e.target.value)}>
            <option value="same">Same as leg 0</option>
            {Array.from({ length: maxLev }, (_, i) => i + 1).map((x) => <option key={x} value={x}>{x}x</option>)}
          </select>
        </label>
        <label className="t-input stack">
          <span>Leg 1 margin</span>
          <select value={margin1} onChange={(e) => setMargin1(e.target.value as typeof margin1)}>
            <option value="same">Same as leg 0</option>
            <option value="cross">Cross</option>
            <option value="isolated">Isolated</option>
          </select>
        </label>
      </div>
      <div className="t-preview">
        <span className="muted small">This will</span>
        <span>{p0 ? <>{s0 > 0 ? 'Short' : 'Long'} <b className={`t-num ${s0 > 0 ? 'down' : 'up'}`}>{hedgeSize} {f.coin}</b> on leg 1 at market</> : '—'}</span>
        {p0 && <span className="muted small">Net after: <span className="t-num">{n(Math.abs(s0) - hedgeSize, dp)} {f.coin} {s0 > 0 ? 'long' : 'short'}</span></span>}
      </div>
      {why && <p className="t-msg err" role="alert">{why}</p>}
      <button className="t-submit hedge" disabled={p.locked || Boolean(why)} title={p.why} onClick={open}>Sign · Open hedge on leg 1</button>
      {p1 && p0 && <button className="t-link" disabled={p.locked} onClick={() => p.onCloseHedge(f.coin)}>Close the {f.coin} hedge</button>}
      <p className="t-hint">Hedges always sign with your wallet: 1-click covers single orders and cancels only.</p>
    </>
  );
}

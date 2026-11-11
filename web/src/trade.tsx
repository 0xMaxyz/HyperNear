// Trade tab: a trading terminal. Market bar, chart with each leg's lines, order book and trades (live from Hyperliquid,
// market.ts), the order ticket for any registered leg with that leg's account under it, and the blotter: positions grouped
// by hedge, open orders, TWAP, history and the agent's activity. Every order is a signed command that carries the exact spec
// (web/src/trading.ts), signed by the wallet or by the 1-click session key.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import type { AgentEvent, OwnerView } from './api';
import type { Interval } from './hl';
import { useMarket } from './market';
import { n, usd } from './panels';
import { buildSpec, CLOSING_TYPES, describeSpec, emptyForm, TYPE_LABEL, type OrderForm } from './orderForm';
import { SessionControl, type SessionApi } from './session';
import { Blotter, BookPanel, chartLines, LegAccount, MarketBar, PriceChart } from './terminal';
import {
  cancelOrder, floorSize, getHistory, getOrders, getPositions, ORDER_TYPES, placeOrder, reduceSpec, roundPx,
  type Composite, type HistoryRow, type LegPosition, type OpenOrder, type RunningTwap, type Sign,
} from './trading';

/** the guard's trigger, in multiples of maintenance margin (agent HYPERNEAR_GUARD_MARGIN_FLOOR, default 2) */
const GUARD_FLOOR = 2;

export interface TradeProps {
  view?: OwnerView;
  owner: Hex;
  canSign: boolean;
  locked: boolean;
  why?: string;
  sign: Sign;
  /** 1-click trading session (signs orders and cancels without the wallet) */
  session?: SessionApi;
  /** the agent's events for this owner (Activity tab of the blotter) */
  events: AgentEvent[];
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  done: (out: Record<string, unknown>, what: string) => string;
  onCloseHedge: (coin: string) => void;
  onGo: (to: string) => void;
  /** from a link: #/trade?leg=1&coin=BTC&side=sell&type=bracket */
  initial?: Partial<Pick<OrderForm, 'leg' | 'coin' | 'side' | 'type'>>;
}

export function TradeTab(p: TradeProps) {
  const { view, owner } = p;
  const legs = view?.legs ?? [];
  const ready = legs.filter((l) => l.agent?.approvedAt);
  const coins = view?.orderPolicy.allowedCoins ?? ['BTC', 'ETH'];
  const [f, setF] = useState<OrderForm>(() => ({ ...emptyForm(p.initial?.leg ?? ready[0]?.leg ?? 0, p.initial?.coin ?? coins[0]), ...p.initial }));
  const set = (patch: Partial<OrderForm>) => setF((x) => ({ ...x, ...patch }));
  const [orders, setOrders] = useState<{ orders: OpenOrder[]; twaps: RunningTwap[] }>();
  const [positions, setPositions] = useState<Composite[]>();
  const [history, setHistory] = useState<HistoryRow[]>();
  const [version, setVersion] = useState(0);
  const [interval, setInterval_] = useState<Interval>('15m');
  const [grouping, setGrouping] = useState(5);
  const ticketRef = useRef<HTMLElement>(null);

  const recorded = Boolean(view?.dryRun);
  const network = view?.config?.hlNetwork ?? 'testnet';
  const market = useMarket({ network, coin: f.coin, interval: recorded ? '15m' : interval, nSigFigs: grouping === 5 ? undefined : grouping, recorded: !view || recorded });

  useEffect(() => {
    let live = true;
    getOrders(owner).then((o) => live && setOrders(o), () => live && setOrders(undefined));
    getPositions(owner).then((r) => live && setPositions(r.positions), () => live && setPositions([]));
    getHistory(owner).then((r) => live && setHistory(r.rows), () => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [owner, version, view?.snapshot.at]);

  const decimals = (coin: string) => view?.snapshot.market.assets?.find((a) => a.name === coin)?.szDecimals ?? 5;
  const szDecimals = decimals(f.coin);
  const asset = view?.snapshot.market.assets?.find((a) => a.name === f.coin);
  const mid = market.ctx?.markPx ?? Number(view?.snapshot.market.mids[f.coin] ?? 0);
  const leg = view?.snapshot.legs.find((l) => l.leg === f.leg);
  const pos = leg?.clearinghouse.assetPositions.map((x) => x.position).find((x) => x.coin === f.coin && Number(x.szi) !== 0);
  const posSize = Math.abs(Number(pos?.szi ?? 0));
  const closingSide = pos ? (Number(pos.szi) > 0 ? 'sell' : 'buy') : undefined;
  const closingType = CLOSING_TYPES.includes(f.type);
  const protective = closingType || f.reduceOnly;
  const maxLev = Math.min(view?.orderPolicy.maxLeverage ?? 5, asset?.maxLeverage ?? 40);
  const cap = view?.orderPolicy.maxNotionalUsd ?? 100;

  // a closing order is on the position's other side; keep the ticket pointing there
  useEffect(() => {
    if (closingType && closingSide && f.side !== closingSide) set({ side: closingSide });
  }, [closingType, closingSide, f.side]);

  const built = useMemo(() => buildSpec(f, szDecimals), [f, szDecimals]);
  const lines = useMemo(() => chartLines(view, f.coin, orders?.orders), [view, f.coin, orders]);
  const sizeFrom = (frac: number) => {
    const ref = protective ? posSize : mid > 0 ? cap / mid : 0;
    const s = Math.floor(ref * frac * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;
    set({ size: s > 0 ? String(s) : '' });
  };
  const bump = () => setVersion((v) => v + 1);
  const toTicket = (patch: Partial<OrderForm>) => {
    set(patch);
    ticketRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ticketRef.current?.querySelector<HTMLElement>('select, input')?.focus({ preventScroll: true });
  };

  const submit = () =>
    p.run('order', async () => {
      if ('error' in built) throw new Error(built.error);
      const out = await placeOrder(p.sign, owner, built.spec);
      bump();
      return p.done(out, describeSpec(built.spec, mid).replace(/\.$/, ''));
    });
  const cancel = (o: OpenOrder | RunningTwap) =>
    p.run('cancel', async () => {
      const spec = 'oid' in o ? { leg: o.leg, coin: o.coin, oid: o.oid } : { leg: o.leg, coin: o.coin, twapId: o.twapId };
      const out = await cancelOrder(p.sign, owner, spec);
      bump();
      return p.done(out, 'Order cancelled');
    });
  const cancelAll = (pairs: { leg: number; coin: string }[]) =>
    p.run('cancel', async () => {
      let last: Record<string, unknown> = {};
      for (const x of pairs) last = await cancelOrder(p.sign, owner, { leg: x.leg, coin: x.coin, all: true });
      bump();
      return p.done(last, `Cancelled resting orders on ${pairs.map((x) => `leg ${x.leg} ${x.coin}`).join(', ')}`);
    });
  const reduce = (l: LegPosition, frac: number) =>
    p.run('reduce', async () => {
      const out = await placeOrder(p.sign, owner, reduceSpec(l, frac, decimals(l.coin)));
      bump();
      return p.done(out, frac >= 1 ? `Closed leg ${l.leg}'s ${l.coin} at market` : `Reduced leg ${l.leg}'s ${l.coin} by ${frac * 100}%`);
    });

  if (!view) return <p className="state">Waiting for data.</p>;

  const field = (label: string, key: keyof OrderForm, props: { placeholder?: string; mode?: 'decimal' | 'numeric' } = {}) => (
    <label className="t-field">
      <span>{label}</span>
      <input value={String(f[key])} onChange={(e) => set({ [key]: e.target.value } as Partial<OrderForm>)} inputMode={props.mode ?? 'decimal'} placeholder={props.placeholder} spellCheck={false} />
    </label>
  );
  const opens = !protective;
  const err = 'error' in built ? built.error : undefined;
  const notional = 'spec' in built && built.spec.size ? Number(built.spec.size) * Number(built.spec.limitPx ?? built.spec.triggerPx ?? mid) : 0;
  const capUse = opens && notional > 0 ? Math.min(1, notional / cap) : 0;

  const ticket =
    ready.length === 0 ? (
      <section className="t-panel t-ticket" aria-labelledby="ticket-h" ref={ticketRef}>
        <h2 id="ticket-h">Order ticket</h2>
        <p className="t-empty">No leg can trade yet: a leg needs its agent key approved on Home, and some USDC on its trading balance.</p>
        <button onClick={() => p.onGo('home')}>Go to Home</button>
      </section>
    ) : (
      <section className="t-panel t-ticket" aria-labelledby="ticket-h" ref={ticketRef}>
        <h2 id="ticket-h" className="sr-only">Order ticket</h2>
        <div className="t-row">
          <label className="t-field grow">
            <span>Trade on</span>
            <select value={f.leg} onChange={(e) => set({ leg: Number(e.target.value) })}>
              {ready.map((l) => <option key={l.leg} value={l.leg}>Leg {l.leg} · {l.address.slice(0, 6)}…{l.address.slice(-4)}</option>)}
            </select>
          </label>
          <label className="t-field">
            <span>Order type</span>
            <select value={f.type} onChange={(e) => set({ type: e.target.value as OrderForm['type'], reduceOnly: CLOSING_TYPES.includes(e.target.value as OrderForm['type']) ? false : f.reduceOnly })}>
              {ORDER_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </div>

        <div role="group" aria-label="Side" className="t-sides">
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} aria-pressed={f.side === s} className={`t-side ${s}`} disabled={closingType && Boolean(closingSide)} onClick={() => set({ side: s })}>
              {s === 'buy' ? 'Buy / Long' : 'Sell / Short'}
            </button>
          ))}
        </div>

        <dl className="t-kv">
          <dt>Leg {f.leg} position</dt>
          <dd className={`t-num ${pos ? (Number(pos.szi) > 0 ? 'up' : 'down') : ''}`}>{pos ? `${n(posSize, szDecimals)} ${f.coin} ${Number(pos.szi) > 0 ? 'long' : 'short'} · ${pos.leverage.value}x ${pos.leverage.type}` : 'Flat'}</dd>
          <dt>Available</dt>
          <dd className="t-num">{usd(leg?.clearinghouse.withdrawable)}</dd>
        </dl>

        {(f.type === 'limit' || f.type === 'stopLimit' || f.type === 'takeLimit') && (
          <div className="t-row">{f.type !== 'limit' && field('Trigger price', 'triggerPx')}{field('Limit price', 'limitPx', { placeholder: mid ? `mark ${roundPx(mid, szDecimals)}` : undefined })}</div>
        )}
        {(f.type === 'stopMarket' || f.type === 'takeMarket') && field('Trigger price', 'triggerPx')}
        {f.type === 'limit' && (
          <label className="t-field">
            <span>Time in force</span>
            <select value={f.tif} onChange={(e) => set({ tif: e.target.value as OrderForm['tif'] })}>
              <option value="Gtc">Good till cancelled</option>
              <option value="Ioc">Immediate or cancel</option>
              <option value="Alo">Post only</option>
            </select>
          </label>
        )}
        {f.type === 'bracket' && <div className="t-row">{field('Take-profit price', 'tpPx')}{field('Stop-loss price', 'slPx')}</div>}
        {f.type === 'twap' && field('Duration, minutes (5 to 1440)', 'minutes', { mode: 'numeric' })}
        {f.type === 'trailing' && (
          <div className="t-row">
            <label className="t-field">
              <span>Trail by</span>
              <select value={f.trailBy} onChange={(e) => set({ trailBy: e.target.value as 'pct' | 'px', trailValue: e.target.value === 'pct' ? '5' : '' })}>
                <option value="pct">Percent</option>
                <option value="px">Price distance</option>
              </select>
            </label>
            {field(f.trailBy === 'pct' ? 'Percent' : 'Distance', 'trailValue')}
            {field('Activate at (optional)', 'activationPx')}
          </div>
        )}

        {f.type !== 'bracket' && (
          <>
            {field(`Size, ${f.coin}`, 'size', { placeholder: mid ? `about ${(cap / mid).toFixed(szDecimals)} fits the $${cap} cap` : undefined })}
            <div className="t-fracs">
              {[0.25, 0.5, 0.75, 1].map((x) => (
                <button key={x} onClick={() => sizeFrom(x)} disabled={protective ? posSize === 0 : mid === 0} title={protective ? 'Of the position' : 'Of the per-order cap'}>
                  {x === 1 ? (protective ? 'All' : 'Max') : `${x * 100}%`}
                </button>
              ))}
            </div>
            {!closingType && (
              <label className="t-check"><input type="checkbox" checked={f.reduceOnly} onChange={(e) => set({ reduceOnly: e.target.checked })} /> Reduce only</label>
            )}
          </>
        )}

        {opens && (
          <div className="t-row">
            <label className="t-field">
              <span>Leverage (up to {maxLev}x)</span>
              <input value={f.leverage} onChange={(e) => set({ leverage: e.target.value })} inputMode="numeric" disabled={f.keepLeverage} aria-invalid={!f.keepLeverage && !(Number(f.leverage) >= 1 && Number(f.leverage) <= maxLev)} />
            </label>
            <label className="t-field">
              <span>Margin</span>
              <select value={f.isCross ? 'cross' : 'isolated'} onChange={(e) => set({ isCross: e.target.value === 'cross' })} disabled={f.keepLeverage}>
                <option value="cross">Cross</option>
                <option value="isolated">Isolated</option>
              </select>
            </label>
          </div>
        )}
        {opens && pos && (
          <label className="t-check"><input type="checkbox" checked={f.keepLeverage} onChange={(e) => set({ keepLeverage: e.target.checked })} /> Keep the leg's {pos.leverage.value}x {pos.leverage.type}</label>
        )}

        {opens && (
          <div className="t-policy">
            <div className="t-policy-l"><span>Agent policy</span><span className="muted">{coins.join(', ')} · ≤ {view.orderPolicy.maxLeverage}x · ≤ ${cap} per order</span></div>
            <div className="t-meter" aria-hidden="true"><span className={`t-fill ${notional > cap ? 'down' : 'info'}`} style={{ width: `${capUse * 100}%` }} /></div>
            <div className="t-policy-l muted"><span>This order {notional ? usd(notional) : '—'}</span><span>{notional > cap ? `${usd(notional - cap)} over the cap` : `${usd(Math.max(0, cap - notional))} left under the cap`}</span></div>
          </div>
        )}

        <p className={err ? 't-msg err' : 't-msg'} role={err ? 'alert' : undefined}>{err ?? ('spec' in built ? describeSpec(built.spec, mid) : '')}</p>
        <button className={`t-submit ${f.side}`} disabled={p.locked || Boolean(err)} title={p.why} onClick={submit}>
          {p.session?.spec ? 'Send' : 'Sign'} · {f.side === 'buy' ? 'Buy / Long' : 'Sell / Short'}{'spec' in built && built.spec.size ? ` ${built.spec.size} ${f.coin}` : ''}
        </button>
        {pos && <button className="t-link" onClick={() => p.onGo(`hedge?coin=${f.coin}`)}>Hedge this position on another leg</button>}
        {p.session && <SessionControl s={p.session} run={p.run} locked={p.locked} why={p.why} />}
      </section>
    );

  return (
    <div className="terminal">
      <MarketBar coin={f.coin} coins={coins} onCoin={(coin) => set({ coin })} market={market} fallbackMark={mid} network={network} />
      <PriceChart candles={market.candles} lines={lines} interval={recorded ? '15m' : interval} onInterval={setInterval_} note={market.note} error={market.error} fixed={recorded} />
      <BookPanel
        book={market.book}
        trades={market.trades}
        mark={mid}
        coin={f.coin}
        recorded={recorded}
        grouping={grouping}
        onGrouping={setGrouping}
        onPrice={(px) => toTicket({ limitPx: roundPx(px, szDecimals), ...(f.type === 'market' ? { type: 'limit' as const } : {}) })}
      />
      <div className="t-side-col">
        {ticket}
        <LegAccount leg={f.leg} snap={leg} guardFloor={GUARD_FLOOR} onGo={p.onGo} />
      </div>
      <Blotter
        positions={positions}
        orders={orders}
        history={history}
        events={p.events}
        coin={f.coin}
        legs={legs.map((l) => l.leg)}
        locked={p.locked}
        why={p.why}
        decimals={decimals}
        onReduce={reduce}
        onCloseHedge={p.onCloseHedge}
        onProtect={(l) => toTicket({ leg: l.leg, coin: l.coin, type: 'bracket', reduceOnly: false })}
        onLimitClose={(l) => toTicket({ leg: l.leg, coin: l.coin, type: 'limit', side: l.side === 'long' ? 'sell' : 'buy', size: floorSize(l.size, decimals(l.coin)), limitPx: roundPx(l.markPx, decimals(l.coin)), reduceOnly: true, tif: 'Gtc' })}
        onCancel={cancel}
        onCancelAll={cancelAll}
      />
    </div>
  );
}

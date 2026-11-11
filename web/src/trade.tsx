// Trade tab: one order ticket for any registered leg (a one-sided trade is just an order on one leg), the leg's open orders with Cancel,
// and the bracket / trailing / TWAP order types. Every order is a signed command that carries the exact spec (web/src/trading.ts).
import { useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import type { OwnerView } from './api';
import { n, usd } from './panels';
import { buildSpec, CLOSING_TYPES, describeSpec, emptyForm, TYPE_LABEL, type OrderForm } from './orderForm';
import { SessionControl, type SessionApi } from './session';
import { cancelOrder, getOrders, ORDER_TYPES, placeOrder, type OpenOrder, type RunningTwap, type Sign } from './trading';

export interface TradeProps {
  view?: OwnerView;
  owner: Hex;
  canSign: boolean;
  locked: boolean;
  why?: string;
  sign: Sign;
  /** 1-click trading session (signs orders and cancels without the wallet) */
  session?: SessionApi;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  done: (out: Record<string, unknown>, what: string) => string;
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
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    getOrders(owner).then((o) => live && setOrders(o), () => live && setOrders(undefined));
    return () => {
      live = false;
    };
  }, [owner, version, view?.snapshot.at]);

  const asset = view?.snapshot.market.assets?.find((a) => a.name === f.coin);
  const szDecimals = asset?.szDecimals ?? 5;
  const mid = Number(view?.snapshot.market.mids[f.coin] ?? 0);
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
  const sizeFrom = (frac: number) => {
    const ref = protective ? posSize : mid > 0 ? cap / mid : 0;
    const s = Math.floor(ref * frac * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;
    set({ size: s > 0 ? String(s) : '' });
  };

  const submit = () =>
    p.run('order', async () => {
      if ('error' in built) throw new Error(built.error);
      const out = await placeOrder(p.sign, owner, built.spec);
      setVersion((v) => v + 1);
      return p.done(out, describeSpec(built.spec, mid).replace(/\.$/, ''));
    });
  const cancel = (o: OpenOrder | RunningTwap) =>
    p.run('cancel', async () => {
      const spec = 'oid' in o ? { leg: o.leg, coin: o.coin, oid: o.oid } : { leg: o.leg, coin: o.coin, twapId: o.twapId };
      const out = await cancelOrder(p.sign, owner, spec);
      setVersion((v) => v + 1);
      return p.done(out, 'Order cancelled');
    });

  if (!view) return <p className="state">Waiting for data.</p>;
  if (ready.length === 0) {
    return (
      <section className="card" aria-labelledby="trade-h">
        <h2 id="trade-h">Trade</h2>
        <p className="state">No leg can trade yet: a leg needs its agent key approved on Home, and some USDC on its trading balance.</p>
        <div className="actions"><button onClick={() => p.onGo('home')}>Go to Home</button></div>
      </section>
    );
  }

  const field = (label: string, key: keyof OrderForm, props: { placeholder?: string; mode?: 'decimal' | 'numeric' } = {}) => (
    <label>
      {label}
      <input value={String(f[key])} onChange={(e) => set({ [key]: e.target.value } as Partial<OrderForm>)} inputMode={props.mode ?? 'decimal'} placeholder={props.placeholder} spellCheck={false} />
    </label>
  );
  const opens = !protective;
  const err = 'error' in built ? built.error : undefined;

  return (
    <div className="grid">
      <div className="col">
        <section className="card" aria-labelledby="trade-h">
          <h2 id="trade-h">Order ticket</h2>
          <p className="muted small">
            Trade one leg on its own, or build the first half of a hedge. Hyperliquid fills and holds it; you sign the exact order below (with your wallet, or the 1-click session key if it is on), it expires in 30 s. The agent refuses leverage above {view.orderPolicy.maxLeverage}x and opening orders above ${cap}.
          </p>
          <div className="fields inline">
            <label>
              Leg
              <select value={f.leg} onChange={(e) => set({ leg: Number(e.target.value) })}>
                {ready.map((l) => <option key={l.leg} value={l.leg}>Leg {l.leg}</option>)}
              </select>
            </label>
            <label>
              Coin
              <select value={f.coin} onChange={(e) => set({ coin: e.target.value })}>
                {coins.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <p className="state small" style={{ paddingTop: 0 }}>
            {pos ? `Leg ${f.leg} holds ${n(Math.abs(Number(pos.szi)), szDecimals)} ${f.coin} ${Number(pos.szi) > 0 ? 'long' : 'short'} at ${pos.leverage.value}x ${pos.leverage.type}, entry ${usd(pos.entryPx)}, unrealized ${usd(pos.unrealizedPnl)}.` : `Leg ${f.leg} is flat on ${f.coin}.`} Mark {usd(mid)}.
          </p>

          <fieldset className="mode" aria-label="Side">
            {(['buy', 'sell'] as const).map((s) => (
              <button key={s} aria-pressed={f.side === s} className={f.side === s ? 'primary' : ''} disabled={closingType && Boolean(closingSide)} onClick={() => set({ side: s })}>
                {s === 'buy' ? 'Buy / long' : 'Sell / short'}
              </button>
            ))}
          </fieldset>

          <div className="fields inline">
            <label>
              Order type
              <select value={f.type} onChange={(e) => set({ type: e.target.value as OrderForm['type'], reduceOnly: CLOSING_TYPES.includes(e.target.value as OrderForm['type']) ? false : f.reduceOnly })}>
                {ORDER_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            {f.type !== 'bracket' && field(`Size, ${f.coin}`, 'size', { placeholder: mid ? `about ${(cap / mid).toFixed(szDecimals)} fits the $${cap} cap` : undefined })}
          </div>
          {f.type !== 'bracket' && (
            <div className="actions" style={{ margin: '0 0 12px' }}>
              {[0.25, 0.5, 0.75, 1].map((x) => (
                <button key={x} onClick={() => sizeFrom(x)} disabled={protective ? posSize === 0 : mid === 0}>{x * 100}%{protective ? ' of position' : ''}</button>
              ))}
              {!closingType && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={f.reduceOnly} onChange={(e) => set({ reduceOnly: e.target.checked })} style={{ width: 'auto' }} /> Reduce only
                </label>
              )}
            </div>
          )}

          {(f.type === 'limit' || f.type === 'stopLimit' || f.type === 'takeLimit') && <div className="fields inline">{f.type !== 'limit' && field('Trigger price', 'triggerPx')}{field('Limit price', 'limitPx')}</div>}
          {(f.type === 'stopMarket' || f.type === 'takeMarket') && <div className="fields">{field('Trigger price', 'triggerPx')}</div>}
          {f.type === 'limit' && (
            <label>
              Time in force
              <select value={f.tif} onChange={(e) => set({ tif: e.target.value as OrderForm['tif'] })}>
                <option value="Gtc">Good till cancelled</option>
                <option value="Ioc">Immediate or cancel</option>
                <option value="Alo">Post only</option>
              </select>
            </label>
          )}
          {f.type === 'bracket' && <div className="fields inline">{field('Take-profit price', 'tpPx')}{field('Stop-loss price', 'slPx')}</div>}
          {f.type === 'twap' && <div className="fields">{field('Duration, minutes (5 to 1440)', 'minutes', { mode: 'numeric' })}<p className="muted small">Hyperliquid wants at least $100 for a TWAP; the agent's cap is ${cap} per order, so raise HYPERNEAR_MAX_NOTIONAL_USD for more.</p></div>}
          {f.type === 'trailing' && (
            <div className="fields inline">
              <label>
                Trail by
                <select value={f.trailBy} onChange={(e) => set({ trailBy: e.target.value as 'pct' | 'px', trailValue: e.target.value === 'pct' ? '5' : '' })}>
                  <option value="pct">percent from the best price</option>
                  <option value="px">price distance</option>
                </select>
              </label>
              {field(f.trailBy === 'pct' ? 'Percent' : 'Distance', 'trailValue')}
              {field('Activation price (optional)', 'activationPx')}
            </div>
          )}

          {opens && (
            <div className="fields inline">
              <label>
                Leverage (up to {maxLev}x)
                <input value={f.leverage} onChange={(e) => set({ leverage: e.target.value })} inputMode="numeric" disabled={f.keepLeverage} aria-invalid={!f.keepLeverage && !(Number(f.leverage) >= 1 && Number(f.leverage) <= maxLev)} />
              </label>
              <label>
                Margin
                <select value={f.isCross ? 'cross' : 'isolated'} onChange={(e) => set({ isCross: e.target.value === 'cross' })} disabled={f.keepLeverage}>
                  <option value="cross">Cross</option>
                  <option value="isolated">Isolated</option>
                </select>
              </label>
            </div>
          )}
          {opens && pos && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={f.keepLeverage} onChange={(e) => set({ keepLeverage: e.target.checked })} style={{ width: 'auto' }} /> Keep the leg's {pos.leverage.value}x {pos.leverage.type}
            </label>
          )}

          <p className={err ? 'state err' : 'state'} role={err ? 'alert' : undefined}>{err ?? ('spec' in built ? describeSpec(built.spec, mid) : '')}</p>
          <div className="actions">
            <button className="primary" disabled={p.locked || Boolean(err)} title={p.why} onClick={submit}>{'Sign and send'}</button>
            {pos && <button onClick={() => p.onGo(`hedge?coin=${f.coin}`)}>Hedge this on leg 1</button>}
          </div>
          {p.session && <SessionControl s={p.session} run={p.run} locked={p.locked} why={p.why} />}
        </section>
      </div>

      <div className="col">
        <section className="card" aria-labelledby="orders-h">
          <h2 id="orders-h">Open orders</h2>
          {!orders || (orders.orders.length === 0 && orders.twaps.length === 0) ? (
            <p className="state">{orders ? 'Nothing is resting on any leg.' : 'Reading open orders…'}</p>
          ) : (
            <div className="scroll">
              <table className="mini">
                <thead><tr><th>Leg</th><th>Order</th><th className="num">Size</th><th className="num">Price</th><th /></tr></thead>
                <tbody>
                  {orders.orders.map((o) => (
                    <tr key={o.oid}>
                      <td>{o.leg}</td>
                      <td>{o.coin} {o.side}<br /><span className="muted small">{o.orderType}{o.isPositionTpsl ? ', follows the position' : ''}{o.reduceOnly ? ', reduce only' : ''}</span></td>
                      <td className="num">{o.isPositionTpsl ? 'whole position' : o.size}</td>
                      <td className="num">{o.isTrigger && Number(o.triggerPx) > 0 ? usd(o.triggerPx) : usd(o.limitPx)}</td>
                      <td><button disabled={p.locked} title={p.why} onClick={() => cancel(o)}>Cancel</button></td>
                    </tr>
                  ))}
                  {orders.twaps.map((t) => (
                    <tr key={`twap${t.twapId}`}>
                      <td>{t.leg}</td>
                      <td>{t.coin} {t.side}<br /><span className="muted small">TWAP, {t.minutes} min</span></td>
                      <td className="num">{t.executedSize} of {t.size}</td>
                      <td className="num">market</td>
                      <td><button disabled={p.locked} title={p.why} onClick={() => cancel(t)}>Stop</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">A freeze cancels resting orders, protective ones included.</p>
        </section>
      </div>
    </div>
  );
}

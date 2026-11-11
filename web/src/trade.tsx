// Trade tab: a trading terminal. Market bar, chart with each leg's lines, order book and trades (live from Hyperliquid,
// market.ts), the order ticket for any registered leg with that leg's account under it, and the blotter: positions grouped
// by hedge, open orders, TWAP, history and the agent's activity. Every order is a signed command that carries the exact spec
// (web/src/trading.ts), signed by the wallet or by the 1-click session key.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import type { AgentEvent, OwnerView } from './api';
import type { Interval } from './hl';
import { useMarket } from './market';
import { emptyForm, type OrderForm } from './orderForm';
import type { SessionApi } from './session';
import { Ticket } from './ticket';
import { Blotter, BookPanel, chartLines, LegAccount, MarketBar, PriceChart } from './terminal';
import {
  cancelOrder, floorSize, getHistory, getOrders, getPositions, placeOrder, reduceSpec, roundPx,
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
  /** from a link: #/trade?mode=hedge */
  mode?: 'single' | 'hedge';
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
  const ticketRef = useRef<HTMLDivElement>(null);
  // phones: one market pane at a time, and the ticket as a sheet opened from the Buy / Sell bar
  const [pane, setPane] = useState<'chart' | 'book' | 'trades'>('chart');
  const [sheet, setSheet] = useState(false);

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
  const mid = market.ctx?.markPx ?? Number(view?.snapshot.market.mids[f.coin] ?? 0);
  const leg = view?.snapshot.legs.find((l) => l.leg === f.leg);
  const lines = useMemo(() => chartLines(view, f.coin, orders?.orders), [view, f.coin, orders]);
  const bump = () => setVersion((v) => v + 1);
  const toTicket = (patch: Partial<OrderForm>) => {
    set(patch);
    setSheet(true);
    ticketRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ticketRef.current?.querySelector<HTMLElement>('select, input')?.focus({ preventScroll: true });
  };

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

  return (
    <div className="terminal" data-pane={pane}>
      <MarketBar coin={f.coin} coins={coins} onCoin={(coin) => set({ coin })} market={market} fallbackMark={mid} network={network} />
      <div className="t-panel t-phone-tabs" role="tablist" aria-label="Market view">
        {(['chart', 'book', 'trades'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={pane === x} onClick={() => setPane(x)}>{x === 'chart' ? 'Chart' : x === 'book' ? 'Order book' : 'Trades'}</button>
        ))}
      </div>
      <PriceChart candles={market.candles} lines={lines} interval={recorded ? '15m' : interval} onInterval={setInterval_} note={market.note} error={market.error} fixed={recorded} />
      <BookPanel
        book={market.book}
        trades={market.trades}
        mark={mid}
        coin={f.coin}
        recorded={recorded}
        grouping={grouping}
        onGrouping={setGrouping}
        tab={pane === 'trades' ? 'trades' : pane === 'book' ? 'book' : undefined}
        onTab={(t) => setPane(t)}
        onPrice={(px) => toTicket({ limitPx: roundPx(px, szDecimals), ...(f.type === 'market' ? { type: 'limit' as const } : {}) })}
      />
      <div className="t-side-col" ref={ticketRef}>
        <div className={`t-sheet ${sheet ? 'open' : ''}`} role={sheet ? 'dialog' : undefined} aria-label={sheet ? `${f.coin} order` : undefined}>
          <div className="t-sheet-head">
            <span className="t-grab" aria-hidden="true" />
            <b>{f.coin} order</b>
            <button aria-label="Close the order sheet" onClick={() => setSheet(false)}>×</button>
          </div>
          <Ticket view={view} owner={owner} f={f} set={set} mid={mid} locked={p.locked} why={p.why} sign={p.sign} session={p.session} run={p.run} done={p.done} onPlaced={() => (bump(), setSheet(false))} onCloseHedge={p.onCloseHedge} onGo={p.onGo} initialMode={p.mode} />
        </div>
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
      {sheet && <div className="t-backdrop" onClick={() => setSheet(false)} aria-hidden="true" />}
      <div className="t-phone-bar">
        <button className="t-submit buy" onClick={() => toTicket({ side: 'buy' })}>Buy / Long</button>
        <button className="t-submit sell" onClick={() => toTicket({ side: 'sell' })}>Sell / Short</button>
      </div>
    </div>
  );
}

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
import { LimitCloseModal, ProtectModal } from './protectModal';
import type { ProtectTarget } from './positions';
import { Ticket } from './ticket';
import { Blotter, BookPanel, chartLines, LegAccount, MarketBar, PriceChart, type Layout } from './terminal';
import {
  cancelOrder, getHistory, getOrders, getPositions, modifyOrder, placeOrder, reduceSpec, roundPx, setProtection,
  type Composite, type HistoryRow, type LegPosition, type OpenOrder, type ProtectSpec, type RunningTwap, type Sign,
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
  onCloseHedge: (coin: string, legs?: number[]) => void;
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
  // a dragged limit order waiting for confirmation, the shortcut list, and the remembered layout
  const [move, setMove] = useState<{ order: OpenOrder; px: string }>();
  const [help, setHelp] = useState(false);
  // the TP/SL and limit-close dialogs opened from a position row
  const [protect, setProtect] = useState<ProtectTarget>();
  const [limitClose, setLimitClose] = useState<LegPosition>();
  const [layout, setLayoutState] = useState<Layout>(() => {
    try {
      const v = localStorage.getItem('hypernear.layout');
      return v === 'chart' || v === 'book-left' ? v : 'standard';
    } catch {
      return 'standard';
    }
  });
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem('hypernear.layout', l);
    } catch {
      /* storage off: the layout lasts until reload */
    }
  };

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
  const confirmMove = () =>
    move &&
    p.run('modify', async () => {
      const { order: o, px } = move;
      const out = await modifyOrder(p.sign, owner, { leg: o.leg, coin: o.coin, oid: o.oid, limitPx: px });
      setMove(undefined);
      bump();
      return p.done(out, `Moved leg ${o.leg}'s ${o.coin} limit ${o.side} from ${o.limitPx} to ${px}`);
    });

  // keyboard: B / S side, M / L order type, F size, Ctrl or Cmd + Enter sends, Esc closes, ? lists them
  const keys = useRef({ f, mid, szDecimals: decimals(f.coin) });
  keys.current = { f, mid, szDecimals: decimals(f.coin) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const b = document.querySelector<HTMLButtonElement>('.t-ticket .t-submit');
        if (b && !b.disabled) {
          e.preventDefault();
          b.click();
        }
        return;
      }
      if (e.key === 'Escape') {
        setSheet(false);
        setMove(undefined);
        setHelp(false);
        if (typing) t!.blur();
        return;
      }
      if (typing || e.altKey || e.metaKey || e.ctrlKey) return;
      const k = keys.current;
      switch (e.key) {
        case 'b': case 'B': set({ side: 'buy' }); break;
        case 's': case 'S': set({ side: 'sell' }); break;
        case 'm': case 'M': set({ type: 'market' }); break;
        case 'l': case 'L': set({ type: 'limit', limitPx: k.f.limitPx || (k.mid ? roundPx(k.mid, k.szDecimals) : '') }); break;
        case 'f': case 'F': document.querySelector<HTMLInputElement>('.t-ticket .t-input.strong input')?.focus(); break;
        case '?': setHelp((h) => !h); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reduce = (l: LegPosition, frac: number) =>
    p.run('reduce', async () => {
      const out = await placeOrder(p.sign, owner, reduceSpec(l, frac, decimals(l.coin)));
      bump();
      return p.done(out, frac >= 1 ? `Closed leg ${l.leg}'s ${l.coin} at market` : `Reduced leg ${l.leg}'s ${l.coin} by ${frac * 100}%`);
    });

  const saveProtection = (spec: ProtectSpec) =>
    p.run('protect', async () => {
      const out = await setProtection(p.sign, owner, spec);
      bump();
      setProtect(undefined);
      const what = spec.upPx === undefined && spec.downPx === undefined ? 'removed' : 'set';
      const names = spec.legs.length > 1 ? `legs ${spec.legs.join(' and ')}` : `leg ${spec.legs[0]}`;
      if (out.status === 'failed') throw new Error(`TP/SL was not ${what}: ${out.legs.map((l) => `leg ${l.leg}: ${l.error}`).join('; ')}`);
      if (out.status === 'partial') throw new Error(`TP/SL ${what} on part of the hedge only: ${out.legs.map((l) => (l.ok ? `leg ${l.leg} done` : `leg ${l.leg} failed (${l.error})`)).join('; ')}`);
      return p.done(out, `TP/SL ${what} on ${names} ${spec.coin}`);
    });
  const placeLimitClose = (l: LegPosition, price: string, size: string) =>
    p.run('limit', async () => {
      const out = await placeOrder(p.sign, owner, { leg: l.leg, coin: l.coin, side: l.side === 'long' ? 'sell' : 'buy', type: 'limit', size, limitPx: price, tif: 'Gtc', reduceOnly: true });
      bump();
      setLimitClose(undefined);
      return p.done(out, `Limit close for ${size} ${l.coin} on leg ${l.leg} at ${price}`);
    });
  const maxLev = (coin: string) => {
    const m = view?.snapshot.market.assets?.find((a) => a.name === coin)?.maxLeverage;
    return m === undefined ? undefined : Math.min(m, view?.orderPolicy.maxLeverage ?? m);
  };

  if (!view) return <p className="state">Waiting for data.</p>;

  return (
    <div className="terminal" data-pane={pane} data-layout={layout}>
      <MarketBar coin={f.coin} coins={coins} onCoin={(coin) => set({ coin })} market={market} fallbackMark={mid} network={network} layout={layout} onLayout={setLayout} onHelp={() => setHelp((h) => !h)} />
      {help && (
        <div className="t-help" role="dialog" aria-label="Keyboard shortcuts">
          <div className="t-head"><b>Keyboard shortcuts</b><button aria-label="Close" onClick={() => setHelp(false)}>×</button></div>
          <dl>
            <dt><kbd>B</kbd> / <kbd>S</kbd></dt><dd>Buy / Sell side</dd>
            <dt><kbd>M</kbd> / <kbd>L</kbd></dt><dd>Market / Limit (at the mark)</dd>
            <dt><kbd>F</kbd></dt><dd>Type the size</dd>
            <dt><kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>Enter</kbd></dt><dd>Send the ticket (your wallet still asks unless 1-click is on)</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close a sheet or dialog, leave a field</dd>
            <dt>Drag a limit line</dt><dd>Move that order on the chart</dd>
            <dt><kbd>?</kbd></dt><dd>Show this list</dd>
          </dl>
        </div>
      )}
      <div className="t-panel t-phone-tabs" role="tablist" aria-label="Market view">
        {(['chart', 'book', 'trades'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={pane === x} onClick={() => setPane(x)}>{x === 'chart' ? 'Chart' : x === 'book' ? 'Order book' : 'Trades'}</button>
        ))}
      </div>
      <PriceChart
        onDrag={(l, price) => {
          const o = orders?.orders.find((x) => x.oid === l.drag?.oid);
          if (o) setMove({ order: o, px: roundPx(price, decimals(o.coin)) });
        }}
        overlay={
          move && (
            <div className="t-move" role="dialog" aria-label="Move order">
              <span>Move leg {move.order.leg} limit {move.order.side} {move.order.size} {move.order.coin} from <b className="t-num">{move.order.limitPx}</b> to</span>
              <label className="sr-only" htmlFor="move-px">New price</label>
              <input id="move-px" className="t-num" value={move.px} onChange={(e) => setMove({ ...move, px: e.target.value })} inputMode="decimal" />
              <button className="primary" disabled={p.locked} title={p.why} onClick={confirmMove}>{p.session?.spec ? 'Move' : 'Sign · Move'}</button>
              <button onClick={() => setMove(undefined)}>Cancel</button>
            </div>
          )
        }
        candles={market.candles} lines={lines} interval={recorded ? '15m' : interval} onInterval={setInterval_} note={market.note} error={market.error} fixed={recorded} />
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
          <Ticket view={view} owner={owner} f={f} set={set} mid={mid} book={market.book?.bids[0] && market.book.asks[0] ? { bid: market.book.bids[0].px, ask: market.book.asks[0].px } : undefined} locked={p.locked} why={p.why} sign={p.sign} session={p.session} run={p.run} done={p.done} onPlaced={() => (bump(), setSheet(false))} onCloseHedge={p.onCloseHedge} onGo={p.onGo} initialMode={p.mode} />
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
        onCloseHedge={(c) => p.onCloseHedge(c.coin, c.legs.map((l) => l.leg))}
        onTpsl={setProtect}
        maxLev={maxLev}
        onLimit={setLimitClose}
        onCancel={cancel}
        onCancelAll={cancelAll}
      />
      {protect && (
        <ProtectModal
          target={protect}
          orders={orders?.orders ?? []}
          mark={Number(view.snapshot.market.mids[protect.coin] ?? protect.legs[0]!.markPx)}
          decimals={decimals(protect.coin)}
          busy={p.locked}
          onSave={saveProtection}
          onClose={() => setProtect(undefined)}
        />
      )}
      {limitClose && (
        <LimitCloseModal
          leg={limitClose}
          bid={market.book?.bids[0]?.px}
          ask={market.book?.asks[0]?.px}
          mark={Number(view.snapshot.market.mids[limitClose.coin] ?? limitClose.markPx)}
          decimals={decimals(limitClose.coin)}
          busy={p.locked}
          onSave={(price, size) => placeLimitClose(limitClose, price, size)}
          onClose={() => setLimitClose(undefined)}
        />
      )}
      {sheet && <div className="t-backdrop" onClick={() => setSheet(false)} aria-hidden="true" />}
      <div className="t-phone-bar">
        <button className="t-submit buy" onClick={() => toTicket({ side: 'buy' })}>Buy / Long</button>
        <button className="t-submit sell" onClick={() => toTicket({ side: 'sell' })}>Sell / Short</button>
      </div>
    </div>
  );
}

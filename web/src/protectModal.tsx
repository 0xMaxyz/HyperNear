// TP/SL and Limit-close dialogs opened from a position row. TP/SL shows the levels now in force (read from the open orders), takes new ones as a
// price or a percentage, shows what each level would make or lose, and saves with ONE signature. For a hedge the same two price levels are set on
// both legs (the agent gives each leg the right role for its side), so Hyperliquid fires both exits when the price crosses either level.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pxFmt, signedUsd } from './fmt';
import type { ProtectTarget } from './positions';
import { roundPx, type LegPosition, type OpenOrder, type ProtectSpec } from './trading';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    box.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={box} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>{title}</b><button aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}

/** The levels in force on a leg, from its position take-profit / stop-loss triggers: `up` is above the market, `down` below it. */
export function currentLevels(orders: OpenOrder[], leg: LegPosition): { up?: number; down?: number } {
  const out: { up?: number; down?: number } = {};
  for (const o of orders) {
    if (o.leg !== leg.leg || o.coin !== leg.coin || !o.isTrigger || !(o.isPositionTpsl || o.reduceOnly)) continue;
    const px = Number(o.triggerPx);
    if (!(px > 0)) continue;
    const takeProfit = /take profit/i.test(o.orderType);
    // a long takes profit above the market and stops loss below it; a short the other way round
    const up = leg.side === 'long' ? takeProfit : !takeProfit;
    out[up ? 'up' : 'down'] = px;
  }
  return out;
}

/** PnL of the target's legs if the price goes to `px` (price result only, before fees). */
export const pnlAt = (legs: LegPosition[], px: number) => legs.reduce((s, l) => s + (l.side === 'long' ? px - l.entryPx : l.entryPx - px) * l.size, 0);

export function ProtectModal({ target, orders, mark, decimals, busy, onSave, onClose }: {
  target: ProtectTarget;
  orders: OpenOrder[];
  mark: number;
  decimals: number;
  busy: boolean;
  onSave: (spec: ProtectSpec) => void;
  onClose: () => void;
}) {
  const { coin, legs, hedge } = target;
  const now = currentLevels(orders, legs[0]!);
  const differ = legs.some((l) => JSON.stringify(currentLevels(orders, l)) !== JSON.stringify(now));
  const [up, setUp] = useState(now.up ? String(now.up) : '');
  const [down, setDown] = useState(now.down ? String(now.down) : '');
  const long = legs[0]!.side === 'long';
  // single position: the user's own words; a hedge: what closes it
  const upLabel = hedge ? 'Close both legs if the price rises to' : long ? 'Take profit at' : 'Stop loss at';
  const downLabel = hedge ? 'Close both legs if the price falls to' : long ? 'Stop loss at' : 'Take profit at';
  const num = (t: string) => (t.trim() === '' ? undefined : Number(t));
  const u = num(up);
  const d = num(down);
  const bad = (name: string, v: number | undefined, above: boolean) =>
    v === undefined ? undefined
    : !(v > 0) || !Number.isFinite(v) ? `${name} must be a price`
    : roundPx(v, decimals) !== String(v) ? `${name} ${v} is not a price Hyperliquid accepts here: try ${roundPx(v, decimals)}`
    : above ? (v <= mark ? `${name} must be above the current price ${pxFmt(mark)}` : undefined)
    : v >= mark ? `${name} must be below the current price ${pxFmt(mark)}` : undefined;
  const err = bad('The upper level', u, true) ?? bad('The lower level', d, false);
  const pctOf = (v: number) => `${v >= mark ? '+' : '−'}${(Math.abs(v / mark - 1) * 100).toFixed(1)}%`;
  const unchanged = (u ?? 0) === (now.up ?? 0) && (d ?? 0) === (now.down ?? 0);
  const spec = (): ProtectSpec => ({ coin, legs: legs.map((l) => l.leg), ...(u !== undefined ? { upPx: String(u) } : {}), ...(d !== undefined ? { downPx: String(d) } : {}) });
  const row = (label: string, v: string, set: (t: string) => void, level: number | undefined, id: string) => (
    <div className="t-input stack">
      <label htmlFor={id}>{label}</label>
      <div className="t-row tight">
        <input id={id} value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" spellCheck={false} placeholder="No level" />
        <button type="button" disabled={!v} onClick={() => set('')}>Clear</button>
      </div>
      <small className="muted t-num">{level !== undefined && level > 0 ? `${pctOf(level)} from the price · ${signedUsd(pnlAt(legs, level))} on ${hedge ? 'both legs' : 'this position'}, before fees` : 'Set a price, or leave empty for none'}</small>
    </div>
  );
  return (
    <Modal title={`${hedge ? 'Hedge' : 'Position'} TP/SL · ${coin}`} onClose={onClose}>
      <p className="muted small">
        {hedge
          ? `Legs ${legs.map((l) => l.leg).join(' and ')} get the same two prices. Whichever the market reaches first, both legs close.`
          : `Leg ${legs[0]!.leg} ${long ? 'long' : 'short'} ${legs[0]!.size} ${coin}, entry ${pxFmt(legs[0]!.entryPx)}. The order follows the position if you resize it.`}
        {' '}Current price {pxFmt(mark)}.
      </p>
      {differ && <p className="t-msg err" role="note">The legs have different levels now. Saving gives both the levels below.</p>}
      {row(upLabel, up, setUp, u, 'tpsl-up')}
      {row(downLabel, down, setDown, d, 'tpsl-down')}
      {err && <p className="t-msg err" role="alert">{err}</p>}
      <div className="modal-actions">
        <button className="primary" disabled={busy || Boolean(err) || (unchanged && !differ)} onClick={() => onSave(spec())}>{busy ? 'Saving…' : up === '' && down === '' ? 'Sign · Remove TP/SL' : 'Sign · Save TP/SL'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
      <p className="muted small">{hedge ? 'The two exits are sent to the exchange together and fire off the same price, but they are two orders on two accounts, not one transaction. A later change to one leg does not move the other leg\'s levels.' : 'The exchange holds these orders; nothing needs to stay open. A freeze cancels them.'}</p>
    </Modal>
  );
}

/** Close a position (or part of it) with a limit order at a price you choose: a reduce-only limit that rests until the price arrives. */
export function LimitCloseModal({ leg, bid, ask, mark, decimals, busy, onSave, onClose }: {
  leg: LegPosition;
  bid?: number;
  ask?: number;
  mark: number;
  decimals: number;
  busy: boolean;
  onSave: (price: string, size: string) => void;
  onClose: () => void;
}) {
  const long = leg.side === 'long';
  const [price, setPrice] = useState(roundPx(mark, decimals));
  const [share, setShare] = useState(1);
  const size = String(Number((leg.size * share).toFixed(decimals)));
  const px = Number(price);
  const err = !(px > 0) ? 'Enter a price' : roundPx(px, decimals) !== String(px) ? `Not a price Hyperliquid accepts here: try ${roundPx(px, decimals)}` : Number(size) <= 0 ? 'Size is too small' : undefined;
  const makes = (long ? px - leg.entryPx : leg.entryPx - px) * Number(size);
  // a sell limit below the market, or a buy limit above it, would fill at once as a taker
  const crosses = long ? px <= mark : px >= mark;
  return (
    <Modal title={`Close with a limit · leg ${leg.leg} ${leg.coin}`} onClose={onClose}>
      <p className="muted small">Leg {leg.leg} {long ? 'long' : 'short'} {leg.size} {leg.coin}, entry {pxFmt(leg.entryPx)}, price {pxFmt(mark)}. This {long ? 'sells' : 'buys'} {size} {leg.coin} when the price reaches your limit.</p>
      <div className="t-input stack">
        <label htmlFor="lim-px">Limit price</label>
        <div className="t-row tight">
          <input id="lim-px" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" spellCheck={false} />
          <button type="button" onClick={() => setPrice(roundPx(mark, decimals))}>Mid</button>
          {bid && ask && <button type="button" onClick={() => setPrice(roundPx(long ? ask : bid, decimals))}>{long ? 'Best ask' : 'Best bid'}</button>}
        </div>
      </div>
      <div className="t-fracs" role="group" aria-label="How much to close">
        {[0.25, 0.5, 0.75, 1].map((x) => <button key={x} aria-pressed={share === x} onClick={() => setShare(x)}>{x === 1 ? 'All' : `${x * 100}%`}</button>)}
      </div>
      <p className="muted small t-num">{err ?? `${signedUsd(makes)} before fees if it fills at ${pxFmt(px)}${crosses ? '. That price is already reached, so it fills now at the market.' : ''}`}</p>
      <div className="modal-actions">
        <button className="primary" disabled={busy || Boolean(err)} onClick={() => onSave(String(px), size)}>{busy ? 'Placing…' : 'Sign · Place limit close'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

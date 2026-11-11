// Protect a position: stop-loss, take-profit, both, or a trailing stop. These are orders Hyperliquid holds, not strategies this service runs, so
// they keep working while the service is down. Each template turns "5% below the price" into the exact OrderSpec the owner signs.
import { useState } from 'react';
import type { Hex } from 'viem';
import type { OwnerView } from './api';
import { HowItWorks } from './howitworks';
import { n, usd } from './panels';
import { floorSize, placeOrder, roundPx, type OrderSpec, type Sign } from './trading';

export const PROTECT = [
  { id: 'protect-stop', title: 'Stop-loss', blurb: 'Closes the whole position if the price moves against you by the distance you pick.', fields: ['stop'] },
  { id: 'protect-take', title: 'Take-profit', blurb: 'Closes the whole position when the price reaches your target.', fields: ['take'] },
  { id: 'protect-bracket', title: 'Take-profit and stop-loss', blurb: 'Both on the position. Whichever is touched first closes it.', fields: ['take', 'stop'] },
  { id: 'protect-trail', title: 'Trailing stop', blurb: 'A stop that follows the best price at a fixed distance and only ever tightens.', fields: ['trail'] },
  { id: 'protect-trail-activation', title: 'Trailing stop with activation', blurb: 'Trails only after the price reaches an activation level.', fields: ['trail', 'activate'] },
] as const;
type Field = 'stop' | 'take' | 'trail' | 'activate';
const LABEL: Record<Field, string> = { stop: 'Stop-loss distance, %', take: 'Take-profit distance, %', trail: 'Trail by, %', activate: 'Activate after the price moves, %' };
const DEFAULT: Record<Field, string> = { stop: '5', take: '10', trail: '5', activate: '4' };

export interface Held {
  leg: number;
  coin: string;
  szi: number;
  entryPx: number;
  mark: number;
  szDecimals: number;
}

/** The OrderSpec for one template on one position, or why it cannot be built. Prices are rounded to what Hyperliquid accepts. */
export function protectSpec(id: string, h: Held, v: Record<Field, string>): { spec: OrderSpec; text: string } | { error: string } {
  const long = h.szi > 0;
  const side: OrderSpec['side'] = long ? 'sell' : 'buy';
  const num = (f: Field) => Number(v[f]);
  for (const f of PROTECT.find((p) => p.id === id)!.fields as readonly Field[]) {
    if (!/^\d+(\.\d+)?$/.test(v[f]) || !(num(f) > 0) || num(f) >= 100) return { error: `${LABEL[f]} must be above 0 and below 100` };
  }
  const up = (p: number) => roundPx(h.mark * (1 + p / 100), h.szDecimals);
  const down = (p: number) => roundPx(h.mark * (1 - p / 100), h.szDecimals);
  const against = (p: number) => (long ? down(p) : up(p));
  const toward = (p: number) => (long ? up(p) : down(p));
  const size = floorSize(Math.abs(h.szi), h.szDecimals);
  const base = { leg: h.leg, coin: h.coin, side };
  const pnlAt = (px: string) => (Number(px) - h.entryPx) * h.szi;
  const money = (x: number) => `${x < 0 ? '-' : '+'}${usd(Math.abs(x))}`;
  const word = `${n(Math.abs(h.szi), h.szDecimals)} ${h.coin} ${long ? 'long' : 'short'}`;
  switch (id) {
    case 'protect-stop': {
      const px = against(num('stop'));
      return { spec: { ...base, type: 'stopMarket', size, triggerPx: px, reduceOnly: true }, text: `If ${h.coin} ${long ? 'falls' : 'rises'} to ${usd(px, 0)} this closes your ${word}, about ${money(pnlAt(px))} against your entry.` };
    }
    case 'protect-take': {
      const px = toward(num('take'));
      return { spec: { ...base, type: 'takeMarket', size, triggerPx: px, reduceOnly: true }, text: `If ${h.coin} ${long ? 'rises' : 'falls'} to ${usd(px, 0)} this closes your ${word}, about ${money(pnlAt(px))} against your entry.` };
    }
    case 'protect-bracket': {
      const tp = toward(num('take'));
      const sl = against(num('stop'));
      return { spec: { ...base, type: 'bracket', tpPx: tp, slPx: sl }, text: `Closes your ${word} at ${usd(tp, 0)} (about ${money(pnlAt(tp))}) or at ${usd(sl, 0)} (about ${money(pnlAt(sl))}), whichever comes first. It follows the position if you reduce it.` };
    }
    case 'protect-trail':
      return { spec: { ...base, type: 'trailing', size, trailPct: String(num('trail')) }, text: `Starts at ${usd(against(num('trail')), 0)} and follows the best price, ${num('trail')}% behind. It closes your ${word} when the price falls back to it.` };
    case 'protect-trail-activation': {
      const act = toward(num('activate'));
      return { spec: { ...base, type: 'trailing', size, trailPct: String(num('trail')), activationPx: act }, text: `Waits until ${h.coin} reaches ${usd(act, 0)}, then trails ${num('trail')}% behind the best price and closes your ${word} when it falls back.` };
    }
    default:
      return { error: 'unknown protection' };
  }
}

export function ProtectPanel({ view, owner, canSign, sign, preselect, onDone }: { view?: OwnerView; owner: Hex; canSign: boolean; sign: Sign; preselect?: { leg?: number; coin?: string }; onDone: () => void }) {
  const held: Held[] = (view?.snapshot.legs ?? []).flatMap((l) =>
    l.clearinghouse.assetPositions
      .filter((a) => Number(a.position.szi) !== 0)
      .map((a) => ({ leg: l.leg, coin: a.position.coin, szi: Number(a.position.szi), entryPx: Number(a.position.entryPx), mark: Number(view?.snapshot.market.mids[a.position.coin] ?? a.position.entryPx), szDecimals: view?.snapshot.market.assets?.find((x) => x.name === a.position.coin)?.szDecimals ?? 5 })),
  );
  const [pick, setPick] = useState(() => `${preselect?.leg ?? ''}:${preselect?.coin ?? ''}`);
  const [tpl, setTpl] = useState<string>(PROTECT[0].id);
  const [vals, setVals] = useState<Record<Field, string>>(DEFAULT);
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const h = held.find((x) => `${x.leg}:${x.coin}` === pick) ?? held[0];
  const t = PROTECT.find((p) => p.id === tpl)!;
  const built = h ? protectSpec(tpl, h, vals) : undefined;

  const submit = async () => {
    if (!h || !built || 'error' in built) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await placeOrder(sign, owner, built.spec);
      setNotice({ kind: 'ok', text: `Protection placed on leg ${h.leg}. It shows under Open orders on the Trade tab.` });
      onDone();
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card wide" aria-labelledby="prot-h">
      <h2 id="prot-h">Protect a position</h2>
      <p className="muted small">Orders Hyperliquid itself holds on a position you already have: they keep working if this service is down. A freeze cancels them. They are not strategies, so they need no spare leg.</p>
      {held.length === 0 ? (
        <p className="state">No leg holds a position. Open one from the Trade tab, then protect it here.</p>
      ) : (
        <>
          <div className="fields inline">
            <label>
              Position
              <select value={`${h!.leg}:${h!.coin}`} onChange={(e) => setPick(e.target.value)}>
                {held.map((x) => <option key={`${x.leg}:${x.coin}`} value={`${x.leg}:${x.coin}`}>Leg {x.leg}: {n(Math.abs(x.szi), x.szDecimals)} {x.coin} {x.szi > 0 ? 'long' : 'short'}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="tpl-list">
            <legend className="sr">Protection</legend>
            {PROTECT.map((p) => (
              <label key={p.id} className={`tpl${tpl === p.id ? ' on' : ''}`}>
                <input type="radio" name="protect" checked={tpl === p.id} onChange={() => setTpl(p.id)} />
                <strong>{p.title}</strong>
                <span className="muted small">{p.blurb}</span>
              </label>
            ))}
          </fieldset>
          <div className="fields inline">
            {(t.fields as readonly Field[]).map((f) => (
              <label key={f}>
                {LABEL[f]}
                <input value={vals[f]} onChange={(e) => setVals({ ...vals, [f]: e.target.value })} inputMode="decimal" />
              </label>
            ))}
          </div>
          <p className={built && 'error' in built ? 'state err' : 'state'} role={built && 'error' in built ? 'alert' : undefined}>{built ? ('error' in built ? built.error : built.text) : ''}</p>
          {notice && <p className={`notice ${notice.kind}`} role={notice.kind === 'err' ? 'alert' : 'status'}>{notice.text}</p>}
          <div className="actions">
            <button className="primary" disabled={!canSign || busy || !built || 'error' in built} title={canSign ? undefined : 'Log in to sign'} onClick={submit}>{busy ? 'Waiting for signature…' : 'Sign and place'}</button>
            <button onClick={() => setInfo(tpl)}>How it works</button>
          </div>
        </>
      )}
      {info && h && <HowItWorks id={info} coin={h.coin} mid={h.mark} onClose={() => setInfo(undefined)} />}
    </section>
  );
}

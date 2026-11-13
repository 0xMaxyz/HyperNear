import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from './toast';
import type { Hex } from 'viem';
import { newCommand, type Command } from '@hypernear/client';
import { ApiError, getJson, post, specHashOf, type AgentEvent, type LegSnap, type DraftOk, type DraftRefused, type LibraryListing, type SpecChange, type StrategySpec, type StrategyStatus } from './api';
import { HowItWorks } from './howitworks';
import { short } from './panels';

const usd = (n: number | string) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
const every = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const shown = (v: unknown) => (v === undefined ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));

/** The spec in words: what it will do, and the numbers that bound it. */
export function describe(spec: StrategySpec): string {
  const p = spec.params as Record<string, number | string>;
  if (spec.type === 'grid') {
    return `Places ${p.levels} buy levels between ${usd(p.lower)} and ${usd(p.upper)}, ${p.sizePerLevel} ${spec.coin} each (about ${usd(Number(p.sizePerLevel) * Number(p.lower))} at the lowest level). When a buy fills it places a sell one level higher. It never goes short.`;
  }
  const buy = p.side === 'buy';
  return `${buy ? 'Buys' : 'Sells'} ${p.sizePerSlice} ${spec.coin} ${p.slices} times, one every ${every(Number(p.intervalSec))}, ${buy ? 'never paying more than' : 'never receiving less than'} ${usd(p.limitPx)}. Total ${(Number(p.sizePerSlice) * Number(p.slices)).toPrecision(4)} ${spec.coin}.`;
}

function eventLine(e: AgentEvent): string {
  const base = eventText(e);
  const d = e.data as Record<string, any>;
  return base + (d.recorded ? ' (recorded)' : d.simulated ? ' (simulated)' : '');
}

function eventText(e: AgentEvent): string {
  const d = e.data as Record<string, any>;
  const id = d.id ? `${d.id}: ` : '';
  switch (e.type) {
    case 'strategy.started': return `${id}started on leg ${d.leg}`;
    case 'strategy.order': return `${id}${d.side} order, level ${d.level}, ${d.sz} at ${usd(d.px)}`;
    case 'strategy.fill': return `${id}${d.side} filled, level ${d.level}, ${d.sz} at ${usd(d.px)}`;
    case 'strategy.slice': return `${id}${d.side} slice ${d.done} of ${d.of}, ${d.sz} at ${usd(d.avgPx)}`;
    case 'strategy.slice.skipped': return `${id}slice ${d.slice} skipped: ${d.reason}`;
    case 'strategy.order.refused': return `${id}order refused by the limits: ${d.reason}`;
    case 'strategy.order.rejected': return `${id}Hyperliquid rejected an order: ${d.error}`;
    case 'strategy.order.lost': return `${id}order at level ${d.level} is gone from the book`;
    case 'strategy.paused': return `${id}paused${d.reason ? `: ${d.reason}` : ''}${d.cancelled?.length ? `, ${d.cancelled.length} orders cancelled` : ''}`;
    case 'strategy.resumed': return `${id}resumed`;
    case 'strategy.stopped': return `${id}stopped${d.reason ? `: ${d.reason}` : ''}${d.flattened ? ', position closed' : ''}`;
    case 'strategy.done': return `${id}finished, ${d.filled} filled and ${d.skipped} skipped`;
    case 'strategy.frozen': return `${id}stopped by your freeze, resting orders cancelled first`;
    case 'strategy.deadman': return `${id}dead-man switch ${d.armed ? 'armed' : `unavailable (${d.reason})`}`;
    case 'strategy.restored': return `${id}restored after a restart, ${d.state}`;
    case 'strategy.error': return `${id}error: ${d.message}`;
    default: return `${id}${JSON.stringify(d).slice(0, 120)}`;
  }
}
const bad = (t: string) => /refused|rejected|error|lost|skipped:/.test(t);

/** The template form: every field is kept as typed (a string), and turned into a spec only when it is sent to be checked. */
interface Edit {
  templateId: string;
  id: string;
  type: StrategySpec['type'];
  coin: string;
  leg: number;
  fields: Record<string, string>;
  limits: Record<string, string>;
  onStop: string;
}
type Field = { key: string; label: string; kind: 'num' | 'int' | 'dec' | 'side' };
const PARAMS: Record<StrategySpec['type'], Field[]> = {
  grid: [
    { key: 'lower', label: 'Lowest price', kind: 'num' },
    { key: 'upper', label: 'Highest price', kind: 'num' },
    { key: 'levels', label: 'Levels (2 to 20)', kind: 'int' },
    { key: 'sizePerLevel', label: 'Size per level', kind: 'dec' },
  ],
  twap: [
    { key: 'side', label: 'Side', kind: 'side' },
    { key: 'sizePerSlice', label: 'Size per slice', kind: 'dec' },
    { key: 'slices', label: 'Slices (2 to 50)', kind: 'int' },
    { key: 'intervalSec', label: 'Seconds between slices', kind: 'int' },
    { key: 'limitPx', label: 'Price limit', kind: 'num' },
  ],
};
const LIMITS = [
  { key: 'maxNotional', label: 'Largest exposure, USD' },
  { key: 'maxLeverage', label: 'Leverage up to' },
  { key: 'maxDailyLoss', label: 'Stop after losing, USD' },
  { key: 'topUpCapPerDay', label: 'Guard top-ups, USD a day' },
];

const fromSpec = (spec: StrategySpec, templateId: string): Edit => ({
  templateId,
  id: spec.id,
  type: spec.type,
  coin: spec.coin,
  leg: spec.leg,
  fields: Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, String(v)])),
  limits: Object.fromEntries(Object.entries(spec.limits).map(([k, v]) => [k, String(v)])),
  onStop: spec.onStop,
});

/** An empty or non-numeric field becomes null, which the agent's validator names as an error next to the field it belongs to. */
function toSpec(e: Edit): StrategySpec {
  const num = (s: string | undefined) => (s === undefined || s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));
  const params: Record<string, number | string | null> = {};
  for (const f of PARAMS[e.type]) params[f.key] = f.kind === 'num' || f.kind === 'int' ? num(e.fields[f.key]) : (e.fields[f.key] ?? '').trim();
  const limits = Object.fromEntries(LIMITS.map((l) => [l.key, num(e.limits[l.key])]));
  return { id: e.id, type: e.type, leg: e.leg, coin: e.coin, params, limits, onStop: e.onStop } as unknown as StrategySpec;
}

type Draft = { kind: 'ok'; text: string; res: DraftOk; hashOk: boolean | null } | { kind: 'refused'; text: string; errors: string[]; draft?: unknown };

export function StrategiesPanel(p: {
  legs?: LegSnap[];
  owner?: Hex;
  canSign: boolean;
  events: AgentEvent[];
  sign: (c: Command) => Promise<Hex>;
  /** a refreshed /owner view tells the panel the agent state may have changed */
  tick: unknown;
  /** from a leg card's "Start a strategy" link */
  leg?: number;
  /** on the Easy screen: its one text box feeds this panel, so the panel's own "describe it in words" box is not shown */
  embedded?: boolean;
  /** text the Easy screen routed here; `n` makes sending the same words twice work */
  prefill?: { text: string; n: number };
}) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState<string | null>(null);
  const setNotice = (n?: { kind: 'ok' | 'err'; text: string }) => void (n && toast(n.kind, n.text));
  const [list, setList] = useState<{ state: 'loading' } | { state: 'off' | 'error'; message: string } | { state: 'ok'; rows: StrategyStatus[] }>({ state: 'loading' });
  const [lib, setLib] = useState<{ state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: LibraryListing }>({ state: 'loading' });
  const [how, setHow] = useState<string>();
  const [libCoin, setLibCoin] = useState<string>();
  const [libLeg, setLibLeg] = useState<number | undefined>(p.leg);
  const [edit, setEdit] = useState<Edit>();
  const [jsonText, setJsonText] = useState<string>();
  const checkSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!p.owner) return;
    try {
      const r = await getJson<{ strategies: StrategyStatus[] }>(`/strategies/${p.owner}`);
      setList({ state: 'ok', rows: r.strategies });
    } catch (e) {
      const m = (e as Error).message;
      setList(e instanceof ApiError && /strategies off|not found/.test(m) ? { state: 'off', message: 'This agent runs no strategies.' } : { state: 'error', message: m });
    }
  }, [p.owner]);
  useEffect(() => {
    void refresh();
  }, [refresh, p.tick]);

  useEffect(() => setLibLeg(p.leg), [p.leg]);
  // the templates, sized from the live price for the chosen coin and leg
  useEffect(() => {
    if (!p.owner) return;
    let live = true;
    const q = new URLSearchParams({ owner: p.owner, ...(libCoin ? { coin: libCoin } : {}), ...(libLeg !== undefined ? { leg: String(libLeg) } : {}) });
    getJson<LibraryListing>(`/strategy/library?${q}`).then(
      (data) => {
        if (!live) return;
        setLib({ state: 'ok', data });
        // a new coin or leg re-sizes the template that is open
        setEdit((e) => {
          const item = e && data.items.find((i) => i.id === e.templateId);
          return item ? fromSpec(item.spec, item.id) : e;
        });
      },
      (e) => live && setLib({ state: 'error', message: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [p.owner, libCoin, libLeg]);

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNotice(undefined);
    try {
      setNotice({ kind: 'ok', text: await fn() });
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  type Answer = Partial<DraftOk> & Partial<DraftRefused> & { error?: string };
  /** 200 {ok:true, spec, ...}; 422 {ok:false, errors, draft?} when the agent refuses a spec; anything else is thrown. */
  const ask = async (path: string, body: unknown): Promise<Answer> => {
    try {
      return (await post(path, body)) as Answer;
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && Array.isArray(e.body.errors)) return e.body as Answer;
      throw e;
    }
  };
  /** Show the agent's answer. The owner signs the hash, so it is recomputed from the spec shown here instead of trusting the server's copy. */
  const show = async (out: Answer, from: string): Promise<boolean> => {
    if (out.ok === false || !out.spec) {
      setDraft({ kind: 'refused', text: from, errors: out.errors ?? [out.error ?? 'The agent returned no strategy.'], draft: from === 'template' ? undefined : out.draft });
      return false;
    }
    const res = out as DraftOk;
    setDraft({ kind: 'ok', text: from, res, hashOk: null });
    const mine = await specHashOf(res.spec);
    setDraft({ kind: 'ok', text: from, res, hashOk: mine === res.specHash.toLowerCase() });
    return true;
  };

  const doDraft = (words = text) =>
    act('draft', async () => {
      setEdit(undefined);
      const ok = await show(await ask('/strategy/draft', { owner: p.owner, text: words }), words);
      return ok ? 'Draft ready. Read the spec and the warnings, then start it or discard it.' : 'The draft was refused. Nothing was started.';
    });

  useEffect(() => {
    if (!p.prefill?.n) return;
    setText(p.prefill.text);
    doDraft(p.prefill.text);
  }, [p.prefill?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // every change to the template form is checked by the agent shortly after the last keystroke
  useEffect(() => {
    if (!edit || !p.owner) return;
    const seq = ++checkSeq.current;
    const t = setTimeout(async () => {
      try {
        const out = await ask('/strategy/check', { owner: p.owner, spec: toSpec(edit) });
        if (seq === checkSeq.current) await show(out, 'template');
      } catch (e) {
        if (seq === checkSeq.current) setDraft({ kind: 'refused', text: 'template', errors: [(e as Error).message] });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [edit, p.owner, p.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (item: { id: string; spec: StrategySpec }) => {
    setText('');
    setJsonText(undefined);
    setEdit(fromSpec(item.spec, item.id));
  };
  const setField = (group: 'fields' | 'limits', key: string, value: string) => setEdit((e) => (e ? { ...e, [group]: { ...e[group], [key]: value } } : e));
  const applyJson = () => {
    try {
      const spec = JSON.parse(jsonText ?? '') as StrategySpec;
      if (!spec || typeof spec !== 'object' || !spec.params || !spec.limits || !(spec.type in PARAMS)) throw new Error('not a strategy spec');
      setEdit(fromSpec(spec, edit?.templateId ?? ''));
      setJsonText(undefined);
    } catch (e) {
      setNotice({ kind: 'err', text: `That JSON is not a strategy spec: ${(e as Error).message}` });
    }
  };

  const start = () =>
    act('start', async () => {
      if (draft?.kind !== 'ok') throw new Error('No draft.');
      const { spec } = draft.res;
      const hash = await specHashOf(spec);
      const command = newCommand(p.owner!, 'startStrategy', '', '0', 30, Date.now(), hash);
      const sig = await p.sign(command);
      await post('/strategy/start', { command, sig, spec });
      setDraft(undefined);
      setEdit(undefined);
      setText('');
      return `Strategy ${spec.id} started on leg ${spec.leg}.`;
    });

  /** Resume = a signed startStrategy whose coin is the strategy id and whose specHash is the stored spec's hash. */
  const resume = (r: StrategyStatus) =>
    act(`resume:${r.id}`, async () => {
      if (!r.spec) throw new Error('The agent did not send the stored spec, so there is nothing to hash.');
      const command = newCommand(p.owner!, 'startStrategy', r.id, '0', 30, Date.now(), await specHashOf(r.spec));
      const sig = await p.sign(command);
      await post('/strategy/resume', { command, sig });
      return `Strategy ${r.id} resumed.`;
    });

  const op = (verb: 'pause' | 'stop', id: string) =>
    act(`${verb}:${id}`, async () => {
      const command = newCommand(p.owner!, verb === 'pause' ? 'pauseStrategy' : 'stopStrategy', id);
      const sig = await p.sign(command);
      await post(`/strategy/${verb}`, { command, sig });
      return `Strategy ${id} ${verb === 'pause' ? 'paused' : 'stopped'}.`;
    });

  const log = p.events.filter((e) => e.type.startsWith('strategy.'));
  const why = p.canSign ? undefined : 'Log in to sign';

  return (
    <section className="card wide" aria-labelledby="strat-h">
      <h2 id="strat-h">Strategies</h2>
      <p className="muted small">
        Each strategy runs on its own leg, so its losses stay on that leg. Describe one in plain words; a model drafts it, the agent checks every number against your order policy and contract policy, and nothing starts until you sign the exact spec shown here.
      </p>

      {how && lib.state === 'ok' && <HowItWorks id={how} coin={lib.data.coin} mid={lib.data.mid} onClose={() => setHow(undefined)} />}
      <div className="strat-grid">
        <div>
          <h3>New strategy</h3>
          <h4>Start from a template</h4>
          {lib.state === 'loading' && <p className="state">Reading templates…</p>}
          {lib.state === 'error' && <p className="state err" role="alert">{lib.message}</p>}
          {lib.state === 'ok' && (
            <>
              <div className="fields inline">
                <label>
                  Coin
                  <select value={lib.data.coin} onChange={(e) => setLibCoin(e.target.value)}>
                    {lib.data.coins.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <label>
                  Leg
                  <select value={lib.data.leg} onChange={(e) => setLibLeg(Number(e.target.value))}>
                    {[...new Set([...lib.data.freeLegs, lib.data.leg])].sort((a, b) => a - b).map((l) => <option key={l} value={l}>Leg {l}</option>)}
                  </select>
                </label>
              </div>
              <p className="muted small">
                {lib.data.coin} is at {usd(lib.data.mid)}; every size below is worked out from that price.
                {lib.data.freeLegs.length === 0 && ' No leg is free for a strategy: register one on the Legs tab first.'}
              </p>
              <fieldset className="tpl-list">
                <legend className="sr">Template</legend>
                {lib.data.items.map((i) => (
                  <label key={i.id} className={`tpl${edit?.templateId === i.id ? ' on' : ''}`}>
                    <input type="radio" name="tpl" checked={edit?.templateId === i.id} onChange={() => pick(i)} />
                    <strong>{i.title}</strong>
                    <span className="muted small">{i.blurb}</span>
                    <button type="button" className="small-btn" style={{ justifySelf: 'start', marginTop: 6 }} onClick={(e) => (e.preventDefault(), e.stopPropagation(), setHow(i.id))}>How it works</button>
                  </label>
                ))}
              </fieldset>
            </>
          )}

          {edit && (
            <div className="tpl-form">
              <h5>Adjust it</h5>
              <p className="muted small">{lib.state === 'ok' ? lib.data.items.find((i) => i.id === edit.templateId)?.risk : ''}</p>
              <div className="fields inline">
                <label>
                  Name
                  <input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} spellCheck={false} />
                </label>
                {PARAMS[edit.type].map((f) =>
                  f.kind === 'side' ? (
                    <label key={f.key}>
                      {f.label}
                      <select value={edit.fields[f.key] ?? 'buy'} onChange={(e) => setField('fields', f.key, e.target.value)}>
                        <option value="buy">buy</option>
                        <option value="sell">sell</option>
                      </select>
                    </label>
                  ) : (
                    <label key={f.key}>
                      {f.label}
                      <input value={edit.fields[f.key] ?? ''} onChange={(e) => setField('fields', f.key, e.target.value)} inputMode="decimal" />
                    </label>
                  ),
                )}
                {LIMITS.map((l) => (
                  <label key={l.key}>
                    {l.label}
                    <input value={edit.limits[l.key] ?? ''} onChange={(e) => setField('limits', l.key, e.target.value)} inputMode="decimal" />
                  </label>
                ))}
                <label>
                  When stopped
                  <select value={edit.onStop} onChange={(e) => setEdit({ ...edit, onStop: e.target.value })}>
                    <option value="cancel">cancel orders, keep the position</option>
                    <option value="flatten">close the position</option>
                  </select>
                </label>
              </div>
              <details>
                <summary>Edit as JSON</summary>
                <textarea rows={10} spellCheck={false} value={jsonText ?? JSON.stringify(toSpec(edit), null, 2)} onChange={(e) => setJsonText(e.target.value)} aria-label="Strategy spec as JSON" />
                <div className="actions tight">
                  <button disabled={jsonText === undefined} onClick={applyJson}>Use this JSON</button>
                </div>
              </details>
            </div>
          )}

          {!p.embedded && <>
          <h4>Or describe it in words</h4>
          <label>
            Your rules
            <textarea value={text} maxLength={600} rows={4} onChange={(e) => setText(e.target.value)} placeholder="Example: buy BTC in a grid from 70000 to 80000 with 10 levels, 0.0002 each, on leg 3" />
          </label>
          <p className="muted small">{text.length} of 600 characters. Free text only ever produces a proposal.</p>
          <div className="actions">
            <button className="primary" disabled={!p.owner || busy !== null || text.trim() === ''} onClick={() => doDraft()}>{busy === 'draft' ? 'Drafting…' : 'Draft strategy'}</button>
            {draft && <button disabled={busy !== null} onClick={() => (setDraft(undefined), setEdit(undefined))}>Discard draft</button>}
          </div>
          </>}
          {p.embedded && draft && <button disabled={busy !== null} onClick={() => (setDraft(undefined), setEdit(undefined))}>Discard draft</button>}

          {draft?.kind === 'refused' && (
            <div className="draft refused" role="alert">
              <h4>Refused</h4>
              <ul>{draft.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              {draft.draft !== undefined && (
                <details>
                  <summary>What the model proposed (not valid)</summary>
                  <pre>{JSON.stringify(draft.draft, null, 2)}</pre>
                </details>
              )}
            </div>
          )}

          {draft?.kind === 'ok' && (
            <div className="draft">
              <h4>{draft.res.spec.type === 'grid' ? 'Grid' : 'TWAP / DCA'} on {draft.res.spec.coin}, leg {draft.res.spec.leg} <span className="muted small">({draft.res.spec.id})</span></h4>
              <p>{describe(draft.res.spec)}</p>
              <dl className="kv">
                <dt>Largest exposure</dt><dd>{usd(draft.res.spec.limits.maxNotional)}</dd>
                <dt>Stops after losing</dt><dd>{usd(draft.res.spec.limits.maxDailyLoss)} in a day</dd>
                <dt>Leverage up to</dt><dd>{draft.res.spec.limits.maxLeverage}x</dd>
                <dt>Guard top-ups</dt><dd>{usd(draft.res.spec.limits.topUpCapPerDay)} a day{p.legs?.find((l) => l.leg === draft.res.spec.leg)?.activation === 'owed-on-credit' && <span className="flag small"> (leg {draft.res.spec.leg} is new: its first top-up loses 1 USDC activation, counted in this budget)</span>}</dd>
                <dt>When stopped</dt><dd>{draft.res.spec.onStop === 'flatten' ? 'close the position' : 'cancel resting orders, keep the position'}</dd>
              </dl>

              <h5>{draft.res.diff.against === 'new' ? 'Changes' : `Changes against your running ${draft.res.diff.against}`}</h5>
              {draft.res.diff.changes.length === 0 ? (
                <p className="state">{draft.res.diff.against === 'new' ? 'A new strategy, so there is nothing to compare with.' : 'Identical to the running strategy.'}</p>
              ) : (
                <div className="scroll">
                  <table className="mini">
                    <thead><tr><th>Field</th><th>Was</th><th>Becomes</th></tr></thead>
                    <tbody>
                      {draft.res.diff.changes.map((c: SpecChange) => (
                        <tr key={c.path}>
                          <td data-label="Field"><code>{c.path}</code></td>
                          <td data-label="Was">{shown(c.from)}</td>
                          <td data-label="Becomes"><strong>{shown(c.to)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {draft.res.warnings.length > 0 && (
                <div className="warnings">
                  <h5>Check before signing</h5>
                  <ul>{draft.res.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </div>
              )}

              <p className={`small ${draft.hashOk === false ? 'flag' : 'muted'}`}>
                Spec hash <code title={draft.res.specHash}>{short(draft.res.specHash)}</code>{' '}
                {draft.hashOk === null ? 'checking…' : draft.hashOk ? 'recomputed in your browser, it matches. You will sign this hash.' : 'does NOT match this spec. Do not sign it.'}
              </p>
              <details>
                <summary>Spec as JSON</summary>
                <pre>{JSON.stringify(draft.res.spec, null, 2)}</pre>
              </details>
              <div className="actions">
                <button className="primary" disabled={!p.canSign || busy !== null || draft.hashOk !== true} title={why} onClick={start}>{busy === 'start' ? 'Waiting for signature…' : 'Start strategy'}</button>
              </div>
            </div>
          )}
        </div>

        <div>
          <h3 id="strat-list-h">Your strategies</h3>
          {list.state === 'loading' && <p className="state">Reading strategies…</p>}
          {list.state === 'off' && <p className="state">{list.message}</p>}
          {list.state === 'error' && <p className="state err" role="alert">{list.message}</p>}
          {list.state === 'ok' && list.rows.length === 0 && <p className="state">None running. Draft one on the left; it appears here once you start it.</p>}
          {list.state === 'ok' && list.rows.length > 0 && (
            <div className="scroll">
              <table className="mini">
                <thead><tr><th>Strategy</th><th>State</th><th className="num">Resting</th><th>Controls</th></tr></thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Strategy"><strong>{r.id}</strong><div className="muted small">{r.type} on {r.coin}, leg {r.leg}</div></td>
                      <td data-label="State" className={r.state === 'running' ? 'ok-text' : ''}>{r.state}{r.twap ? <div className="muted small">{r.twap.done} done, {r.twap.skipped} skipped</div> : null}</td>
                      <td data-label="Resting" className="num">{r.resting ?? 0}</td>
                      <td data-label="Controls">
                        <div className="actions tight">
                          {r.state === 'paused' ? (
                            <button disabled={!p.canSign || busy !== null || !r.spec} title={why} onClick={() => resume(r)}>{busy === `resume:${r.id}` ? 'Signing…' : 'Resume'}</button>
                          ) : (
                            <button disabled={!p.canSign || busy !== null || r.state !== 'running'} title={why} onClick={() => op('pause', r.id)}>{busy === `pause:${r.id}` ? 'Signing…' : 'Pause'}</button>
                          )}
                          <button className="danger" disabled={!p.canSign || busy !== null || r.state === 'stopped' || r.state === 'done'} title={why} onClick={() => op('stop', r.id)}>{busy === `stop:${r.id}` ? 'Signing…' : 'Stop'}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 id="strat-log-h">Strategy log</h3>
          {log.length === 0 ? (
            <p className="state">No strategy events yet. Orders, fills, refusals, pauses and stops appear here as the agent emits them.</p>
          ) : (
            <ol className="log compact">
              {log.map((e) => {
                const t = eventLine(e);
                return (
                  <li key={e.id} className={bad(t) ? 'flag' : ''}>
                    <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString('en-GB')}</time>
                    <span>{t}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { newCommand, type Command } from '@hypernear/client';
import { ApiError, getJson, post, specHashOf, type AgentEvent, type DraftOk, type DraftRefused, type SpecChange, type StrategySpec, type StrategyStatus } from './api';
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
const bad = (t: string) => /refused|rejected|error|lost|skipped/.test(t);

type Draft = { kind: 'ok'; text: string; res: DraftOk; hashOk: boolean | null } | { kind: 'refused'; text: string; errors: string[]; draft?: unknown };

export function StrategiesPanel(p: {
  owner?: Hex;
  canSign: boolean;
  events: AgentEvent[];
  sign: (c: Command) => Promise<Hex>;
  /** a refreshed /owner view tells the panel the agent state may have changed */
  tick: unknown;
}) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [list, setList] = useState<{ state: 'loading' } | { state: 'off' | 'error'; message: string } | { state: 'ok'; rows: StrategyStatus[] }>({ state: 'loading' });

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

  const doDraft = () =>
    act('draft', async () => {
      const out = (await post('/strategy/draft', { owner: p.owner, text })) as Partial<DraftOk> & Partial<DraftRefused> & { error?: string };
      if (out.ok === false || !out.spec) {
        setDraft({ kind: 'refused', text, errors: out.errors ?? [out.error ?? 'The agent returned no strategy.'], draft: out.draft });
        return 'The draft was refused. Nothing was started.';
      }
      const res = out as DraftOk;
      setDraft({ kind: 'ok', text, res, hashOk: null });
      // the owner signs this hash, so recompute it from the spec shown here instead of trusting the server's copy
      const mine = await specHashOf(res.spec);
      setDraft({ kind: 'ok', text, res, hashOk: mine === res.specHash.toLowerCase() });
      return 'Draft ready. Read the spec and the warnings, then start it or discard it.';
    });

  const start = () =>
    act('start', async () => {
      if (draft?.kind !== 'ok') throw new Error('No draft.');
      const { spec } = draft.res;
      const hash = await specHashOf(spec);
      const command = newCommand(p.owner!, 'startStrategy', '', '0', 30, Date.now(), hash);
      const sig = await p.sign(command);
      await post('/strategy/start', { command, sig, spec });
      setDraft(undefined);
      setText('');
      return `Strategy ${spec.id} started on leg ${spec.leg}.`;
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

      <div aria-live="polite">
        {notice && <p className={`notice ${notice.kind}`} role={notice.kind === 'err' ? 'alert' : 'status'}>{notice.text}</p>}
      </div>

      <div className="strat-grid">
        <div>
          <h3>New strategy</h3>
          <label>
            Your rules
            <textarea value={text} maxLength={600} rows={4} onChange={(e) => setText(e.target.value)} placeholder="Example: buy BTC in a grid from 70000 to 80000 with 10 levels, 0.0002 each, on leg 3" />
          </label>
          <p className="muted small">{text.length} of 600 characters. Free text only ever produces a proposal.</p>
          <div className="actions">
            <button className="primary" disabled={!p.owner || busy !== null || text.trim() === ''} onClick={doDraft}>{busy === 'draft' ? 'Drafting…' : 'Draft strategy'}</button>
            {draft && <button disabled={busy !== null} onClick={() => setDraft(undefined)}>Discard draft</button>}
          </div>

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
                <dt>Guard top-ups</dt><dd>{usd(draft.res.spec.limits.topUpCapPerDay)} a day</dd>
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
          <h3>Your strategies</h3>
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
                          <button disabled={!p.canSign || busy !== null || r.state !== 'running'} title={why} onClick={() => op('pause', r.id)}>{busy === `pause:${r.id}` ? 'Signing…' : 'Pause'}</button>
                          <button className="danger" disabled={!p.canSign || busy !== null || r.state === 'stopped' || r.state === 'done'} title={why} onClick={() => op('stop', r.id)}>{busy === `stop:${r.id}` ? 'Signing…' : 'Stop'}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Strategy log</h3>
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

// Easy trading: say what you want in plain words, check the draft, sign it. The assistant only drafts (agent/src/trade/intent.ts); the page shows
// a summary built from the validated spec itself, re-hashes the spec before asking for a signature, and the agent runs exactly the signed bytes.
import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { ApiError, getJson, post, type OwnerView } from './api';
import { specHashOfJson } from './hypernear';
import { describeHedgePair, describeSpec } from './orderForm';
import { SessionControl, type SessionApi } from './session';
import { pairMessage, sendSpec, type CancelSpec, type HedgePairResult, type HedgePairSpec, type OrderSpec, type Sign } from './trading';

const MAX_TEXT = 300;

type Ok =
  | { ok: true; kind: 'order'; action: 'placeOrder'; path: string; spec: OrderSpec; specHash: Hex; assumed: string[] }
  | { ok: true; kind: 'cancel'; action: 'cancelOrder'; path: string; spec: CancelSpec; specHash: Hex; assumed: string[] }
  | { ok: true; kind: 'hedgePair'; action: 'placeHedge'; path: string; spec: HedgePairSpec; specHash: Hex; assumed: string[] };
type Refused = { ok: false; errors: string[]; missing?: string[] };

export interface EasyProps {
  view?: OwnerView;
  owner: Hex;
  locked: boolean;
  why?: string;
  sign: Sign;
  session?: SessionApi;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  done: (out: Record<string, unknown>, what: string) => string;
  onGo: (to: string) => void;
}

function summary(d: Ok, mids: Record<string, string> | undefined): string {
  const mid = Number(mids?.[d.spec.coin] ?? 0);
  if (d.kind === 'order') return describeSpec(d.spec, mid);
  if (d.kind === 'cancel') return `Cancel all ${d.spec.coin} orders on leg ${d.spec.leg}.`;
  return describeHedgePair(d.spec, mid);
}

export function EasyTab(p: EasyProps) {
  const [text, setText] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Ok | Refused>();
  const [hashOk, setHashOk] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getJson<{ examples: string[]; available: boolean }>('/trade/examples').then(
      (r) => (setExamples(r.examples), setAvailable(r.available)),
      () => undefined,
    );
  }, []);

  const draft = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const out = (await post('/trade/draft', { owner: p.owner, text })) as unknown as Ok;
      // the agent hashed the spec it will run; hash it again here so what is signed is what was read
      setHashOk(specHashOfJson(out.spec) === out.specHash);
      setResult(out);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as unknown as Partial<Refused>) : {};
      setResult(Array.isArray(body.errors) ? { ok: false, errors: body.errors, missing: body.missing } : { ok: false, errors: [(e as Error).message] });
    } finally {
      setBusy(false);
    }
  };

  const mids = p.view?.snapshot.market.mids;
  const send = (d: Ok) =>
    p.run('easy', async () => {
      if (specHashOfJson(d.spec) !== d.specHash) throw new Error('The draft does not match its hash, so it was not signed.');
      const out = await sendSpec(p.sign, p.owner, d.action, d.path, d.spec);
      setResult(undefined);
      setText('');
      return d.kind === 'hedgePair' ? p.done(out, pairMessage(out as unknown as HedgePairResult)) : p.done(out, summary(d, mids).replace(/\.$/, ''));
    });

  return (
    <section className="easy" aria-labelledby="easy-h">
      <h2 id="easy-h">Easy trading</h2>
      <p className="muted">Say what you want. You read the draft and sign it; nothing is sent before that. This page cannot withdraw or move money.</p>

      {!available && <p className="t-msg err" role="alert">Easy trading is off on this agent (no assistant key is set). The Trade tab still works.</p>}

      <label className="t-input stack">
        <span>What do you want to do?</span>
        <textarea
          ref={area}
          rows={3}
          maxLength={MAX_TEXT}
          value={text}
          placeholder="Open a long BTC market order for $30 with 5x leverage"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !busy) void draft();
          }}
        />
        <small className="muted">{text.length}/{MAX_TEXT}</small>
      </label>
      <div className="easy-actions">
        <button className="t-submit buy" disabled={!text.trim() || busy || !available} onClick={() => void draft()}>{busy ? 'Reading…' : 'Draft it'}</button>
      </div>

      {examples.length > 0 && (
        <div className="easy-chips" role="group" aria-label="Example requests">
          <span className="muted small">Try:</span>
          {examples.map((x) => (
            <button key={x} className="t-chip-btn" onClick={() => (setText(x), area.current?.focus())}>{x}</button>
          ))}
        </div>
      )}

      {result && !result.ok && (
        <div className="easy-card refused" role="alert">
          <b>{result.missing?.length ? 'Need a bit more' : 'Not drafted'}</b>
          <ul>{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {result?.ok && (
        <div className="easy-card" role="region" aria-label="Draft to sign">
          <b>Your draft</b>
          <p className="easy-summary">{summary(result, mids)}</p>
          {result.assumed.length > 0 && (
            <>
              <span className="muted small">Filled in for you, check these:</span>
              <ul>{result.assumed.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </>
          )}
          {!hashOk && <p className="t-msg err" role="alert">The draft does not match its hash. Do not sign it.</p>}
          <div className="easy-actions">
            <button className="t-submit buy" disabled={p.locked || !hashOk} title={p.why} onClick={() => send(result)}>
              {p.session?.spec && (p.session.spec.actions as string[]).includes(result.action) ? '' : 'Sign · '}Do it
            </button>
            <button className="t-link" onClick={() => setResult(undefined)}>Discard</button>
            <button className="t-link" onClick={() => p.onGo(result.kind === 'hedgePair' ? 'trade?mode=hedge' : 'trade')}>Adjust in Trade</button>
          </div>
        </div>
      )}

      {p.session && <SessionControl s={p.session} run={p.run} locked={p.locked} why={p.why} />}
    </section>
  );
}

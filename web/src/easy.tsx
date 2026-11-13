// Easy trading: say what you want in plain words, check the draft, sign it. The assistant only drafts (agent/src/trade/intent.ts); the page shows
// a summary built from the validated spec itself, re-hashes the spec before asking for a signature, and the agent runs exactly the signed bytes.
import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { ApiError, getJson, post, type OwnerView } from './api';
import { specHashOfJson } from './hypernear';
import { HowItWorks } from './howitworks';
import { describeHedgePair, describeSpec } from './orderForm';
import { SessionControl, type SessionApi } from './session';
import { pairMessage, sendSpec, type CancelSpec, type HedgePairResult, type HedgePairSpec, type OrderSpec, type Sign } from './trading';

const MAX_TEXT = 300;
// shortcut: a keyword router, upgrade to one /assist/draft endpoint when misroutes appear
const STRATEGY_WORDS = /\b(grid|dca|ladder|levels?|slices?|every)\b/i;
// starting points: each fills the box with a sentence the drafter handles (agent/src/trade/intent.ts EXAMPLE_PROMPTS); the user reads and edits it, then drafts
type TileId = 'buy' | 'sell' | 'hedge' | 'protect' | 'close' | 'grid' | 'dca';
const TILES: { id: TileId; title: string; hint: string; guide?: string }[] = [
  { id: 'buy', title: 'Buy', hint: 'Go long on a coin' },
  { id: 'sell', title: 'Sell', hint: 'Go short on a coin' },
  { id: 'hedge', title: 'Hedge', hint: 'Cancel out price moves' },
  { id: 'protect', title: 'Protect', hint: 'Stop loss and take profit' },
  { id: 'close', title: 'Close', hint: 'Close a position' },
  { id: 'grid', title: 'Grid', hint: 'Buy low, sell high in a range', guide: 'grid-classic' },
  { id: 'dca', title: 'DCA', hint: 'Buy a little at a time', guide: 'dca-steady' },
];

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
  /** words that describe a strategy (grid, DCA, levels...) are handed to the strategy drafter below */
  onStrategy: (text: string) => void;
  /** the Grid or DCA option: the strategy panel below asks for coin, leg and style */
  onStrategyChoose: (family: 'grid' | 'dca') => void;
}

function summary(d: Ok, mids: Record<string, string> | undefined): string {
  const mid = Number(mids?.[d.spec.coin] ?? 0);
  if (d.kind === 'order') return describeSpec(d.spec, mid);
  if (d.kind === 'cancel') return `Cancel all ${d.spec.coin} orders on leg ${d.spec.leg}.`;
  return describeHedgePair(d.spec, mid);
}

export function EasyTab(p: EasyProps) {
  const [text, setText] = useState('');
  const [available, setAvailable] = useState(true);
  const [choice, setChoice] = useState<TileId>();
  const [coin, setCoin] = useState('BTC');
  const [leg, setLeg] = useState<number>();
  const [amount, setAmount] = useState('30');
  const [lean, setLean] = useState<'long' | 'short'>('long');
  const [sl, setSl] = useState('3');
  const [tp, setTp] = useState('6');
  const [how, setHow] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Ok | Refused>();
  const [hashOk, setHashOk] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getJson<{ examples: string[]; available: boolean }>('/trade/examples').then(
      (r) => setAvailable(r.available),
      () => undefined,
    );
  }, []);

  const draft = async (words = text) => {
    if (STRATEGY_WORDS.test(words)) {
      p.onStrategy(words);
      setText('');
      return;
    }
    setBusy(true);
    setResult(undefined);
    try {
      const out = (await post('/trade/draft', { owner: p.owner, text: words })) as unknown as Ok;
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
  const legNums = (p.view?.snapshot.legs ?? []).map((l) => l.leg);
  const legAt = leg ?? legNums[0] ?? 0;
  const num = (t: string) => (Number(t) > 0 ? t.trim() : '');
  // the option's details, as the sentence the drafter reads; empty while a needed number is missing
  const stepWords =
    choice === 'buy' || choice === 'sell' ? (num(amount) ? `Open a ${choice === 'buy' ? 'long' : 'short'} ${coin} market order for $${num(amount)} on leg ${legAt}` : '')
    : choice === 'hedge' ? (num(amount) ? `Open a ${lean} hedge on ${coin} for $${num(amount)}, 100% hedge` : '')
    : choice === 'protect' ? (num(sl) || num(tp) ? `Set ${[num(sl) && `a ${num(sl)}% stop loss`, num(tp) && `a ${num(tp)}% take profit`].filter(Boolean).join(' and ')} on my ${coin} position on leg ${legAt}` : '')
    : choice === 'close' ? `Close my ${coin} position on leg ${legAt}`
    : '';
  const send = (d: Ok) =>
    p.run('easy', async () => {
      if (specHashOfJson(d.spec) !== d.specHash) throw new Error('The draft does not match its hash, so it was not signed.');
      const out = await sendSpec(p.sign, p.owner, d.action, d.path, d.spec);
      setResult(undefined);
      setText('');
      setChoice(undefined);
      return d.kind === 'hedgePair' ? p.done(out, pairMessage(out as unknown as HedgePairResult)) : p.done(out, summary(d, mids).replace(/\.$/, ''));
    });

  return (
    <section className="easy" aria-labelledby="easy-h">
      <h2 id="easy-h">What do you want to do?</h2>
      <p className="muted">Pick a starting point or say it in your own words: a trade, a hedge, or a strategy that keeps running. You read the draft and sign it; nothing is sent before that. This page cannot withdraw or move money.</p>

      {!available && <p className="t-msg err" role="alert">Easy trading is off on this agent (no assistant key is set). The Trade tab still works.</p>}

      <label className="t-input stack">
        <span>Your request</span>
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

      <div className="easy-tiles" role="group" aria-label="What to do">
        {TILES.map((t) => (
          <div key={t.id} className="easy-tile-wrap">
            <button
              type="button"
              className="easy-tile"
              aria-pressed={choice === t.id}
              onClick={() => (t.id === 'grid' || t.id === 'dca' ? (setChoice(undefined), p.onStrategyChoose(t.id)) : setChoice((c) => (c === t.id ? undefined : t.id)))}
            >
              <b>{t.title}</b>
              <span className="muted small">{t.hint}</span>
            </button>
            {t.guide && <button type="button" className="easy-info" aria-label={`How the ${t.title} strategy works`} title="How it works" onClick={() => setHow(t.guide)}>i</button>}
          </div>
        ))}
      </div>
      {how && <HowItWorks id={how} coin={coin} mid={Number(mids?.[coin] ?? 0)} onClose={() => setHow(undefined)} />}

      {choice && (
        <div className="easy-step" role="group" aria-label={`${TILES.find((t) => t.id === choice)!.title}: details`}>
          <div className="fields inline">
            <label>
              Coin
              <select value={coin} onChange={(e) => setCoin(e.target.value)}>
                {(p.view?.orderPolicy.allowedCoins?.length ? p.view.orderPolicy.allowedCoins : ['BTC', 'ETH']).map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            {choice === 'hedge' ? (
              <label>
                Lean
                <select value={lean} onChange={(e) => setLean(e.target.value as 'long' | 'short')}>
                  <option value="long">Up (long on leg 0, short on leg 1)</option>
                  <option value="short">Down (short on leg 0, long on leg 1)</option>
                </select>
              </label>
            ) : (
              <label>
                Leg
                <select value={leg ?? legNums[0] ?? 0} onChange={(e) => setLeg(Number(e.target.value))}>
                  {(legNums.length ? legNums : [0]).map((l) => <option key={l} value={l}>Leg {l}</option>)}
                </select>
              </label>
            )}
            {(choice === 'buy' || choice === 'sell' || choice === 'hedge') && (
              <label>
                Amount (USD)
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
            )}
            {choice === 'protect' && (
              <>
                <label>
                  Stop loss (%)
                  <input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" />
                </label>
                <label>
                  Take profit (%)
                  <input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" />
                </label>
              </>
            )}
          </div>
          <div className="easy-actions">
            <button className="t-submit buy" disabled={busy || !available || !stepWords} onClick={() => { setText(stepWords); void draft(stepWords); }}>{busy ? 'Reading…' : 'Draft it'}</button>
            <span className="muted small">{choice === 'hedge' ? 'A hedge uses legs 0 and 1.' : `You will see the draft before anything is signed.`}</span>
          </div>
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

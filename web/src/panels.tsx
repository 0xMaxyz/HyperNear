import { useState } from 'react';
import { decisionOf, sweepProblems, type Swept, type AgentEvent, type Decision, type DecisionMode, type DecisionOption, type GuardRow, type LegSnap, type OwnerView, type Position } from './api';
import type { DecisionRow } from './decisions';

const SOURCES: Record<string, string> = {
  jev: 'Jev decided alone',
  claude: 'Claude decided',
  disagree: 'Jev and Claude disagreed, the less risky action was taken',
};
const FACTORS: Record<string, string> = {
  hedgeNeeded: 'Hedge still needed',
  fundingMaterial: 'Funding cost material',
  nearLiquidation: 'A leg near liquidation',
  inProfit: 'In profit beyond fees',
  volatile: 'Market volatile',
};

const missing = (s: unknown) => s === null || s === undefined || s === '' || Number.isNaN(Number(s));
export const n = (s: string | number | null | undefined, dp = 2, min = 0) =>
  missing(s) ? 'n/a' : (Number(s) || 0).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: dp });
export const usd = (s: string | number | null | undefined, dp = 2) => (missing(s) ? 'n/a' : `${Number(s) < 0 ? '-' : ''}$${n(Math.abs(Number(s)), dp, Math.min(2, dp))}`);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Addr({ a }: { a: string }) {
  return (
    <code className="addr" title={a}>
      {short(a)}
    </code>
  );
}

function PositionText({ p, mark }: { p: Position; mark?: string }) {
  const size = Number(p.szi);
  return (
    <>
      <strong>
        {p.coin} {size > 0 ? 'long' : 'short'} {n(Math.abs(size), 5)}
      </strong>
      <span className="muted">
        {' '}
        at {usd(p.entryPx)} entry, {p.leverage.value}x {p.leverage.type}
      </span>
      <br />
      <span className="muted">
        mark {usd(mark)}, unrealized {usd(p.unrealizedPnl)}
      </span>
    </>
  );
}

export function LegsTable({ view, loading, error }: { view?: OwnerView; loading: boolean; error?: string }) {
  if (error) return <p className="state err" role="alert">{error}</p>;
  if (!view) return <p className="state">{loading ? 'Reading legs from the agent…' : 'No data yet.'}</p>;
  const legs = view.snapshot.legs;
  if (legs.length === 0) return <p className="state">No legs registered for this owner. Step 1 under Setup creates them.</p>;
  const guardOf = (id: string): GuardRow | undefined => view.guard.find((g) => g.id === id);
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Leg</th>
            <th>Address</th>
            <th>Position</th>
            <th className="num">Liquidation</th>
            <th className="num">Withdrawable</th>
            <th>Guard</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l: LegSnap) => {
            const ps = l.clearinghouse.assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);
            return (
              <tr key={l.leg}>
                <td data-label="Leg">
                  <strong>{l.leg}</strong>
                  {ROLES[l.leg] && <div className="muted small">{ROLES[l.leg]}</div>}
                </td>
                <td data-label="Address">
                  <Addr a={l.address} />
                  <br />
                  <span className="muted">agent {l.agent ? (l.agent.approvedAt ? 'approved' : 'key made, not approved') : 'none'}</span>
                  {l.activation === 'owed-on-credit' && <div className="flag small">new: first deposit loses 1 USDC activation</div>}
                  {l.activation === 'owed-on-first-send' && <div className="flag small">first transfer out costs 1 USDC activation</div>}
                </td>
                <td data-label="Position">
                  {ps.length === 0 ? (
                    <span className="muted">flat, account {usd(l.clearinghouse.marginSummary.accountValue)}</span>
                  ) : (
                    ps.map((p) => <div key={p.coin}><PositionText p={p} mark={view.snapshot.market.mids[p.coin]} /></div>)
                  )}
                </td>
                <td data-label="Liquidation" className="num">
                  {ps.length === 0 ? <span className="muted">none</span> : ps.map((p) => <div key={p.coin}>{p.liquidationPx === null ? 'none' : usd(p.liquidationPx)}</div>)}
                </td>
                <td data-label="Withdrawable" className="num">
                  {usd(l.clearinghouse.withdrawable)}
                  {l.activation === 'owed-on-first-send' && <div className="muted small">{usd(Math.max(0, Number(l.clearinghouse.withdrawable) - 1))} after the activation fee</div>}
                </td>
                <td data-label="Guard">
                  {ps.length === 0 ? (
                    <span className="muted">no position</span>
                  ) : (
                    ps.map((p) => {
                      const g = guardOf(`leg${l.leg}:${p.coin}`);
                      return g ? (
                        <div key={p.coin} className={g.trigger ? 'flag' : ''}>
                          {g.trigger ? `Trigger: ${g.reasons.join(', ').replaceAll('_', ' ')}` : 'ok'}
                          <span className="muted"> {g.distance === null ? '' : `${(g.distance * 100).toFixed(1)}% to liq`}</span>
                        </div>
                      ) : (
                        <div key={p.coin} className="muted">n/a</div>
                      );
                    })
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Leg roles of the demo layout (agent fixtures and the README flow). */
export const ROLES: Record<number, string> = { 0: 'long', 1: 'hedge', 2: 'reserve, source for the guard' };

export function summarize(e: AgentEvent): string {
  const d = e.data as Record<string, any>;
  const who = d.owner ? `${short(String(d.owner))} ` : '';
  switch (e.type) {
    case 'hedge':
      return `${who}${d.op} hedge ${d.coin}${d.refused ? `, refused: ${d.refused}` : d.fill ? `, filled ${d.fill.totalSz ?? '?'} at ${d.fill.avgPx ?? '?'}` : ''}`;
    case 'command':
      return `${who}signed command ${d.action} ${d.coin}`;
    case 'relay':
      return d.kind === 'registerLeg' ? `registered leg ${d.leg} ${short(String(d.address))}` : `owner intent sent${d.txHash ? `, tx ${short(String(d.txHash))}` : ''}`;
    case 'guard.ok':
      return `${who}guard ok on ${(d.legs as string[] | undefined)?.join(', ') ?? 'all legs'}`;
    case 'guard.trigger':
      return `${who}guard triggered on ${(d.triggered as GuardRow[] | undefined)?.map((t) => t.id).join(', ')}${d.plan?.kind ? `, plan ${d.plan.kind}${d.plan.reason ? `: ${d.plan.reason}` : ''}` : ''}`;
    case 'guard.error':
      return `${who}guard error: ${d.error}`;
    case 'guard.rebalance.start':
      return `${who}rebalance $${d.amount ?? '?'} from leg ${d.from?.leg ?? '?'} to leg ${d.to?.leg ?? '?'}`;
    case 'guard.rebalance.signed':
      return `${who}rebalance signed by NEAR, tx ${short(String(d.txHash ?? ''))}${d.ms ? `, ${(d.ms / 1000).toFixed(1)} s` : ''}`;
    case 'stress.marginMoved':
      return `stress test: $${d.movedToSpot} moved out of margin`;
    case 'stress.posted':
      return `stress test: short ${d.addedShort} added at ${d.leverage}x`;
    case 'agents.revoked': {
      const ls = (d.legs as { leg: number; ok: boolean }[] | undefined) ?? [];
      return `${who}trading keys revoked on Hyperliquid: ${ls.filter((l) => l.ok).length} of ${ls.length} legs${ls.some((l) => !l.ok) ? `, failed on ${ls.filter((l) => !l.ok).map((l) => l.leg).join(', ')}` : ''}`;
    }
    case 'tee.switched': {
      const ls = (d.legs as { leg: number; ok: boolean }[] | undefined) ?? [];
      const ok = ls.filter((l) => l.ok).length;
      return `${who}TEE keys revoked on ${ok} leg${ok === 1 ? '' : 's'}${ls.some((l) => !l.ok) ? `, failed on ${ls.filter((l) => !l.ok).map((l) => l.leg).join(', ')}` : ''}`;
    }
    case 'tee.paid': {
      const n = Number(d.months);
      return d.ok === false
        ? `${who}TEE payment of ${n} month${n === 1 ? '' : 's'} from leg ${String(d.leg)} was not accepted by Hyperliquid: ${JSON.stringify(d.hl ?? 'no answer').slice(0, 120)}`
        : `${who}TEE payment: ${n} month${n === 1 ? '' : 's'} paid from leg ${String(d.leg)}`;
    }
    case 'orders.swept': {
      const w = d as unknown as Swept;
      const secs = w.ms ? ` (${(w.ms / 1000).toFixed(1)} s)` : '';
      if (w.error) return `${who}Freeze sweep failed: ${w.error}${secs}`;
      const legs = w.legs.filter((l) => l.cancelled > 0).length;
      const bad = sweepProblems(w).length > 0;
      const head = w.cancelled === 0 ? 'no resting orders were left' : `${w.cancelled} resting order${w.cancelled === 1 ? '' : 's'} cancelled on ${legs} leg${legs === 1 ? '' : 's'}`;
      return `${who}Freeze sweep: ${head}${bad ? ', with problems (see below)' : ''}${secs}`;
    }
    case 'decision.proposed': {
      const x = decisionOf(e);
      return `proposed: ${x ? `${x.action.replaceAll('_', ' ')} on ${x.coin} (${SOURCES[x.source] ?? x.source}${x.flagged ? ', flagged' : ''})` : JSON.stringify(d).slice(0, 100)}`;
    }
    case 'decision.accepted':
      return `${who}accepted: ${String(d.action).replaceAll('_', ' ')} on ${d.coin}${d.auto ? ' automatically' : ''}`;
    case 'decision.rejected':
      return `${who}rejected: ${String(d.action).replaceAll('_', ' ')} on ${d.coin}${d.reason ? `, ${d.reason}` : ''}`;
    case 'decision.mode':
      return `${who}decision mode set to ${d.mode}`;
    case 'guard.rebalance.posted':
      return `${who}rebalance posted to Hyperliquid${d.ms ? ` after ${(d.ms / 1000).toFixed(1)} s` : ''}`;
    case 'agents.prepared':
      return `${who}agent keys prepared for legs ${((d.legs as { leg: number }[] | undefined) ?? []).map((l) => l.leg).join(', ')}`;
    default:
      return `${who}${JSON.stringify(d).slice(0, 140)}`;
  }
}

/** What the agent suggests, in plain words (the raw action ids never reach the page). */
const ACTION_TEXT: Record<string, (coin: string) => string> = {
  hold: () => 'Keep both legs as they are',
  close_both: (c) => `Close both ${c} legs`,
  reduce_hedge: (c) => `Shrink the ${c} hedge`,
  add_hedge: (c) => `Grow the ${c} hedge`,
  take_profit: (c) => `Take profit on the winning ${c} leg`,
  continue_strategy: () => 'Keep the strategy running',
  pause_strategy: () => 'Pause the strategy',
  adjust_strategy: () => 'Adjust the strategy',
};
export const decisionText = (d: { action: string; coin: string }) => (ACTION_TEXT[d.action]?.(d.coin) ?? d.action.replaceAll('_', ' '));
const RISK_LABEL: Record<DecisionOption['risk'], string> = { safest: 'Safest', safer: 'Safer', none: 'No change', riskier: 'Riskier', riskiest: 'Riskiest' };
const STATE_LABEL: Record<string, string> = { accepted: 'Accepted', declined: 'Declined', expired: 'Expired', replaced: 'Replaced by a newer suggestion', dismissed: 'Hidden' };
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function DecisionCard(p: {
  rows: DecisionRow[];
  mode?: DecisionMode;
  canSign: boolean;
  busy: string | null;
  onAccept: (d: Decision, action?: string) => void;
  onDecline: (d: Decision) => void;
  onHide: (d: Decision) => void;
  onMode: (m: DecisionMode) => void;
  onAsk: () => void;
}) {
  const current = p.rows.find((r) => r.state === 'open');
  const earlier = p.rows.filter((r) => r !== current);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string>();
  const why = p.canSign ? undefined : 'Log in to sign';
  const d = current?.d;
  const chosen = pick && d?.options?.some((o) => o.action === pick) ? pick : d?.action;
  const mins = d?.expiresAt ? Math.max(0, Math.round((d.expiresAt - Date.now()) / 60_000)) : undefined;
  return (
    <section className="card" aria-labelledby="dec-h">
      <h2 id="dec-h">Suggestions</h2>
      {!d || !current ? (
        <p className="state">No suggestions. The agent checks your hedges every few minutes.</p>
      ) : (
        <div className={`dec ${d.flagged ? 'flagged' : ''}`}>
          <p className="dec-line">
            <b>{decisionText(d)}</b>
            <span className="muted small"> · arrived {hm(current.at)}{mins !== undefined ? `, expires in ${mins} min` : ''}</span>
            <button className="link" aria-expanded={open} onClick={() => setOpen((x) => !x)}>{open ? 'Hide' : 'Review'}</button>
          </p>
          {open && (
            <>
              {d.rationale && <p className="rationale">{d.rationale}</p>}
              {d.options && d.options.length > 1 && (
                <fieldset className="dec-options">
                  <legend className="sr-only">What to do</legend>
                  {d.options.map((o) => (
                    <label key={o.action} className={chosen === o.action ? 'on' : ''}>
                      <input type="radio" name="dec-option" checked={chosen === o.action} onChange={() => setPick(o.action)} />
                      <span className={`risk risk-${o.risk}`}>{RISK_LABEL[o.risk]}</span>
                      <span>{o.text}{o.action === d.action ? ' (suggested)' : ''}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <details className="how">
                <summary>How the agent decided</summary>
                <dl className="kv">
                  <dt>Source</dt><dd className={d.flagged ? 'flag' : ''}>{SOURCES[d.source] ?? d.source}{d.flagged ? ', look twice' : ''}</dd>
                  <dt>Model</dt><dd>{d.model}</dd>
                  <dt>Latency</dt><dd>{(d.latencyMs / 1000).toFixed(1)} s</dd>
                </dl>
                {d.recorded && <p className="muted small">Recorded from a live testnet run.</p>}
                <ul className="probs" aria-label="Probability of yes per factor">
                  {Object.entries(d.factors ?? {}).map(([k, f]) => (
                    <li key={k}>
                      <span>{FACTORS[k] ?? k}</span>
                      <meter min={0} max={1} value={f.p ?? 0} aria-label={`${k} ${f.p === null ? 'unknown' : `${(f.p * 100).toFixed(0)} percent`}`} />
                      <span className="num">{f.p === null ? 'n/a' : `${(f.p * 100).toFixed(0)}%`}</span>
                    </li>
                  ))}
                </ul>
                {d.error && <p className="state err">{d.error}</p>}
              </details>
            </>
          )}
          <div className="actions">
            <button className="primary" disabled={!p.canSign || p.busy !== null} title={why} onClick={() => p.onAccept(d, chosen)}>{p.busy === 'decision' ? 'Waiting for signature…' : 'Sign · Do this'}</button>
            <button disabled={p.busy !== null} onClick={() => p.onHide(d)}>Not now</button>
            <button className="link" disabled={!p.canSign || p.busy !== null} title={why ?? 'Tells the agent no. Opens your wallet.'} onClick={() => p.onDecline(d)}>Decline</button>
          </div>
        </div>
      )}
      <div className="actions">
        <button disabled={p.busy !== null} onClick={p.onAsk}>{p.busy === 'ask' ? 'Asking…' : 'Ask now'}</button>
      </div>
      {earlier.length > 0 && (
        <details className="dec-earlier">
          <summary>Earlier ({earlier.length})</summary>
          <ul>
            {earlier.map((r) => (
              <li key={r.d.id}>
                <span>{decisionText(r.d)}</span>
                <span className="muted small">{hm(r.at)}</span>
                <span className={`chip chip-${r.state}`}>{STATE_LABEL[r.state]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="how">
        <summary>Autonomy: {p.mode === 'auto' ? 'Auto' : p.mode === 'off' ? 'Off' : 'Propose'}</summary>
        <fieldset className="mode" disabled={!p.canSign || p.busy !== null} title={why}>
          <legend className="sr-only">Autonomy</legend>
          {(['off', 'propose', 'auto'] as const).map((m) => (
            <label key={m} className={p.mode === m ? 'on' : ''}>
              <input type="radio" name="mode" checked={p.mode === m} onChange={() => p.onMode(m)} />
              {m === 'off' ? 'Off' : m === 'propose' ? 'Propose' : 'Auto'}
            </label>
          ))}
        </fieldset>
        <p className="muted small">
          {p.mode === 'auto' ? 'Auto runs unflagged suggestions within the contract and order policy. Flagged ones and "keep as is" still wait for you.' : p.mode === 'off' ? 'The agent makes no suggestions.' : 'The agent suggests and nothing runs until you sign.'}
        </p>
      </details>
    </section>
  );
}

export function DecisionPanel(p: {
  d?: Decision;
  mode?: DecisionMode;
  canSign: boolean;
  busy: string | null;
  onAccept: () => void;
  onDismiss: () => void;
  onMode: (m: DecisionMode) => void;
  onAsk: () => void;
}) {
  const { d } = p;
  const why = p.canSign ? undefined : 'Log in to sign';
  return (
    <section className="card" aria-labelledby="dec-h">
      <h2 id="dec-h">Decision</h2>
      <fieldset className="mode" disabled={!p.canSign || p.busy !== null} title={why}>
        <legend>Autonomy</legend>
        {(['off', 'propose', 'auto'] as const).map((m) => (
          <label key={m} className={p.mode === m ? 'on' : ''}>
            <input type="radio" name="mode" checked={p.mode === m} onChange={() => p.onMode(m)} />
            {m === 'off' ? 'Off' : m === 'propose' ? 'Propose' : 'Auto'}
          </label>
        ))}
      </fieldset>
      <p className="muted small">
        {p.mode === 'auto'
          ? 'Auto runs unflagged proposals within the contract and order policy. Flagged ones and hold still wait for you.'
          : p.mode === 'off'
            ? 'The agent makes no proposals.'
            : 'The agent proposes and nothing runs until you accept and sign.'}
      </p>
      {!d ? (
        <p className="state">No proposal waiting.</p>
      ) : (
        <>
          <p className="big-action">{d.action.replaceAll('_', ' ')} on {d.coin}</p>
          <dl className="kv">
            <dt>Source</dt>
            <dd className={d.flagged ? 'flag' : ''}>{SOURCES[d.source] ?? d.source}{d.flagged ? ', look twice' : ''}</dd>
            <dt>Model</dt>
            <dd>{d.model}</dd>
            <dt>Latency</dt>
            <dd>{(d.latencyMs / 1000).toFixed(1)} s</dd>
          </dl>
          {d.recorded && <p className="muted small">Recorded from a live testnet run.</p>}
          <ul className="probs" aria-label="Probability of yes per factor">
            {Object.entries(d.factors ?? {}).map(([k, f]) => (
              <li key={k}>
                <span>{FACTORS[k] ?? k}</span>
                <meter min={0} max={1} value={f.p ?? 0} aria-label={`${k} ${f.p === null ? 'unknown' : `${(f.p * 100).toFixed(0)} percent`}`} />
                <span className="num">{f.p === null ? 'n/a' : `${(f.p * 100).toFixed(0)}%`}</span>
                <span className="muted small who-decided">{f.decidedBy === 'claude' ? 'Claude' : 'Jev'}</span>
              </li>
            ))}
          </ul>
          {d.error && <p className="state err">{d.error}</p>}
          {d.rationale && <p className="rationale">{d.rationale}</p>}
          <div className="actions">
            <button className="primary" disabled={!p.canSign || p.busy !== null} title={why} onClick={p.onAccept}>{p.busy === 'decision' ? 'Waiting for signature…' : 'Accept and sign'}</button>
            <button disabled={!p.canSign || p.busy !== null} title={why} onClick={p.onDismiss}>Dismiss</button>
          </div>
        </>
      )}
      <div className="actions">
        <button disabled={p.busy !== null} onClick={p.onAsk}>{p.busy === 'ask' ? 'Asking…' : 'Ask for a proposal'}</button>
      </div>
    </section>
  );
}

/** NEAR explorer for the contract's chain. */
export const nearScan = (chainTag?: string) => (chainTag === 'near-mainnet' ? 'https://nearblocks.io/txns/' : 'https://testnet.nearblocks.io/txns/');

/** Per leg of a freeze sweep: the count, the NEAR transactions that signed the cancels, and any error in plain words. */
function SweptLegs({ w, scan }: { w: Swept; scan: string }) {
  if (w.error || w.legs.length === 0) return null;
  return (
    <ul className="sub">
      {w.legs.map((l) => (
        <li key={l.leg} className={l.error || l.hl.some((h) => h !== 'ok') ? 'flag' : ''}>
          <strong>Leg {l.leg}:</strong>{' '}
          {l.found === 0 ? 'no resting orders' : `${l.cancelled} cancelled${l.cancelled < l.found ? ` of ${l.found} found` : ''}${l.skipped ? `, ${l.skipped} skipped` : ''}`}
          {l.txHashes.map((h) => (
            <span key={h}>
              {', NEAR tx '}
              <a href={`${scan}${h}`} target="_blank" rel="noreferrer">{short(h)}</a>
            </span>
          ))}
          {l.error && `, error: ${l.error}`}
          {l.hl.filter((h) => h !== 'ok').map((h) => `, Hyperliquid ${h}`)}
        </li>
      ))}
    </ul>
  );
}

/** The freeze as steps: keys revoked, then resting orders cleared. Small, under the Freeze button. */
export function FreezeSteps({ events, show }: { events: AgentEvent[]; show: boolean }) {
  if (!show) return null;
  const rev = events.find((e) => e.type === 'agents.revoked');
  const sw = events.find((e) => e.type === 'orders.swept');
  const legs = (rev?.data.legs as { ok: boolean }[] | undefined) ?? [];
  const w = sw ? (sw.data as unknown as Swept) : undefined;
  const problems = w ? sweepProblems(w) : [];
  return (
    <ul className="freeze-steps" aria-label="What the freeze did">
      <li>
        Trading keys:{' '}
        {rev ? <span className={legs.every((l) => l.ok) ? 'ok-text' : 'flag'}>revoked on {legs.filter((l) => l.ok).length} of {legs.length} legs</span> : <span className="muted">pending</span>}
      </li>
      <li>
        Resting orders:{' '}
        {!w ? (
          <span className="muted">pending</span>
        ) : problems.length === 0 ? (
          <span className="ok-text">cleared ({w.cancelled})</span>
        ) : (
          <span className="flag">failed: {problems.join('; ')} (anyone can retry: see README)</span>
        )}
      </li>
    </ul>
  );
}

export function Activity({ events, stream, scan }: { events: AgentEvent[]; stream: 'live' | 'down' | 'connecting'; scan: string }) {
  return (
    <section className="card" aria-labelledby="ev-h">
      <h2 id="ev-h">Guard and decision log</h2>
      <p className="muted small">Stream: {stream === 'live' ? 'connected' : stream === 'connecting' ? 'connecting' : 'agent not reachable, retrying'}</p>
      {events.length === 0 ? (
        <p className="state">No events yet. Guard checks, hedge commands and rebalances appear here as the agent emits them.</p>
      ) : (
        <ol className="log">
          {events.map((e) => (
            <li key={e.id} className={e.type === 'guard.trigger' || e.type === 'guard.error' || (e.type === 'orders.swept' && sweepProblems(e.data as unknown as Swept).length > 0) ? 'flag' : ''}>
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString('en-GB')}</time>
              <span className="tag">{e.type}</span>
              <span>
                {summarize(e)}
                {e.type === 'orders.swept' && <SweptLegs w={e.data as unknown as Swept} scan={scan} />}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

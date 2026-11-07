import { decisionOf, type AgentEvent, type Decision, type GuardRow, type LegSnap, type OwnerView, type Position } from './api';

const SOURCES: Record<string, string> = {
  jev: 'Jev',
  jev_factors: 'Jev',
  claude_agrees: 'Claude agreed with Jev',
  claude_for_undecided: 'Claude, for the factors Jev could not decide',
  less_risky_of_two: 'Jev and Claude disagreed, the less risky action was taken',
  claude_only: 'Claude only, Jev was unavailable',
  fallback_hold: 'fallback to hold, both models failed',
};
const FACTORS: Record<string, string> = {
  hedgeNeeded: 'Hedge still needed',
  fundingMaterial: 'Funding cost material',
  nearLiquidation: 'A leg near liquidation',
  inProfit: 'In profit beyond fees',
  volatile: 'Market volatile',
};

const missing = (s: unknown) => s === null || s === undefined || s === '' || Number.isNaN(Number(s));
const n = (s: string | number | null | undefined, dp = 2, min = 0) =>
  missing(s) ? 'n/a' : (Number(s) || 0).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: dp });
const usd = (s: string | number | null | undefined, dp = 2) => (missing(s) ? 'n/a' : `${Number(s) < 0 ? '-' : ''}$${n(Math.abs(Number(s)), dp, 2)}`);
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
                <td data-label="Withdrawable" className="num">{usd(l.clearinghouse.withdrawable)}</td>
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

/** agent/src/pnl.ts CoinBreakeven, one entry per coin held. */
interface BeRow { coin: string; kind: string; breakEvenPx: number | null; lockedPnl: number | null; feesPaid: number; netFunding: number; estCloseFees: number; netSize: number }

const parseBreakeven = (b: unknown): BeRow[] => (Array.isArray(b) ? (b as BeRow[]) : []);

/** Leg roles of the demo layout (agent fixtures and the README flow). */
const ROLES: Record<number, string> = { 0: 'long', 1: 'hedge', 2: 'reserve, source for the guard' };

export function BreakevenCard({ view }: { view?: OwnerView }) {
  const rows = parseBreakeven(view?.breakeven);
  return (
    <section className="card" aria-labelledby="be-h">
      <h2 id="be-h">Break-even</h2>
      <p className="muted small">The price where both legs together net to zero after fees and funding. The agent computes it.</p>
      {rows.length === 0 ? (
        <p className="state">{view ? 'No open hedge, so there is nothing to break even on.' : 'Waiting for data.'}</p>
      ) : (
        rows.map((r) => (
          <dl key={r.coin} className="kv">
            <dt>{r.coin}</dt>
            <dd className="big">
              {r.kind === 'price' ? usd(r.breakEvenPx) : r.kind === 'locked' ? `Locked at ${usd(r.lockedPnl)}` : r.kind === 'always_profitable' ? 'In profit at every price' : r.kind === 'never_profitable' ? 'At a loss at every price' : 'n/a'}
            </dd>
            <dt>Net size</dt>
            <dd>{n(r.netSize, 5)} {r.coin}</dd>
            <dt>Fees paid</dt>
            <dd>{usd(r.feesPaid, 4)}</dd>
            <dt>Net funding</dt>
            <dd>{usd(r.netFunding, 4)}</dd>
            <dt>Est. close fees</dt>
            <dd>{usd(r.estCloseFees, 4)}</dd>
          </dl>
        ))
      )}
    </section>
  );
}

function summarize(e: AgentEvent): string {
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
    case 'decision.proposed':
    case 'decision.accepted':
    case 'decision.rejected': {
      const x = decisionOf(e);
      return `${e.type.slice(9)}: ${x ? `${x.action.replaceAll('_', ' ')} (${SOURCES[x.source] ?? x.source})` : JSON.stringify(d).slice(0, 100)}`;
    }
    case 'guard.rebalance.posted':
      return `${who}rebalance posted to Hyperliquid${d.ms ? ` after ${(d.ms / 1000).toFixed(1)} s` : ''}`;
    default:
      return `${who}${JSON.stringify(d).slice(0, 140)}`;
  }
}

export function DecisionPanel({ d, canSign, busy, onAccept, onDismiss }: { d?: Decision; canSign: boolean; busy: boolean; onAccept: () => void; onDismiss: () => void }) {
  const latency = d?.latencyMs ?? ((d?.jevMs ?? 0) + (d?.escalationMs ?? 0) || undefined);
  const probs = d?.factors ?? d?.probabilities;
  return (
    <section className="card" aria-labelledby="dec-h">
      <h2 id="dec-h">Decision</h2>
      {!d ? (
        <p className="state">No proposal waiting. When the agent suggests an action, the reasoning and the Accept button appear here. Nothing runs until you accept.</p>
      ) : (
        <>
          <p className="big-action">{d.action.replaceAll('_', ' ')}{d.coin ? ` on ${d.coin}` : ''}</p>
          <dl className="kv">
            <dt>Source</dt>
            <dd className={d.flagged ? 'flag' : ''}>{SOURCES[d.source] ?? d.source}{d.flagged ? ', needs your attention' : ''}</dd>
            {latency !== undefined && (<><dt>Latency</dt><dd>{(latency / 1000).toFixed(1)} s</dd></>)}
          </dl>
          {probs && (
            <ul className="probs" aria-label={d.factors ? 'Probability of yes per factor' : 'Probability per action'}>
              {Object.entries(probs).map(([k, v]) => (
                <li key={k}>
                  <span>{FACTORS[k] ?? k.replaceAll('_', ' ')}</span>
                  <meter min={0} max={1} value={v} aria-label={`${k} ${(v * 100).toFixed(0)} percent`} />
                  <span className="num">{(v * 100).toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          )}
          {d.rationale && <p className="rationale">{d.rationale}</p>}
          <div className="actions">
            <button className="primary" disabled={!canSign || busy} title={canSign ? undefined : 'Log in to sign'} onClick={onAccept}>{busy ? 'Waiting for signature…' : 'Accept and sign'}</button>
            <button disabled={busy} onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </section>
  );
}

export function Activity({ events, stream }: { events: AgentEvent[]; stream: 'live' | 'down' | 'connecting' }) {
  return (
    <section className="card" aria-labelledby="ev-h">
      <h2 id="ev-h">Guard and decision log</h2>
      <p className="muted small">Stream: {stream === 'live' ? 'connected' : stream === 'connecting' ? 'connecting' : 'agent not reachable, retrying'}</p>
      {events.length === 0 ? (
        <p className="state">No events yet. Guard checks, hedge commands and rebalances appear here as the agent emits them.</p>
      ) : (
        <ol className="log">
          {events.map((e) => (
            <li key={e.id} className={e.type === 'guard.trigger' || e.type === 'guard.error' ? 'flag' : ''}>
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString('en-GB')}</time>
              <span className="tag">{e.type}</span>
              <span>{summarize(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// Rebalance legs: pick legs and percentages, the pool of those legs' own USDC is redistributed to them.
// The owner signs the percentages once (a rebalanceLegs command bound to the exact spec); the agent then makes the moves, one after
// another, through the contract (own legs only, daily cap and cooldown on chain). The page shows what each move will be before signing.
import { useEffect, useMemo, useState } from 'react';
import { ApiError, getJson, post, type LegSnap, type OwnerView } from './api';
import { short, usd } from './panels';

export interface RebalanceSpec {
  legs: { leg: number; pct: number }[];
}
interface Move {
  from: { leg: number };
  to: { leg: number };
  amount: string;
  receives: string;
  feeUsd: number;
}
interface Row {
  leg: number;
  pct: number;
  before: number;
  target: number;
  after: number;
}
interface Plan {
  rows: Row[];
  moves: Move[];
  sentUsd: number;
  waitSec: number;
  notes: string[];
}
interface Job {
  state: 'running' | 'done' | 'failed';
  planned: number;
  steps: { from: number; to: number; amount: string; status: 'sent' | 'failed'; error?: string }[];
  error?: string;
}

const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

/** Whole percentages that add up to 100: the remainder goes to the first leg. */
export function evenSplit(legs: number[]): Record<number, number> {
  const each = Math.floor(100 / legs.length);
  return Object.fromEntries(legs.map((l, i) => [l, i === 0 ? 100 - each * (legs.length - 1) : each]));
}

export function RebalanceCard({ view, owner, locked, busy, why, onRebalance }: { view?: OwnerView; owner?: string; locked: boolean; busy: string | null; why?: string; onRebalance: (spec: RebalanceSpec) => void }) {
  const legs: LegSnap[] = view?.snapshot.legs ?? [];
  const [pct, setPct] = useState<Record<number, number>>({});
  const picked = useMemo(() => legs.filter((l) => pct[l.leg] !== undefined), [legs, pct]);
  const sum = picked.reduce((s, l) => s + (pct[l.leg] ?? 0), 0);
  const spec: RebalanceSpec = { legs: picked.map((l) => ({ leg: l.leg, pct: pct[l.leg]! })) };
  const valid = picked.length >= 2 && sum === 100 && picked.every((l) => Number.isInteger(pct[l.leg]) && pct[l.leg]! >= 1 && pct[l.leg]! <= 99);
  const key = JSON.stringify(spec);

  const [plan, setPlan] = useState<Plan>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setPlan(undefined);
    setErr(undefined);
    if (!owner || !valid) return;
    const t = setTimeout(() => {
      post('/rebalance/preview', { owner, spec: JSON.parse(key) })
        .then((r) => setPlan((r as { plan: Plan }).plan))
        .catch((e) => setErr(msg(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [owner, valid, key, view?.snapshot.at]);

  // the running job, if any: polled while it runs
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!owner) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await getJson<{ job: Job | null }>(`/rebalance/${owner}`);
        if (!stop) setJob(r.job);
      } catch {
        /* the page keeps working without the status */
      }
    };
    void tick();
    const id = setInterval(() => (job === null || job.state === 'running' || busy === 'rebalance') && void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [owner, busy, job?.state]);

  const toggle = (leg: number) =>
    setPct((p) => {
      const next = { ...p };
      if (next[leg] !== undefined) delete next[leg];
      else next[leg] = 0;
      const on = Object.keys(next).map(Number);
      return on.length ? { ...next, ...evenSplit(on) } : next;
    });
  const running = job?.state === 'running';
  const canSign = valid && Boolean(plan) && plan!.moves.length > 0 && !err && !running;

  if (legs.length < 2) return null;
  return (
    <section className="card" aria-labelledby="rb-h">
      <h2 id="rb-h">Rebalance legs</h2>
      <p className="muted small">
        Pick the legs and the share each should hold. The money of those legs is pooled and moved between them, only ever between your own legs. You sign the shares once; the agent then makes the moves one after another, within your daily cap and cooldown.
      </p>
      <table className="mini rb-table">
        <thead>
          <tr><th scope="col">Leg</th><th scope="col">Now</th><th scope="col">Share, %</th><th scope="col">After</th></tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const on = pct[l.leg] !== undefined;
            const row = plan?.rows.find((r) => r.leg === l.leg);
            return (
              <tr key={l.leg}>
                <td>
                  <label>
                    <input type="checkbox" checked={on} onChange={() => toggle(l.leg)} aria-label={`Include leg ${l.leg}`} /> Leg {l.leg}
                  </label>
                </td>
                <td>{usd(Number(l.clearinghouse.marginSummary.accountValue) + l.spotUsdc)}</td>
                <td>
                  <input
                    type="number" min={1} max={99} step={1} inputMode="numeric" className="rb-pct" disabled={!on}
                    value={on ? pct[l.leg] : ''} aria-label={`Share of leg ${l.leg}, percent`}
                    onChange={(e) => setPct((p) => ({ ...p, [l.leg]: e.target.value === '' ? 0 : Math.round(Number(e.target.value)) }))}
                  />
                </td>
                <td>{row ? usd(row.after) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions">
        <button disabled={picked.length < 2} onClick={() => setPct((p) => evenSplit(Object.keys(p).map(Number)))}>Even split</button>
        <span className={sum === 100 ? 'muted small' : 'flag small'} role="status">{picked.length < 2 ? 'Pick at least two legs.' : sum === 100 ? 'Shares add up to 100%.' : `Shares add up to ${sum}%, they must make 100%.`}</span>
      </div>
      {err && <p className="notice err" role="alert">{err}</p>}
      {plan && plan.moves.length > 0 && (
        <>
          <ul className="rb-moves">
            {plan.moves.map((m, i) => (
              <li key={i}>
                Leg {m.from.leg} → leg {m.to.leg}: {usd(Number(m.receives))}
                {m.feeUsd ? ` (+${usd(m.feeUsd)} Hyperliquid activation fee for a new leg)` : ''}
              </li>
            ))}
          </ul>
          <p className="muted small">{plan.moves.length === 1 ? 'One move' : `${plan.moves.length} moves, one after another`}{plan.waitSec > 0 ? `, about ${Math.max(1, Math.ceil(plan.waitSec / 60))} min including the cooldown` : ''}. Amounts follow the balances at the moment each move runs.</p>
        </>
      )}
      {plan?.notes.map((n) => <p key={n} className="state small">{n}</p>)}
      {job && (
        <p className={job.state === 'failed' ? 'notice err' : 'state small'} role="status">
          {job.state === 'running' && `Rebalancing: ${job.steps.filter((s) => s.status === 'sent').length} of ${job.planned} moves done…`}
          {job.state === 'done' && `Rebalanced: ${job.steps.length} move${job.steps.length === 1 ? '' : 's'} done.`}
          {job.state === 'failed' && `Stopped after ${job.steps.filter((s) => s.status === 'sent').length} move(s): ${job.error ?? 'unknown error'}. Run it again to finish.`}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={locked || !canSign} title={why} onClick={() => onRebalance(spec)}>
          {busy === 'rebalance' ? 'Waiting for signature…' : 'Sign · Rebalance'}
        </button>
      </div>
      {owner && <p className="muted small">Signed by {short(owner)} only: a 1-click session key can never move money between legs.</p>}
    </section>
  );
}

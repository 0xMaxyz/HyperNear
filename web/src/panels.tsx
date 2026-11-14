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

export type Severity = 'error' | 'warning' | 'success' | 'info';
export interface EventNote {
  title: string;
  detail?: string;
  severity: Severity;
  kind: 'guard' | 'funds' | 'trading' | 'keys' | 'strategy' | 'decision' | 'system';
}

/** a string or number from event data, or undefined: objects never reach the page as raw JSON */
const txt = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
/** Hyperliquid's answer in words: its error text when it gave one */
const hlText = (h: unknown) => (txt(h) ?? txt((h as { response?: unknown } | null)?.response) ?? 'no readable answer').slice(0, 120);
const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;
const KINDS: Record<string, EventNote['kind']> = { guard: 'guard', stress: 'guard', orders: 'guard', funds: 'funds', rebalance: 'funds', tee: 'funds', hedge: 'trading', order: 'trading', command: 'trading', session: 'trading', agents: 'keys', strategy: 'strategy', decision: 'decision' };

/** The bell's wording of an event: a short title, an optional detail line and a severity. The Activity log keeps summarize(). */
export function describeEvent(e: AgentEvent): EventNote {
  const d = e.data as Record<string, any>;
  const head = e.type.split('.')[0];
  const kind = KINDS[head] ?? 'system';
  const note = (title: string, severity: Severity, detail?: string): EventNote => ({ title, detail, severity, kind });
  const legs = Array.isArray(d.legs) ? (d.legs as ({ leg: number; ok: boolean } | null)[]).filter((l): l is { leg: number; ok: boolean } => typeof l === 'object' && l !== null) : [];
  const failedOn = legs.some((l) => !l.ok) ? `failed on ${legs.filter((l) => !l.ok).map((l) => l.leg).join(', ')}` : undefined;
  const secs = typeof d.ms === 'number' ? `${(d.ms / 1000).toFixed(1)} s` : undefined;
  if (e.type.startsWith('strategy.')) return describeStrategy(e.type.slice('strategy.'.length), d, note);
  switch (e.type) {
    case 'guard.ok':
      return note('Guard: all clear', 'info', `Watching ${(d.legs as string[] | undefined)?.join(', ') ?? 'all legs'}`);
    case 'guard.trigger':
      return note('Guard triggered', 'error', join((d.triggered as GuardRow[] | undefined)?.map((t) => t.id).join(', '), txt(d.plan?.kind) && `plan ${d.plan.kind}${d.plan.reason ? `: ${txt(d.plan.reason) ?? ''}` : ''}`));
    case 'guard.error':
      return note('Guard error', 'error', txt(d.error));
    case 'guard.rebalance.start':
      return note(`Guard moving $${txt(d.amount) ?? '?'}`, 'info', `From leg ${txt(d.from?.leg) ?? '?'} to leg ${txt(d.to?.leg) ?? '?'}`);
    case 'guard.rebalance.signed':
      return note('Guard rebalance signed by NEAR', 'info', join(`tx ${short(String(d.txHash ?? ''))}`, secs));
    case 'guard.rebalance.posted':
      return note('Guard rebalance posted to Hyperliquid', 'success', secs && `after ${secs}`);
    case 'stress.marginMoved':
      return note('Stress test: margin moved', 'info', `$${txt(d.movedToSpot) ?? '?'} moved out of margin`);
    case 'stress.posted':
      return note('Stress test: short added', 'info', `${txt(d.addedShort) ?? '?'} at ${txt(d.leverage) ?? '?'}x`);
    case 'legs.unified':
      return note(`Leg ${txt(d.leg) ?? '?'} is now a unified account`, 'success', d.address ? short(String(d.address)) : undefined);
    case 'legs.unified.failed':
      return note(`Leg ${txt(d.leg) ?? '?'} could not switch to a unified account`, 'error', txt(d.error));
    case 'hedge': {
      const what = `Hedge ${txt(d.op) ?? ''} ${txt(d.coin) ?? ''}`.replace(/\s+/g, ' ').trim();
      if (d.refused) return note(`${what} refused`, 'warning', txt(d.refused));
      if (d.fill) return note(`${what} filled`, 'success', `${txt(d.fill.totalSz) ?? '?'} at ${txt(d.fill.avgPx) ?? '?'}`);
      return note(what, d.status === 'filled' ? 'success' : 'info', txt(d.status));
    }
    case 'order': {
      const s = (d.spec ?? {}) as Record<string, unknown>;
      const coin = txt(s.coin) ?? '';
      const where = join(txt(d.leg) !== undefined && `leg ${txt(d.leg)}`, txt(s.type), txt(s.limitPx) && `at ${txt(s.limitPx)}`, txt(d.error));
      const sev: Severity = d.error ? 'error' : 'info';
      if (d.op === 'protect') return note(`Take-profit / stop-loss set on ${coin}`, sev, Array.isArray(s.legs) ? `legs ${s.legs.join(', ')}` : undefined);
      if (d.op === 'cancel') return note(`Order cancelled: ${coin}`, sev, where);
      if (d.op === 'modify') return note(`Order moved: ${coin}`, sev, join(txt(d.from) && `from ${txt(d.from)}`, txt(s.limitPx) && `to ${txt(s.limitPx)}`));
      return note(`Order placed: ${txt(s.side) ?? ''} ${txt(s.size) ?? ''} ${coin}`.replace(/\s+/g, ' '), sev, where);
    }
    case 'command':
      return note(`Signed command: ${txt(d.action) ?? '?'} ${txt(d.coin) ?? ''}`.trim(), 'info');
    case 'relay':
      return d.kind === 'registerLeg'
        ? note(`Leg ${txt(d.leg) ?? '?'} registered`, 'success', d.address ? short(String(d.address)) : undefined)
        : note('Owner intent sent', 'info', d.txHash ? `tx ${short(String(d.txHash))}` : undefined);
    case 'funds.moved': {
      const amt = `$${txt(d.amount) ?? '?'}`;
      const title = d.action === 'withdraw' ? `Withdrawal of ${amt} from leg ${txt(d.leg) ?? '?'}` : d.action === 'rebalance' ? `${amt} moved from leg ${txt(d.leg) ?? '?'} to leg ${txt(d.to) ?? '?'}` : `${amt} moved between spot and perps on leg ${txt(d.leg) ?? '?'}`;
      return d.ok === false ? note(`Not done: ${title}`, 'error', `Hyperliquid refused: ${hlText(d.hl)}`) : note(title, 'success');
    }
    case 'rebalance.start':
      return note('Rebalance started', 'info', Array.isArray(d.moves) ? `${plural(d.moves.length, 'move')} planned` : undefined);
    case 'rebalance.move':
      return note(`$${txt(d.amount) ?? '?'} sent from leg ${txt(d.from) ?? '?'} to leg ${txt(d.to) ?? '?'}`, d.status === 'failed' ? 'error' : 'success', txt(d.error));
    case 'rebalance.done':
      return note('Rebalance done', 'success', Array.isArray(d.steps) ? `${plural(d.steps.length, 'move')} sent` : undefined);
    case 'rebalance.failed': {
      const step = Array.isArray(d.steps) ? (d.steps as { error?: string }[]).find((s) => s.error) : undefined;
      return note('Rebalance failed', 'error', txt(d.error) ?? step?.error);
    }
    case 'agents.prepared':
      return note('Agent keys prepared', 'info', legs.length ? `Legs ${legs.map((l) => l.leg).join(', ')}` : undefined);
    case 'agents.approved':
      return d.ok === false
        ? note(`Agent key not approved on leg ${txt(d.leg) ?? '?'}`, 'error', hlText(d.hl))
        : note(`Agent key approved on leg ${txt(d.leg) ?? '?'}`, 'success', txt(d.agentName) || (d.agent ? short(String(d.agent)) : undefined));
    case 'agents.revoked':
      return note('Trading keys revoked on Hyperliquid', failedOn ? 'error' : 'success', join(`${legs.filter((l) => l.ok).length} of ${plural(legs.length, 'leg')}`, failedOn));
    case 'tee.switched': {
      const ok = legs.filter((l) => l.ok).length;
      return note('TEE keys revoked', failedOn ? 'error' : 'info', join(`on ${plural(ok, 'leg')}`, failedOn));
    }
    case 'tee.paid': {
      const months = plural(Number(d.months), 'month');
      return d.ok === false
        ? note('TEE payment not accepted', 'error', `${months} from leg ${txt(d.leg) ?? '?'}: ${hlText(d.hl)}`)
        : note('TEE payment made', 'success', `${months} paid from leg ${txt(d.leg) ?? '?'}`);
    }
    case 'orders.swept': {
      const w = d as unknown as Swept;
      if (w.error || !Array.isArray(w.legs)) return note('Freeze sweep failed', 'error', join(txt(w.error), secs));
      const problems = sweepProblems(w);
      const onLegs = w.legs.filter((l) => l.cancelled > 0).length;
      const done = w.cancelled === 0 ? 'No resting orders were left' : `${plural(w.cancelled, 'resting order')} cancelled on ${plural(onLegs, 'leg')}`;
      return note(problems.length ? 'Freeze sweep had problems' : 'Freeze sweep done', problems.length ? 'error' : 'success', join(done, secs, problems.join('; ')));
    }
    case 'decision.proposed': {
      const x = decisionOf(e);
      return note(x ? `Suggested: ${x.action.replaceAll('_', ' ')} on ${x.coin}` : 'New suggestion', 'info', x ? `${SOURCES[x.source] ?? x.source}${x.flagged ? ', flagged' : ''}` : undefined);
    }
    case 'decision.accepted':
      return note(`Accepted: ${String(d.action).replaceAll('_', ' ')} on ${txt(d.coin) ?? '?'}${d.auto ? ' automatically' : ''}`, 'success');
    case 'decision.rejected':
      return note(`Declined: ${String(d.action).replaceAll('_', ' ')} on ${txt(d.coin) ?? '?'}`, 'info', txt(d.reason));
    case 'decision.mode':
      return note(`Decision mode set to ${txt(d.mode) ?? '?'}`, 'info');
    case 'session.started':
      return note('One-click trading on', 'info');
    case 'session.ended':
      return note('One-click trading off', 'info', txt(d.reason)?.replaceAll('_', ' '));
    default:
      return note(eventName(e.type), /fail|error/.test(e.type) ? 'error' : /timeout|refused/.test(e.type) ? 'warning' : 'info', txt(d.error) ?? txt(d.message));
  }
}

/** "agents.revoke.hook_failed" -> "Agents · revoke hook failed" */
const eventName = (type: string) => {
  const [first, ...rest] = type.replaceAll('_', ' ').split('.');
  const t = rest.length ? `${first} · ${rest.join(' ')}` : first;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function describeStrategy(x: string, d: Record<string, any>, note: (title: string, severity: Severity, detail?: string) => EventNote): EventNote {
  const leg = txt(d.leg) !== undefined ? `leg ${txt(d.leg)}` : undefined;
  const at = (side: unknown, px: unknown, sz?: unknown) => [txt(side), txt(sz), txt(px) && `at ${txt(px)}`].filter(Boolean).join(' ') || undefined;
  const cancelled = typeof d.cancelled === 'number' ? `${plural(d.cancelled, 'order')} cancelled` : undefined;
  switch (x) {
    case 'started':
      return note('Strategy started', 'info', join([txt(d.type), txt(d.coin)].filter(Boolean).join(' '), leg));
    case 'error':
      return note('Strategy error', 'error', join(txt(d.message), leg));
    case 'restore_failed':
      return note('Strategy could not be restored', 'error', txt(d.error));
    case 'cancel_failed':
      return note('Strategy could not cancel its orders', 'warning', join(txt(d.message), d.retrying ? 'retrying' : undefined));
    case 'slice.skipped':
      return note('Slice skipped', 'warning', join(txt(d.slice) !== undefined && `slice ${txt(d.slice)}`, txt(d.reason)));
    case 'order.refused':
      return note('Strategy order refused', 'error', join(at(d.side, d.px), txt(d.reason)));
    case 'order.rejected':
      return note('Strategy order rejected', 'error', join(at(d.side, d.px), txt(d.error)));
    case 'order.lost':
      return note('Strategy order lost', 'error', join(txt(d.side), txt(d.level) !== undefined && `level ${txt(d.level)}`));
    case 'slice':
      return note('Slice filled', 'success', join(at(d.side, d.avgPx, d.sz), txt(d.done) !== undefined && `${txt(d.done)} of ${txt(d.of) ?? '?'}`));
    case 'fill':
      return note('Strategy order filled', 'success', at(d.side, d.px, d.sz));
    case 'order':
      return note('Strategy order placed', 'info', at(d.side, d.px, d.sz));
    case 'done':
      return note('Strategy finished', 'success', join(txt(d.filled) !== undefined && `${txt(d.filled)} filled`, txt(d.skipped) !== undefined && `${txt(d.skipped)} skipped`));
    case 'deadman':
      return note(d.armed ? "Dead man's switch armed" : "Dead man's switch not armed", 'warning', txt(d.reason));
    case 'restored':
      return note('Strategy restored', 'info', join(txt(d.state), leg));
    case 'resumed':
      return note('Strategy resumed', 'info', leg);
    case 'cancelled':
      return note('Strategy cancelled', 'info', join(txt(d.reason), cancelled));
    case 'paused':
      return note('Strategy paused', 'info', join(txt(d.reason), cancelled));
    case 'stopped':
      return note('Strategy stopped', 'info', join(txt(d.reason), cancelled, d.flattened ? 'position closed' : undefined));
    case 'frozen':
      return note('Strategy frozen', 'warning', cancelled);
    default:
      return note(eventName(`strategy.${x}`), /fail|error/.test(x) ? 'error' : 'info', txt(d.error) ?? txt(d.message));
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

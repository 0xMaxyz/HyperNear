import { useEffect, useState } from 'react';
import { getJson, type LegSnap, type OwnerView, type Position, type StrategyStatus } from './api';
import { n, short, usd } from './panels';

/** The agent scans legs 0..3 (agent/src/legs.ts MAX_LEGS). */
export const LEG_SLOTS = [0, 1, 2, 3];

export type LegState = 'setup' | 'strategy' | 'position' | 'empty' | 'spot' | 'reserve' | 'hedge-idle' | 'idle';
export interface LegActivity {
  state: LegState;
  label: string;
  headline: string;
  reason: string;
  action?: { label: string; to: string };
}

const ENDED = new Set(['done', 'stopped']);
const side = (p: Position) => (Number(p.szi) > 0 ? 'long' : 'short');
const open = (l: LegSnap) => l.clearinghouse.assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a leg is doing right now, or why it is not doing anything. First match wins, so the card always names the
 * thing standing in the way (setup, then funding) before the thing it is doing.
 */
export function legActivity(l: LegSnap, top: NonNullable<OwnerView['legs']>[number] | undefined, strategies: StrategyStatus[]): LegActivity {
  const positions = open(l);
  const perp = Number(l.clearinghouse.marginSummary.accountValue);
  const strat = strategies.find((s) => s.leg === l.leg && !ENDED.has(s.state));

  if (top && (!top.agent || top.needsPrepare)) return { state: 'setup', label: 'Needs setup', headline: 'No trading key yet', reason: 'The agent has no key for this leg. Prepare agents on the Home tab.', action: { label: 'Open Home', to: 'home' } };
  if (l.agent && !l.agent.approvedAt) return { state: 'setup', label: 'Needs setup', headline: 'Trading key not approved', reason: 'Hyperliquid has not approved the agent key. Approve it on the Home tab.', action: { label: 'Open Home', to: 'home' } };

  if (strat) {
    const slices = strat.twap && strat.spec ? ` of ${strat.spec.params.slices}` : '';
    const detail = strat.type === 'grid' ? `${strat.resting ?? 0} resting orders` : strat.twap ? `${strat.twap.done}${slices} slices done, ${strat.twap.skipped} skipped` : '';
    return { state: 'strategy', label: cap(strat.state), headline: `${cap(strat.type)} on ${strat.coin}`, reason: [strat.id, detail].filter(Boolean).join(', '), action: { label: 'Manage', to: 'strategies' } };
  }
  if (positions.length > 0) {
    const p = positions[0]!;
    return {
      state: 'position',
      label: 'In a position',
      headline: `${cap(side(p))} ${n(Math.abs(Number(p.szi)), 5)} ${p.coin}${positions.length > 1 ? ` and ${positions.length - 1} more` : ''}`,
      reason: l.leg <= 1 ? 'Opened by the hedge. The guard watches how far it is from liquidation.' : 'An open position.',
    };
  }
  if (perp === 0 && l.spotUsdc === 0) return { state: 'empty', label: 'Unfunded', headline: 'Empty', reason: 'Send USDC to this leg before it can trade.', action: { label: 'Fund this leg', to: `fund?leg=${l.leg}` } };
  if (l.spotUsdc > 0.01) return { state: 'spot', label: 'Move funds', headline: `${usd(l.spotUsdc)} on the spot balance`, reason: 'Funds on spot cannot trade. Move them to the trading balance first.', action: { label: 'Open Fund', to: `fund?leg=${l.leg}` } };
  if (l.leg === 2) return { state: 'reserve', label: 'Reserve', headline: 'Guard reserve', reason: 'Holds spare margin. The guard tops up a hedge leg from here when one nears liquidation.' };
  if (l.leg <= 1) return { state: 'hedge-idle', label: 'Idle', headline: 'Hedge leg, no position', reason: 'Open the hedge on the Hedge tab to give this leg a position.', action: { label: 'Open Hedge', to: 'hedge' } };
  return { state: 'idle', label: 'Idle', headline: 'Free for a strategy', reason: 'No strategy and no position. Start one on the Strategies tab.', action: { label: 'Start a strategy', to: `strategies?leg=${l.leg}` } };
}

/** The agent's strategy list for this owner, refetched whenever the leg snapshot changes. */
function useStrategies(owner: string | undefined, tick: number | undefined): StrategyStatus[] {
  const [rows, setRows] = useState<StrategyStatus[]>([]);
  useEffect(() => {
    if (!owner) return;
    let live = true;
    getJson<{ strategies: StrategyStatus[] }>(`/strategies/${owner}`).then(
      (r) => live && setRows(r.strategies),
      () => live && setRows([]), // an agent without strategies just shows none
    );
    return () => {
      live = false;
    };
  }, [owner, tick]);
  return rows;
}

function Distance({ pct }: { pct: number }) {
  // text first, the meter is a second cue: nothing depends on its colour
  return (
    <span className="distance">
      <meter min={0} max={100} low={15} high={30} optimum={100} value={Math.min(100, pct)} aria-hidden="true" />
      <span>{pct.toFixed(1)}% from liquidation{pct < 15 ? ' (close)' : ''}</span>
    </span>
  );
}

interface Props {
  view?: OwnerView;
  owner?: string;
  loading: boolean;
  error?: string;
  selected?: number;
  onSelect: (leg: number) => void;
  onGo: (to: string) => void;
  onAddLeg: (leg: number) => void;
  busy: string | null;
}

export function LegCards({ view, owner, loading, error, selected, onSelect, onGo, onAddLeg, busy }: Props) {
  const strategies = useStrategies(owner, view?.snapshot.at);
  const [copied, setCopied] = useState<string>();
  if (error) return <p className="state err" role="alert">{error}</p>;
  if (!view) return <p className="state">{loading ? 'Reading legs from the agent…' : 'No data yet.'}</p>;
  const legs = view.snapshot.legs;
  const registered = new Set(legs.map((l) => l.leg));
  const nextFree = LEG_SLOTS.find((i) => !registered.has(i));
  const mids = view.snapshot.market.mids;

  const copy = async (a: string) => {
    try {
      await navigator.clipboard.writeText(a);
      setCopied(a);
      setTimeout(() => setCopied((c) => (c === a ? undefined : c)), 1500);
    } catch {
      setCopied(undefined);
    }
  };

  if (legs.length === 0) return <p className="state">No legs registered for this owner. Step 1 on the Home tab creates them.</p>;

  return (
    <ul className="leg-cards">
      {legs.map((l) => {
        const act = legActivity(l, view.legs?.find((t) => t.leg === l.leg), strategies);
        const positions = open(l);
        const mine = strategies.filter((s) => s.leg === l.leg);
        const role = ({ 0: 'long', 1: 'hedge', 2: 'reserve' } as Record<number, string>)[l.leg] ?? 'strategy slot';
        const guard = (p: Position) => view.guard.find((g) => g.id === `leg${l.leg}:${p.coin}`)?.distance ?? (p.liquidationPx && mids[p.coin] ? Math.abs(Number(mids[p.coin]) - Number(p.liquidationPx)) / Number(mids[p.coin]) : null);
        return (
          <li key={l.leg} className={`leg-card state-${act.state}${selected === l.leg ? ' selected' : ''}`} data-leg={l.leg}>
            <div className="leg-head">
              <h3>Leg {l.leg}</h3>
              <span className="chip">{role}</span>
              <span className={`chip status ${act.state}`}>{act.label}</span>
            </div>
            <p className="headline">{act.headline}</p>
            <p className="muted small">{act.reason}</p>

            <dl className="kv leg-kv">
              <dt>Trading balance</dt>
              <dd>{usd(l.clearinghouse.marginSummary.accountValue)}</dd>
              <dt>Withdrawable</dt>
              <dd>{usd(l.clearinghouse.withdrawable)}</dd>
              {l.spotUsdc > 0 && (
                <>
                  <dt>On spot</dt>
                  <dd>{usd(l.spotUsdc)}</dd>
                </>
              )}
              {positions.map((p) => {
                const d = guard(p);
                return (
                  <div key={p.coin} className="pos-rows">
                    <dt>{p.coin} position</dt>
                    <dd>
                      {side(p)} {n(Math.abs(Number(p.szi)), 5)} at {usd(p.entryPx)}, {p.leverage.value}x
                      <br />
                      <span className="muted">unrealized {usd(p.unrealizedPnl)}, liquidation {p.liquidationPx === null ? 'none' : usd(p.liquidationPx)}</span>
                      {d !== null && <Distance pct={d * 100} />}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {l.activation === 'owed-on-credit' && <p className="flag small">New leg: the first deposit loses 1 USDC to Hyperliquid's activation fee.</p>}
            {l.activation === 'owed-on-first-send' && <p className="flag small">The first transfer out costs 1 USDC activation.</p>}

            <div className="actions tight">
              {act.action && <button className="primary" onClick={() => onGo(act.action!.to)}>{act.action.label}</button>}
              <button aria-pressed={selected === l.leg} onClick={() => (onSelect(l.leg), document.getElementById('leg-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>
                {selected === l.leg ? 'Showing chart' : 'Show chart'}
              </button>
            </div>

            <details>
              <summary>Details</summary>
              <dl className="kv leg-kv">
                <dt>Address</dt>
                <dd>
                  <code title={l.address}>{short(l.address)}</code>{' '}
                  <button className="small-btn" onClick={() => copy(l.address)}>{copied === l.address ? 'Copied' : 'Copy'}</button>
                </dd>
                <dt>Trading key</dt>
                <dd>{l.agent ? (l.agent.approvedAt ? `approved (${short(l.agent.address)})` : 'made, not approved') : 'none'}</dd>
                <dt>Strategies</dt>
                <dd>{mine.length === 0 ? 'none' : mine.map((s) => `${s.id} (${s.type} on ${s.coin}, ${s.state})`).join('; ')}</dd>
              </dl>
            </details>
          </li>
        );
      })}
      {nextFree !== undefined && (
        <li className="leg-card add">
          <h3>Add leg {nextFree}</h3>
          <p className="muted small">{nextFree === 2 ? 'The reserve the guard tops hedge legs up from.' : 'A free account for a strategy of its own.'}</p>
          <button disabled={busy !== null} onClick={() => onAddLeg(nextFree)}>{busy === 'legs' ? 'Registering…' : `Register leg ${nextFree}`}</button>
        </li>
      )}
    </ul>
  );
}

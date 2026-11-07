import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { commandTypedData, newCommand, ownerIntentTypedData, type OwnerIntent, type OwnerIntentTypedData } from '@hypernear/client';
import { AGENT_ACCOUNT, AGENT_URL, CHAIN_TAG, CONTRACT_ID, DEMO_OWNER, getOwner, pendingDecision, post, streamEvents, type AgentEvent, type OwnerView } from './api';
import { Activity, BreakevenCard, DecisionPanel, LegsTable, short } from './panels';

export interface Auth {
  ready: boolean;
  authenticated: boolean;
  address?: Hex;
  login: () => void;
  logout: () => void;
  sign: (td: OwnerIntentTypedData) => Promise<Hex>;
  /** no VITE_PRIVY_APP_ID: logging in is impossible, the demo still works */
  loginOff?: boolean;
}

type Notice = { kind: 'ok' | 'err'; text: string };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

export function App({ auth }: { auth: Auth }) {
  const [demo, setDemo] = useState(false);
  const owner = auth.address ?? (demo ? DEMO_OWNER : undefined);
  const canSign = Boolean(auth.address && owner === auth.address);

  const [view, setView] = useState<OwnerView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stream, setStream] = useState<'live' | 'down' | 'connecting'>('connecting');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [dry, setDry] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const [agentId, setAgentId] = useState(AGENT_ACCOUNT);
  const [cap, setCap] = useState('50');
  const [cooldown, setCooldown] = useState('60');
  const [coin, setCoin] = useState('BTC');
  const [ratio, setRatio] = useState('0.5');

  const refresh = useCallback(async () => {
    if (!owner) return;
    try {
      const v = await getOwner(owner);
      setView(v);
      if (v.dryRun) setDry(true);
      setError(undefined);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    setView(undefined);
    setError(undefined);
    setLoading(true);
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [owner, refresh]);

  useEffect(() => {
    if (!owner) return;
    setStream('connecting');
    return streamEvents(
      (e) => setEvents((l) => (l.some((x) => x.id === e.id) ? l : [e, ...l].slice(0, 80))),
      setStream
    );
  }, [owner]);

  const chainTag = view?.config?.chainTag ?? CHAIN_TAG;
  const contractId = view?.config?.contractId ?? CONTRACT_ID;
  const coins = view?.orderPolicy.allowedCoins ?? ['BTC', 'ETH'];
  const legs = view?.snapshot.legs ?? [];
  const registered = new Set(legs.map((l) => l.leg));
  const policy = view?.policy ?? null;

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setNotice(undefined);
    try {
      setNotice({ kind: 'ok', text: await fn() });
    } catch (e) {
      setNotice({ kind: 'err', text: msg(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const done = (out: Record<string, unknown>, what: string) => {
    if (out.dryRun) setDry(true);
    return `${what}${out.dryRun ? ' (simulated, dry-run)' : ''}${out.txHash ? `, NEAR tx ${short(String(out.txHash))}` : ''}.`;
  };

  /** Fresh nonce from the contract view, sign the intent with the owner wallet, send through the relayer. */
  async function ownerIntent(intent: OwnerIntent) {
    const nonce = (await getOwner(owner!)).policy?.nonce ?? 0;
    const sig = await auth.sign(ownerIntentTypedData({ chainTag, contractId, owner: owner!, nonce, intent }));
    return post('/relay', { owner, nonce, intent, sig });
  }

  const createLegs = () =>
    run('legs', async () => {
      const todo = [0, 1].filter((l) => !registered.has(l));
      for (const leg of todo) done(await post('/relay', { owner, intent: { type: 'registerLeg', leg } }), '');
      return todo.length ? `Registered leg${todo.length > 1 ? 's' : ''} ${todo.join(' and ')}${dry ? ' (simulated, dry-run)' : ''}.` : 'Both legs were already registered.';
    });

  const approvable = legs.filter((l) => l.agent && !l.agent.approvedAt);
  const approveAgents = () =>
    run('approve', async () => {
      let last: Record<string, unknown> = {};
      for (const l of approvable) {
        last = await ownerIntent({ type: 'approveAgent', leg: l.leg, agent: l.agent!.address.toLowerCase() as Hex, agentName: l.agent!.name, hlNonce: Date.now() });
      }
      return done(last, `Approved the agent key on leg${approvable.length > 1 ? 's' : ''} ${approvable.map((l) => l.leg).join(' and ')}`);
    });

  const policyOk = agentId.trim() !== '' && DECIMAL.test(cap) && /^\d+$/.test(cooldown);
  const enableAgent = () =>
    run('policy', async () => done(await ownerIntent({ type: 'setPolicy', agent: agentId.trim(), dailyCap: cap, cooldownSec: Number(cooldown) }), `Agent ${agentId.trim()} enabled, cap $${cap} a day`));

  const toggleFreeze = () =>
    run('freeze', async () => {
      const frozen = !policy?.frozen;
      const out = await ownerIntent({ type: 'freeze', frozen });
      const revoked = Array.isArray(out.revoked) ? (out.revoked as { ok: boolean }[]) : [];
      return done(out, frozen ? `Account frozen${revoked.length ? `, trading keys revoked on ${revoked.filter((r) => r.ok).length} of ${revoked.length} legs` : ''}` : 'Account unfrozen. Approve the agent again to trade');
    });

  const ratioOk = /^\d+(\.\d+)?$/.test(ratio) && Number(ratio) > 0 && Number(ratio) <= 1;
  const hedge = (open: boolean) =>
    run(open ? 'open' : 'close', async () => {
      const cmd = newCommand(owner!, open ? 'openHedge' : 'closeHedge', coin, open ? ratio : '0');
      const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
      return done(await post(open ? '/hedge/open' : '/hedge/close', { command: cmd, sig }), open ? `Hedge on ${coin} opened at ratio ${ratio}` : `Hedge on ${coin} closed`);
    });

  const decision = pendingDecision(events, dismissed);
  const acceptDecision = () =>
    run('decision', async () => {
      const d = decision!;
      // assumption: the agent verifies a Command whose action is the decision's action; contract-dev confirms the exact shape
      const cmd = newCommand(owner!, d.action as never, d.coin ?? coins[0] ?? 'BTC', d.ratio ?? '0');
      const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
      return done(await post(`/decision/${encodeURIComponent(d.id)}/accept`, { command: cmd, sig }), `Accepted: ${d.action.replaceAll('_', ' ')}`);
    });

  const why = canSign ? undefined : 'Log in to sign';
  const locked = !canSign || busy !== null;

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <h1>HyperNear</h1>
          <span className="muted tagline">Smart accounts for Hyperliquid, keys held by NEAR</span>
        </div>
        <div className="who">
          {dry && <span className="badge" title={`Served by the agent with ${AGENT_URL}; no keys, recorded testnet data`}>dry-run data</span>}
          {owner && <code className="addr" title={owner}>{short(owner)}</code>}
          {auth.authenticated ? (
            <button onClick={auth.logout}>Log out</button>
          ) : demo ? (
            <>
              <button onClick={() => setDemo(false)}>Leave demo</button>
              <button className="primary" onClick={auth.login} disabled={auth.loginOff || !auth.ready}>Log in</button>
            </>
          ) : null}
        </div>
      </header>

      {!owner ? (
        <main className="intro">
          <h2>Your Hyperliquid account, with rules the account itself enforces.</h2>
          <p>
            A Hyperliquid key is a bare address: anyone holding it can move everything. Here the keys belong to NEAR Chain Signatures and a public NEAR contract decides what may be signed. Withdrawals go only to you,
            the agent gets a capped allowance, and you can freeze everything.
          </p>
          <p className="muted">The contract limits where funds can go, not whether a trade loses money.</p>
          <div className="actions">
            <button className="primary" onClick={auth.login} disabled={auth.loginOff || !auth.ready}>
              {auth.ready ? 'Log in with passkey, email or wallet' : 'Loading login…'}
            </button>
            <button onClick={() => setDemo(true)}>Explore recorded data</button>
          </div>
          {auth.loginOff && <p className="state">Login is off because VITE_PRIVY_APP_ID is not set. The recorded data still works.</p>}
          <p className="muted small">Your owner address must be an ordinary wallet (Privy embedded wallet or MetaMask). Smart-contract wallets are not supported.</p>
        </main>
      ) : (
        <main>
          <div aria-live="polite" className="notice-slot">
            {notice && <p className={`notice ${notice.kind}`} role={notice.kind === 'err' ? 'alert' : 'status'}>{notice.text}</p>}
          </div>

          <section className="card wide" aria-labelledby="legs-h">
            <h2 id="legs-h">Legs</h2>
            <LegsTable view={view} loading={loading} error={error} />
          </section>

          <div className="grid">
            <section className="card" aria-labelledby="setup-h">
              <h2 id="setup-h">Setup</h2>
              {!canSign && <p className="state">Read-only: log in to sign setup steps.</p>}
              <ol className="steps">
                <li>
                  <div>
                    <strong>1. Create legs</strong>
                    <p className="muted small">Two Hyperliquid accounts whose keys the contract holds.</p>
                  </div>
                  <span className={registered.has(0) && registered.has(1) ? 'ok' : 'todo'}>{registered.has(0) && registered.has(1) ? 'done' : 'to do'}</span>
                  <button disabled={!owner || !canSign || busy !== null || (registered.has(0) && registered.has(1))} title={why} onClick={createLegs}>{busy === 'legs' ? 'Registering…' : 'Create legs'}</button>
                </li>
                <li>
                  <div>
                    <strong>2. Approve agent</strong>
                    <p className="muted small">
                      {legs.length > 0 && legs.some((l) => !l.agent)
                        ? 'The service has not made an agent key for every leg yet, so there is nothing to approve there.'
                        : 'You sign one intent per leg; the contract signs the Hyperliquid approval.'}
                    </p>
                  </div>
                  <span className={legs.length > 0 && legs.every((l) => l.agent?.approvedAt) ? 'ok' : 'todo'}>{legs.length > 0 && legs.every((l) => l.agent?.approvedAt) ? 'done' : 'to do'}</span>
                  <button disabled={locked || approvable.length === 0} title={why} onClick={approveAgents}>{busy === 'approve' ? 'Waiting for signature…' : 'Approve agent'}</button>
                </li>
                <li className="stack">
                  <div className="row">
                    <div>
                      <strong>3. Enable agent</strong>
                      <p className="muted small">Name the NEAR account that may rebalance between your legs, with a daily cap and a cooldown.</p>
                    </div>
                    <span className={policy?.agent ? 'ok' : 'todo'}>{policy?.agent ? 'done' : 'to do'}</span>
                  </div>
                  <div className="fields">
                    <label>
                      Agent account
                      <input value={agentId} onChange={(e) => setAgentId(e.target.value)} spellCheck={false} />
                    </label>
                    <label>
                      Daily cap, USDC
                      <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" aria-invalid={!DECIMAL.test(cap)} />
                    </label>
                    <label>
                      Cooldown, seconds
                      <input value={cooldown} onChange={(e) => setCooldown(e.target.value)} inputMode="numeric" aria-invalid={!/^\d+$/.test(cooldown)} />
                    </label>
                  </div>
                  <button disabled={locked || !policyOk || legs.length === 0} title={why} onClick={enableAgent}>{busy === 'policy' ? 'Waiting for signature…' : policy?.agent ? 'Update policy' : 'Enable agent'}</button>
                  {policy && (
                    <p className="muted small">
                      Current: {policy.agent ?? 'no agent'}, cap ${(policy.daily_cap / 1e6).toLocaleString('en-US')} a day, ${(policy.spent_today / 1e6).toLocaleString('en-US')} used today, cooldown {policy.cooldown_sec} s.
                    </p>
                  )}
                </li>
              </ol>
              <div className="freeze">
                <div>
                  <strong>{policy?.frozen ? 'Account is frozen' : 'Emergency stop'}</strong>
                  <p className="muted small">Halts everything the contract signs and revokes the agents' Hyperliquid trading keys. Resting orders stay until cancelled. Withdrawals to you still work.</p>
                </div>
                <button className={policy?.frozen ? '' : 'danger'} disabled={locked || legs.length === 0} title={why} onClick={toggleFreeze}>
                  {busy === 'freeze' ? 'Waiting for signature…' : policy?.frozen ? 'Unfreeze' : 'Freeze'}
                </button>
              </div>
            </section>

            <div className="col">
              <DecisionPanel d={decision} canSign={canSign} busy={busy === 'decision'} onAccept={acceptDecision} onDismiss={() => setDismissed((s) => new Set(s).add(decision!.id))} />
              <section className="card" aria-labelledby="hedge-h">
                <h2 id="hedge-h">Hedge</h2>
                <p className="muted small">
                  Leg 1 takes the opposite side of leg 0, sized by the ratio. The agent checks leverage up to {view?.orderPolicy.maxLeverage ?? '…'}x and notional up to ${view?.orderPolicy.maxNotionalUsd ?? '…'} before trading. You sign each command; it expires in 30 s.
                </p>
                <div className="fields inline">
                  <label>
                    Coin
                    <select value={coin} onChange={(e) => setCoin(e.target.value)}>
                      {coins.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label>
                    Ratio of leg 0 size, 0 to 1
                    <input value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="decimal" aria-invalid={!ratioOk} />
                  </label>
                </div>
                <div className="actions">
                  <button className="primary" disabled={locked || !ratioOk} title={why} onClick={() => hedge(true)}>{busy === 'open' ? 'Waiting for signature…' : 'Open hedge'}</button>
                  <button disabled={locked} title={why} onClick={() => hedge(false)}>{busy === 'close' ? 'Waiting for signature…' : 'Close hedge'}</button>
                </div>
              </section>
              <BreakevenCard view={view} />
            </div>
          </div>

          <Activity events={events} stream={stream} />
        </main>
      )}
    </>
  );
}

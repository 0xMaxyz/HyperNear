import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { commandTypedData, newCommand, ownerIntentTypedData, type Command, type OwnerIntent, type OwnerIntentTypedData } from '@hypernear/client';
import { AGENT_ACCOUNT, AGENT_URL, CHAIN_TAG, CONTRACT_ID, DEMO_OWNER, TEE_AGENT_URL, getOwner, pendingDecision, pointAgentAt, post, streamEvents, type AgentEvent, type DecisionMode, type OwnerView } from './api';
import { LegPanel } from './legpanel';
import { Activity, BreakevenCard, DecisionPanel, FreezeSteps, nearScan, short } from './panels';
import { LegCards } from './legcards';
import { StrategiesPanel } from './strategies';
import { dryApply, inTeeMode, loadTee, lookupTeeAgent, priceMicro, type TeeState, ZERO_HASH } from './tee';
import { HostingCard } from './teepanel';
import { AccountMenu, type AuthAccount } from './account';
import { FundTab } from './fund';
import { Learn } from './learn';
import { Panel, Tabs, useRoute, type TabDef } from './tabs';

export interface Auth {
  ready: boolean;
  authenticated: boolean;
  address?: Hex;
  login: () => void;
  logout: () => void;
  sign: (td: OwnerIntentTypedData) => Promise<Hex>;
  /** no VITE_PRIVY_APP_ID: logging in is impossible, the demo still works */
  loginOff?: boolean;
  /** what the Account menu shows; absent when there is no login */
  account?: AuthAccount;
}

const TABS = ['home', 'legs', 'hedge', 'strategies', 'fund', 'activity', 'learn'];

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
  const [tee, setTee] = useState<TeeState>();
  const [teeErr, setTeeErr] = useState<string>();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [route, go] = useRoute(TABS);
  const [selLeg, setSelLeg] = useState<number>();

  const teeMode = inTeeMode(tee);
  const [agentId, setAgentId] = useState<string>(); // undefined until typed: then the agent's own account from /owner config
  const [cap, setCap] = useState('50');
  const [cooldown, setCooldown] = useState('60');
  const [coin, setCoin] = useState('BTC');
  const [ratio, setRatio] = useState('0.5');

  // owner calls (setup, prepare, commands) go to the TEE agent once the owner is in TEE mode
  pointAgentAt(teeMode);
  const refresh = useCallback(async () => {
    if (!owner) return;
    try {
      const v = await getOwner(owner);
      setView(v);
      if (v.dryRun) setDry(true);
      setError(undefined);
      // the hosting mode lives on the contract, not in the agent: read it next to the owner view
      loadTee(owner, { dryRun: Boolean(v.dryRun), chainTag: v.config?.chainTag ?? CHAIN_TAG, contractId: v.config?.contractId ?? CONTRACT_ID }).then(
        (t) => (setTee(t), setTeeErr(undefined)),
        (e) => setTeeErr(msg(e)),
      );
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => void refresh(), [teeMode, refresh]); // a new hosting mode means a new agent to ask
  useEffect(() => {
    if (!owner) return;
    setView(undefined);
    setTee(undefined);
    setError(undefined);
    setLoading(true);
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [owner, refresh]);

  useEffect(() => {
    if (!owner) return;
    setStream('connecting');
    const add = (e: AgentEvent) => setEvents((l) => (l.some((x) => x.id === e.id) ? l : [e, ...l].slice(0, 80)));
    // the server agent's stream stays open (setTee and payTee are relayed through it); a TEE owner's own agent adds a second one
    const second = teeMode && TEE_AGENT_URL && TEE_AGENT_URL !== AGENT_URL;
    const stops = [streamEvents(add, (s) => (!second || !teeMode) && setStream(s))];
    if (second) stops.push(streamEvents(add, setStream, TEE_AGENT_URL, 1e9));
    return () => stops.forEach((f) => f());
  }, [owner, teeMode]);

  const chainTag = view?.config?.chainTag ?? CHAIN_TAG;
  const contractId = view?.config?.contractId ?? CONTRACT_ID;
  const coins = view?.orderPolicy.allowedCoins ?? ['BTC', 'ETH'];
  const legs = view?.snapshot.legs ?? [];
  const topLegs = view?.legs ?? [];
  // in TEE mode the contract's agent check is the TEE account named in setTee
  const agentValue = teeMode ? (tee?.tee?.agent_account ?? '') : (agentId ?? view?.config?.agentAccount ?? AGENT_ACCOUNT);
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

  /** Funds that arrived on a leg's spot balance cannot trade until the owner moves them to the perp (trading) balance. */
  const moveToTrading = (leg: number, amount: string) =>
    run('move', async () => done(await ownerIntent({ type: 'usdClassTransfer', leg, amount, toPerp: true, hlNonce: Date.now() }), `Moved ${amount} USDC on leg ${leg} to the trading balance`));

  /** Registering a leg is permissionless: the relayer pays, no signature. */
  const addLeg = (leg: number) =>
    run('legs', async () => {
      done(await post('/relay', { owner, intent: { type: 'registerLeg', leg } }), '');
      return `Registered leg ${leg}${dry ? ' (simulated, dry-run)' : ''}.`;
    });

  /** Keys the service has not made yet: the owner signs a prepareAgents command. */
  const needPrepare = topLegs.filter((l) => !l.agent || l.needsPrepare);
  const prepareAgents = () =>
    run('prepare', async () => {
      const cmd = newCommand(owner!, 'prepareAgents' as never, '', '0');
      const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
      return done(await post('/agents/prepare', { command: cmd, sig }), 'Agent keys prepared');
    });

  const pending = view?.pendingApprovals ?? [];
  // Hyperliquid refuses every action, approving a key included, on an account that never received a deposit
  const unfunded = legs.filter((l) => Number(l.clearinghouse.marginSummary.accountValue) + l.spotUsdc <= 0);
  const approvalBlocked = pending.some((p) => unfunded.some((l) => l.leg === p.leg));
  const approveAgents = () =>
    run('approve', async () => {
      // each intent is signed exactly as the agent listed it; every one burns the owner's next nonce, so re-read it
      let ok = 0;
      let failed = '';
      for (const intent of (await getOwner(owner!)).pendingApprovals ?? []) {
        const nonce = (await getOwner(owner!)).policy?.nonce ?? 0;
        const sig = await auth.sign(ownerIntentTypedData({ chainTag, contractId, owner: owner!, nonce, intent }));
        const out = await post('/relay', { owner, nonce, intent, sig });
        if (out.dryRun) setDry(true);
        if (out.ok === false) {
          const why = JSON.stringify(out.hl ?? out.error ?? 'refused');
          failed = /Must deposit/i.test(why) ? `leg ${intent.leg} has never received a deposit, and Hyperliquid acts on no account before one. Fund it on the Fund tab, then approve again` : `leg ${intent.leg}: ${why.slice(0, 120)}`;
        }
        else ok++;
      }
      if (failed) throw new Error(`Approved ${ok}. ${failed}`);
      return `Approved the agent key on ${ok} leg${ok === 1 ? '' : 's'}${dry ? ' (simulated, dry-run)' : ''}.`;
    });

  const policyOk = agentValue.trim() !== '' && DECIMAL.test(cap) && /^\d+$/.test(cooldown);
  const enableAgent = () =>
    run('policy', async () => done(await ownerIntent({ type: 'setPolicy', agent: agentValue.trim(), dailyCap: cap, cooldownSec: Number(cooldown) }), `Agent ${agentValue.trim()} enabled, cap $${cap} a day`));

  /** TEE mode: setTee and payTee go through the server agent. The dry-run agent only simulates, so its fixture applies them itself. */
  const teeIntent = async (intent: OwnerIntent) => {
    const nonce = (await getOwner(owner!)).policy?.nonce ?? 0;
    const sig = await auth.sign(ownerIntentTypedData({ chainTag, contractId, owner: owner!, nonce, intent }));
    const out = await post('/relay', { owner, nonce, intent, sig }, AGENT_URL);
    if (out.dryRun) dryApply(intent);
    return out;
  };
  const switchTee = (account: string, hash: string) =>
    run('tee-switch', async () => done(await teeIntent({ type: 'setTee', measurementHash: hash as Hex, agentAccount: account }), `Switched to TEE mode with ${account}. Pay next, then Prepare agents`));
  const leaveTee = () =>
    run('tee-leave', async () => {
      const out = await teeIntent({ type: 'setTee', measurementHash: ZERO_HASH, agentAccount: '' });
      const revoked = Array.isArray(out.revoked) ? (out.revoked as { ok: boolean }[]) : [];
      return done(out, `Back on the server${revoked.length ? `, TEE keys revoked on ${revoked.filter((r) => r.ok).length} of ${revoked.length} legs` : ''}. Prepare agents again`);
    });
  const payTee = (leg: number, months: number) =>
    run('tee-pay', async () => {
      if (!tee?.priceUsd || !tee.feeAddress) throw new Error('This contract does not offer TEE mode');
      const out = await teeIntent({ type: 'payTee', leg, months, priceMicro: priceMicro(tee.priceUsd), feeAddress: tee.feeAddress });
      if (out.ok === false) throw new Error(`Hyperliquid did not accept the payment: ${JSON.stringify(out.hl ?? out.error ?? 'refused').slice(0, 120)}`);
      return done(out, `Paid ${months} month${months === 1 ? '' : 's'} of TEE hosting from leg ${leg}`);
    });

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

  // /events carries every owner's events: keep this owner's and the global ones
  const mine = events.filter((e) => !e.data.owner || String(e.data.owner).toLowerCase() === owner);
  const decision = pendingDecision(mine, dismissed, view?.decision);
  /** A signed Command whose action (and coin) the agent checks against the proposal or mode it names. */
  const signed = async (action: string, coinField: string, path: string) => {
    const cmd = newCommand(owner!, action as never, coinField, '0');
    const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
    return post(path, { command: cmd, sig });
  };
  const acceptDecision = () =>
    run('decision', async () => {
      const d = decision!;
      return done(await signed(d.action, d.coin, `/decision/${encodeURIComponent(d.id)}/accept`), `Accepted: ${d.action.replaceAll('_', ' ')} on ${d.coin}`);
    });
  const dismissDecision = () =>
    run('decision', async () => {
      const d = decision!;
      const out = await signed('reject', d.coin, `/decision/${encodeURIComponent(d.id)}/reject`);
      setDismissed((x) => new Set(x).add(d.id));
      return done(out, 'Proposal dismissed');
    });
  const setMode = (m: DecisionMode) => run('mode', async () => done(await signed('setDecisionMode', m, '/decision/mode'), `Autonomy set to ${m}`));
  const askProposal = () =>
    run('ask', async () => {
      const out = await post('/decision/propose', { owner });
      return done(out, 'Asked the agent for a proposal. It arrives in the log and here in a few seconds');
    });

  const signCommand = (c: Command) => auth.sign(commandTypedData(chainTag, contractId, c));
  const why = canSign ? undefined : 'Log in to sign';
  const locked = !canSign || busy !== null;

  const tabDefs: TabDef[] = [
    { id: 'home', label: 'Home', dot: pending.length > 0 ? 'An agent key is waiting for your approval' : undefined },
    { id: 'legs', label: 'Legs' },
    { id: 'hedge', label: 'Hedge', dot: decision ? 'A decision is waiting for you' : undefined },
    { id: 'strategies', label: 'Strategies' },
    { id: 'fund', label: 'Fund' },
    { id: 'activity', label: 'Activity' },
    { id: 'learn', label: 'Learn' },
  ];
  // approvals must not hide behind a tab: say so on every other tab
  const attention =
    decision && route.tab !== 'hedge'
      ? { text: 'A decision is waiting for you.', link: 'Review it', href: '#/hedge' }
      : pending.length > 0 && route.tab !== 'home'
        ? { text: 'An agent key is waiting for your approval.', link: 'Approve it', href: '#/home' }
        : undefined;

  return (
    <>
      <header className="top">
        <div className="brand">
          <svg className="mark" viewBox="8 9 32 32" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 18a7 7 0 0 1 14 0v14a7 7 0 0 1-14 0v-7" />
            <path d="M17 18l6 7" />
          </svg>
          <h1>HyperNear</h1>
          <span className="muted tagline">Smart accounts for Hyperliquid, keys held by NEAR</span>
        </div>
        <div className="who">
          {view?.config && <span className="muted small" title={`${view.config.chainTag}, contract ${view.config.contractId}`}>Hyperliquid {view.config.hlNetwork}</span>}
          {dry && <span className="badge" title={`Served by the agent with ${AGENT_URL}; no keys, recorded testnet data`}>dry-run data</span>}
          {owner && (
            <button className="addr" aria-haspopup="dialog" title={`Account ${owner}`} onClick={() => setMenu(true)}>
              {short(owner)}
            </button>
          )}
          {!auth.authenticated && demo && (
            <button className="primary" onClick={auth.login} disabled={auth.loginOff || !auth.ready}>Log in</button>
          )}
        </div>
      </header>
      {owner && (
        <AccountMenu
          open={menu}
          onClose={() => setMenu(false)}
          owner={owner}
          signedIn={auth.authenticated}
          account={auth.account}
          network={view?.config?.hlNetwork}
          mode={dry ? 'recorded data (dry-run), nothing is sent' : view?.config ? `live, ${view.config.chainTag}` : 'connecting…'}
          onLogout={() => (setMenu(false), auth.logout())}
          onLogin={auth.loginOff ? undefined : () => (setMenu(false), auth.login())}
          onLeaveDemo={demo ? () => setDemo(false) : undefined}
          onGo={go}
        />
      )}

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

          <Tabs tabs={tabDefs} current={route.tab} onGo={go} />
          {attention && (
            <p className="attention" role="status">
              {attention.text} <a href={attention.href}>{attention.link}</a>
            </p>
          )}

          {route.tab === 'legs' && (
            <Panel id="legs">
              <section className="card wide" aria-labelledby="legs-h">
                <h2 id="legs-h">Legs</h2>
                <LegCards view={view} owner={owner} loading={loading} error={error} selected={selLeg} onSelect={setSelLeg} onGo={go} onAddLeg={addLeg} busy={busy} />
              </section>
              <LegPanel view={view} demo={demo} leg={selLeg} onLeg={setSelLeg} />
            </Panel>
          )}

          {route.tab === 'home' && (
          <Panel id="home">
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
                    <strong>2. Prepare agents</strong>
                    <p className="muted small">{teeMode ? "The TEE agent makes one Hyperliquid trading key per leg in its own memory and the contract approves it for you: there is nothing more to sign." : 'The service makes one Hyperliquid trading key per leg. You sign the request, the keys never leave the service.'}</p>
                  </div>
                  <span className={topLegs.length > 0 && needPrepare.length === 0 ? 'ok' : 'todo'}>{topLegs.length > 0 && needPrepare.length === 0 ? 'done' : 'to do'}</span>
                  <button disabled={locked || needPrepare.length === 0} title={why} onClick={prepareAgents}>{busy === 'prepare' ? 'Waiting for signature…' : 'Prepare agents'}</button>
                </li>
                <li>
                  <div>
                    <strong>3. Fund the legs</strong>
                    <p className="muted small">Send USDC to each leg. Hyperliquid will not approve a trading key on an account that has never received a deposit, so this comes before approving.</p>
                  </div>
                  <span className={legs.length > 0 && unfunded.length === 0 ? 'ok' : 'todo'}>{legs.length > 0 && unfunded.length === 0 ? 'done' : 'to do'}</span>
                  <button disabled={legs.length === 0} onClick={() => go(unfunded[0] ? `fund?leg=${unfunded[0].leg}` : 'fund')}>Open Fund</button>
                </li>
                <li>
                  <div>
                    <strong>4. Approve agent</strong>
                    <p className="muted small">You sign one approval per leg exactly as listed; the contract signs it for Hyperliquid and the service posts it.{approvalBlocked && ' Fund the legs first (step 3).'}</p>
                  </div>
                  <span className={legs.length > 0 && legs.every((l) => l.agent?.approvedAt) ? 'ok' : 'todo'}>{legs.length > 0 && legs.every((l) => l.agent?.approvedAt) ? 'done' : 'to do'}</span>
                  <button disabled={locked || pending.length === 0 || approvalBlocked} title={approvalBlocked ? 'Fund the legs first' : why} onClick={approveAgents}>{busy === 'approve' ? 'Waiting for signature…' : 'Approve agent'}</button>
                </li>
                <li className="stack">
                  <div className="row">
                    <div>
                      <strong>5. Enable agent</strong>
                      <p className="muted small">Name the NEAR account that may rebalance between your legs, with a daily cap and a cooldown.</p>
                    </div>
                    <span className={policy?.agent ? 'ok' : 'todo'}>{policy?.agent ? 'done' : 'to do'}</span>
                  </div>
                  <div className="fields">
                    {teeMode ? (
                      <p className="muted small">TEE mode: the contract accepts only the TEE agent named above; your daily cap and cooldown still apply.</p>
                    ) : (
                      <label>
                        Agent account
                        <input value={agentValue} onChange={(e) => setAgentId(e.target.value)} spellCheck={false} />
                      </label>
                    )}
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
            </section>

            <HostingCard
              state={tee}
              error={teeErr}
              teeUrl={TEE_AGENT_URL}
              legs={legs}
              feeActivation={view?.config?.teeFeeActivation}
              chainTag={chainTag}
              canSign={canSign}
              busy={busy}
              why={why}
              lookup={(a) => lookupTeeAgent(a, { dryRun: Boolean(view?.dryRun), chainTag, contractId })}
              onSwitch={switchTee}
              onPay={payTee}
              onLeave={leaveTee}
            />
          </Panel>
          )}

          {route.tab === 'hedge' && (
          <Panel id="hedge">
          <div className="grid">
            <div className="col">
              <DecisionPanel d={decision} mode={view?.decision?.mode} canSign={canSign} busy={busy} onAccept={acceptDecision} onDismiss={dismissDecision} onMode={setMode} onAsk={askProposal} />
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
            </div>
            <div className="col">
              <BreakevenCard view={view} />
              <section className="card" aria-labelledby="freeze-h">
                <h2 id="freeze-h">{policy?.frozen ? 'Account is frozen' : 'Emergency stop'}</h2>
                <div className="freeze">
                  <p className="muted small">Halts everything the contract signs and revokes the agents' Hyperliquid trading keys. The agent then cancels the resting orders on those legs. Withdrawals to you still work.</p>
                  <button className={policy?.frozen ? '' : 'danger'} disabled={locked || legs.length === 0} title={why} onClick={toggleFreeze}>
                    {busy === 'freeze' ? 'Waiting for signature…' : policy?.frozen ? 'Unfreeze' : 'Freeze'}
                  </button>
                </div>
                <FreezeSteps events={mine} show={Boolean(policy?.frozen) || (dry && mine.some((e) => e.type === 'agents.revoked' || e.type === 'orders.swept'))} />
              </section>
            </div>
          </div>
          </Panel>
          )}

          {route.tab === 'strategies' && (
            <Panel id="strategies">
              <StrategiesPanel legs={legs} owner={owner} canSign={canSign} events={mine} sign={signCommand} tick={view?.snapshot.at} leg={route.params.get('leg') === null ? undefined : Number(route.params.get('leg'))} />
            </Panel>
          )}

          {route.tab === 'fund' && (
            <Panel id="fund">
              <FundTab view={view} owner={owner} leg={route.params.get('leg') === null ? undefined : Number(route.params.get('leg'))} canSign={canSign} dry={dry} locked={locked} busy={busy} why={why} onGo={go} onMove={moveToTrading} onChanged={() => void refresh()} />
            </Panel>
          )}

          {route.tab === 'activity' && (
            <Panel id="activity">
              <Activity events={mine.filter((e) => !e.type.startsWith('strategy.'))} stream={stream} scan={nearScan(chainTag)} />
            </Panel>
          )}

          {route.tab === 'learn' && (
            <Panel id="learn">
              <Learn slug={route.rest[0]} />
            </Panel>
          )}
        </main>
      )}
    </>
  );
}

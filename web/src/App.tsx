import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { commandTypedData, newCommand, ownerIntentTypedData, specHashOfJson, type Command, type OwnerIntent, type OwnerIntentTypedData } from '@hypernear/client';
import { AGENT_ACCOUNT, AGENT_URL, CHAIN_TAG, CONTRACT_ID, DEMO_OWNER, TEE_AGENT_URL, getOwner, pointAgentAt, post, streamEvents, type AgentEvent, type Decision, type DecisionMode, type OwnerView } from './api';
import { LegPanel } from './legpanel';
import { decisionRows } from './decisions';
import { Activity, DecisionCard, decisionText, FreezeSteps, nearScan, short } from './panels';
import { toast, ToastHost } from './toast';
import { NotificationsPanel, useNotifications } from './notifications';
import { OverviewTab } from './overview';
import { TradeTab } from './trade';
import { rebalanceLegs, type HedgeSpec } from './trading';
import type { RebalanceSpec } from './rebalance';
import { canApprove, isFunded, setupSteps } from './setup';
import { LegCards } from './legcards';
import { StrategiesPanel } from './strategies';
import { dryApply, inTeeMode, loadTee, lookupTeeAgent, priceMicro, type TeeState, ZERO_HASH } from './tee';
import { HostingCard } from './teepanel';
import { AccountMenu, type AuthAccount } from './account';
import { FundTab } from './fund';
import { Learn } from './learn';
import { EasyTab } from './easy';
import { useLiveLegs, useOverlay } from './liveLegs';
import { Panel, Tabs, useRoute, type TabDef } from './tabs';
import { useSession } from './session';

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

/** the five sections in the nav, then routes reached from the top bar (setup, activity, learn), then old links that redirect */
const TABS = ['trade', 'easy', 'portfolio', 'strategies', 'fund', 'protect', 'setup', 'activity', 'learn', 'home', 'overview', 'hedge', 'legs'];
const MOVED: Record<string, string> = { home: 'setup', overview: 'portfolio', legs: 'portfolio/legs', hedge: 'protect', strategies: 'easy' };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

export function App({ auth }: { auth: Auth }) {
  // the Trade screen is as tall as the window minus the header: tell the CSS how tall the header is
  useEffect(() => {
    const el = document.querySelector('header.top');
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--top-h', `${el.getBoundingClientRect().height}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => ro.disconnect();
  });
  const [demo, setDemo] = useState(false);
  const owner = auth.address ?? (demo ? DEMO_OWNER : undefined);
  const canSign = Boolean(auth.address && owner === auth.address);

  const [polled, setView] = useState<OwnerView>();
  // positions and balances are pushed by Hyperliquid's socket; the agent view is polled and fills in the rest
  const live = useLiveLegs(polled);
  const view = useOverlay(polled, live);
  const liveRef = useRef(false);
  liveRef.current = live.state === 'live';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stream, setStream] = useState<'live' | 'down' | 'connecting'>('connecting');
  const [busy, setBusy] = useState<string | null>(null);
  const [bell, setBell] = useState(false);
  const [dry, setDry] = useState(false);
  const [tee, setTee] = useState<TeeState>();
  const [teeErr, setTeeErr] = useState<string>();
  // "Not now" hides a suggestion in this browser (no wallet); it stays hidden after a reload
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('hypernear.hidden-decisions') ?? '[]'));
    } catch {
      return new Set<string>();
    }
  });
  const hide = (id: string) =>
    setDismissed((x) => {
      const next = new Set(x).add(id);
      try {
        localStorage.setItem('hypernear.hidden-decisions', JSON.stringify([...next].slice(-200)));
      } catch {
        /* storage off: hidden until reload */
      }
      return next;
    });
  const [menu, setMenu] = useState(false);
  const [route, go] = useRoute(TABS);
  // old links (#/home, #/overview, #/legs, #/hedge) land on the section that now holds them
  useEffect(() => {
    const to = MOVED[route.tab];
    if (to) go(`${to}${route.params.toString() ? `?${route.params}` : ''}`);
  }, [route.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selLeg, setSelLeg] = useState<number>();
  const [strategyChoose, setStrategyChoose] = useState<{ family: 'grid' | 'dca'; n: number }>({ family: 'grid', n: 0 }); // the Grid or DCA option picked on the Easy screen
  const [strategyAsk, setStrategyAsk] = useState({ text: '', n: 0 }); // words the Easy box routed to the strategy drafter

  const teeMode = inTeeMode(tee);
  const [agentId, setAgentId] = useState<string>(); // undefined until typed: then the agent's own account from /owner config
  const [cap, setCap] = useState('50');
  const [cooldown, setCooldown] = useState('60');
  const [coin, setCoin] = useState('BTC');
  const [ratio, setRatio] = useState('0.5');
  const [lev1, setLev1] = useState('');
  const [margin1, setMargin1] = useState<'same' | 'cross' | 'isolated'>('same');

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
    // slower while the socket carries the positions, the old pace when it does not
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => (void refresh(), loop()), liveRef.current ? 30_000 : 10_000);
    };
    loop();
    return () => clearTimeout(t);
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
  const walletSign = (c: Command) => auth.sign(commandTypedData(chainTag, contractId, c));
  // 1-click trading: orders and cancels go to the session key when this tab holds a live session, everything else to the wallet
  const session = useSession(canSign ? owner : undefined, view, walletSign, chainTag, contractId);
  const coins = view?.orderPolicy.allowedCoins ?? ['BTC', 'ETH'];
  const legs = view?.snapshot.legs ?? [];
  const topLegs = view?.legs ?? [];
  // in TEE mode the contract's agent check is the TEE account named in setTee
  const agentValue = teeMode ? (tee?.tee?.agent_account ?? '') : (agentId ?? view?.config?.agentAccount ?? AGENT_ACCOUNT);
  const registered = new Set(legs.map((l) => l.leg));
  const policy = view?.policy ?? null;

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    try {
      toast('ok', await fn());
    } catch (e) {
      toast('err', msg(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const done = (out: Record<string, unknown>, what: string) => {
    if (out.dryRun) setDry(true);
    return `${what}${out.dryRun ? ' (simulated)' : ''}${out.txHash ? `, NEAR tx ${short(String(out.txHash))}` : ''}.`;
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
  /** The contract only signs these; the service posts them to Hyperliquid and says whether Hyperliquid accepted. */
  const hlResult = (out: Record<string, unknown>) => {
    if (out.ok === false) throw new Error(`Hyperliquid refused: ${typeof out.hl === 'object' ? JSON.stringify((out.hl as { response?: unknown }).response ?? out.hl) : String(out.hl)}`.slice(0, 220));
    return out;
  };
  const moveToTrading = (leg: number, amount: string) =>
    run('move', async () => done(hlResult(await ownerIntent({ type: 'usdClassTransfer', leg, amount, toPerp: true, hlNonce: Date.now() })), `Moved ${amount} USDC on leg ${leg} to the trading balance`));

  /** Leg to the owner's own wallet; Hyperliquid keeps 1 USDC of it. */
  const withdrawLeg = (leg: number, amount: string) =>
    run('withdraw', async () => done(hlResult(await ownerIntent({ type: 'withdraw', leg, amount, hlTime: Date.now() })), `Withdrew ${amount} USDC from leg ${leg} to your wallet (you receive ${(Number(amount) - 1).toFixed(2)})`));

  /** The owner signs the shares (never a session key); the agent then makes the moves between the owner's own legs. */
  const rebalance = (spec: RebalanceSpec) =>
    run('rebalance', async () => {
      const out = await rebalanceLegs(walletSign, owner!, spec);
      return done(out, `Rebalance started: ${(out.plan as { moves: unknown[] }).moves.length} move(s) between legs ${spec.legs.map((l) => l.leg).join(', ')}`);
    });

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
  // Hyperliquid refuses every action, approving a key included, on an account that never received a deposit: the funded legs are approved, an empty extra leg waits
  const unfunded = legs.filter((l) => !isFunded(l));
  const approvable = pending.filter((p) => canApprove(p.leg, legs));
  const approvalBlocked = pending.length > 0 && approvable.length === 0;
  const approveAgents = () =>
    run('approve', async () => {
      // each intent is signed exactly as the agent listed it; every one burns the owner's next nonce, so re-read it
      let ok = 0;
      let failed = '';
      const waiting: number[] = [];
      for (const intent of (await getOwner(owner!)).pendingApprovals ?? []) {
        if (!canApprove(intent.leg, legs)) {
          waiting.push(intent.leg);
          continue;
        }
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
      return `Approved the agent key on ${ok} leg${ok === 1 ? '' : 's'}${dry ? ' (simulated, dry-run)' : ''}.${waiting.length ? ` Leg ${waiting.join(', ')} has no funds yet and waits.` : ''}`;
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
  const lev1Ok = lev1 === '' || (/^\d+$/.test(lev1) && Number(lev1) >= 1 && Number(lev1) <= Math.min(view?.orderPolicy.maxLeverage ?? 5, view?.snapshot.market.assets?.find((a) => a.name === coin)?.maxLeverage ?? 40));
  const hedgeCoinParam = route.tab === 'hedge' ? route.params.get('coin') : null;
  useEffect(() => {
    if (hedgeCoinParam && coins.includes(hedgeCoinParam)) setCoin(hedgeCoinParam);
  }, [hedgeCoinParam]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Leg 1's own leverage and margin mode ride with the command as a hedge spec the owner signs; empty fields mean "same as leg 0". */
  const hedgeSpec = (): HedgeSpec | undefined => {
    const spec: HedgeSpec = { ...(lev1 ? { leg1Leverage: Number(lev1) } : {}), ...(margin1 !== 'same' ? { leg1IsCross: margin1 === 'cross' } : {}) };
    return Object.keys(spec).length ? spec : undefined;
  };
  const hedge = (open: boolean, c = coin, closeLegs?: number[]) =>
    run(open ? 'open' : 'close', async () => {
      // a close names the two legs of the hedge shown (any two legs); an open may carry leg 1's own leverage
      const openSpec = open ? hedgeSpec() : undefined;
      const spec = openSpec ?? (closeLegs && !open ? { legs: closeLegs } : undefined);
      const cmd = newCommand(owner!, open ? 'openHedge' : 'closeHedge', c, open ? ratio : '0', 30, Date.now(), spec ? specHashOfJson(spec) : undefined);
      const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
      return done(await post(open ? '/hedge/open' : '/hedge/close', { command: cmd, sig, ...(spec ? { spec } : {}) }), open ? `Hedge on ${c} opened at ratio ${ratio}${openSpec ? ` (leg 1 ${openSpec.leg1Leverage ? `${openSpec.leg1Leverage}x ` : ''}${openSpec.leg1IsCross === undefined ? '' : openSpec.leg1IsCross ? 'cross' : 'isolated'})` : ''}` : `Hedge on ${c} closed`);
    });

  // /events carries every owner's events: keep this owner's and the global ones
  const mine = events.filter((e) => !e.data.owner || String(e.data.owner).toLowerCase() === owner);
  const decisionList = decisionRows(mine, dismissed, view?.decision);
  const decision = decisionList.find((r) => r.state === 'open')?.d;
  /** A signed Command whose action (and coin) the agent checks against the proposal or mode it names. */
  const signed = async (action: string, coinField: string, path: string) => {
    const cmd = newCommand(owner!, action as never, coinField, '0');
    const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
    return post(path, { command: cmd, sig });
  };
  const acceptDecision = (d: Decision, action = d.action) =>
    run('decision', async () => {
      // a chosen option other than the suggestion is named in the request; the command carries that action
      const cmd = newCommand(owner!, action as never, d.coin, '0');
      const sig = await auth.sign(commandTypedData(chainTag, contractId, cmd));
      const out = await post(`/decision/${encodeURIComponent(d.id)}/accept`, { command: cmd, sig, ...(action !== d.action ? { option: action } : {}) });
      return done(out, `Done: ${decisionText({ action, coin: d.coin })}`);
    });
  const declineDecision = (d: Decision) =>
    run('decision', async () => {
      const out = await signed('reject', d.coin, `/decision/${encodeURIComponent(d.id)}/reject`);
      hide(d.id);
      return done(out, 'Suggestion declined');
    });
  const setMode = (m: DecisionMode) => run('mode', async () => done(await signed('setDecisionMode', m, '/decision/mode'), `Autonomy set to ${m}`));
  const askProposal = () =>
    run('ask', async () => {
      const out = await post('/decision/propose', { owner });
      return done(out, 'Asked the agent for a proposal. It arrives in the log and here in a few seconds');
    });

  const signCommand = (c: Command) => session.signFor(c) ?? walletSign(c);
  const why = canSign ? undefined : 'Log in to sign';
  const locked = !canSign || busy !== null;

  const tabDefs: TabDef[] = [
    { id: 'easy', label: 'Easy' },
    { id: 'trade', label: 'Trade' },
    { id: 'portfolio', label: 'Portfolio' },
    { id: 'fund', label: 'Fund' },
    { id: 'protect', label: 'Safety', dot: decision ? 'A decision is waiting for you' : policy?.frozen ? 'The account is frozen' : undefined },
  ];
  // setup: the five steps, done or not (the Setup page and the banner read the same list)
  const setupDone = setupSteps({ registered, topLegs, legs, policyAgent: Boolean(policy?.agent) });
  const setupCount = setupDone.filter(Boolean).length;
  // the "Finish setup" reminder can be hidden per owner; the Account menu and the Setup page bring it back
  const hideKey = owner ? `hypernear.setup-hidden:${owner}` : '';
  const [setupHidden, setSetupHidden] = useState(false);
  useEffect(() => {
    try {
      setSetupHidden(Boolean(hideKey && localStorage.getItem(hideKey)));
    } catch {
      setSetupHidden(false);
    }
  }, [hideKey]);
  const hideSetup = (hide: boolean) => {
    setSetupHidden(hide);
    try {
      if (hide) localStorage.setItem(hideKey, '1');
      else localStorage.removeItem(hideKey);
    } catch {
      /* the choice then lasts until the tab closes */
    }
  };
  // approvals must not hide behind a section: say so on every other page
  const attention =
    decision && route.tab !== 'protect'
      ? { text: `The agent suggests: ${decisionText(decision)}.`, link: 'Review', href: '#/protect' }
      : approvable.length > 0 && route.tab !== 'setup'
        ? { text: 'An agent key is waiting for your approval.', link: 'Approve it', href: '#/setup' }
        : view && !dry && canSign && setupCount < 5 && route.tab !== 'setup' && !setupHidden
          ? { text: `Setup: ${setupCount} of 5 steps done.`, link: 'Finish setup', href: '#/setup', dismiss: () => hideSetup(true) }
          : undefined;
  // the bell: toasts and agent events not yet marked read (the read marker is kept per owner in this browser)
  const notes = useNotifications(owner, mine);
  const unread = notes.unread;
  const guardHot = (view?.guard ?? []).filter((g) => g.trigger).length;
  const watched = (view?.guard ?? []).length;

  /** step 5 of setup, and the agent card on Protect: who may rebalance, with what daily cap and cooldown */
  const policyForm = () => (
    <>
      <div className="fields">
        {teeMode ? (
          <p className="muted small">TEE mode: the contract accepts only the TEE agent named in Hosting; your daily cap and cooldown still apply.</p>
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
    </>
  );

  return (
    <>
      <ToastHost />
      <header className="top">
        <div className="brand">
          <svg className="mark" viewBox="8 9 32 32" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 18a7 7 0 0 1 14 0v14a7 7 0 0 1-14 0v-7" />
            <path d="M17 18l6 7" />
          </svg>
          <h1>HyperNear</h1>
        </div>
        {owner && <Tabs tabs={tabDefs} current={route.tab} onGo={go} />}
        <div className="who">
          {view?.config && <span className={`net ${view.config.hlNetwork}`} title={`${view.config.chainTag}, contract ${view.config.contractId}`}>{view.config.hlNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}</span>}
          {owner && !dry && live.state !== 'idle' && (
            <span className={`pill live ${live.state}`} title={live.state === 'live' ? 'Positions and orders are pushed by Hyperliquid as they change' : 'The live connection is down or paused; the page refreshes by polling'}>
              {live.state === 'live' ? 'Live' : live.state === 'connecting' ? 'Connecting' : 'Polling'}
            </span>
          )}
          {dry && <span className="badge" title={`Served by the agent with ${AGENT_URL}; no keys, recorded testnet data`}>dry-run data</span>}
          {owner && view && (
            <a className={`pill ${guardHot ? 'hot' : ''}`} href="#/protect" title="The guard watches every open position's margin and liquidation distance">
              <span className="dot-s" aria-hidden="true" />
              {guardHot ? `Guard: ${guardHot} at risk` : watched ? `Guard watching ${watched}` : 'Guard idle'}
            </a>
          )}
          {owner && view && <span className="pill agent" title={teeMode ? 'Your own TEE agent runs the policy and holds the trading keys' : 'Our server agent runs the policy and holds the trading keys'}>{teeMode ? 'TEE agent' : 'Server agent'}</span>}
          {owner && (
            <button className="icon-btn" aria-haspopup="dialog" aria-expanded={bell} onClick={() => setBell((x) => !x)} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
              {unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
            </button>
          )}
          {bell && <NotificationsPanel n={notes} onClose={() => setBell(false)} />}
          <a className="icon-btn help" href="#/learn" aria-label="Help and how it works">?</a>
          {owner && (
            <button className="addr" aria-haspopup="dialog" title={`Account ${owner}`} onClick={() => setMenu(true)}>
              {short(owner)}
            </button>
          )}
          {!auth.authenticated && demo && (
            <button className="primary" onClick={auth.login} disabled={auth.loginOff || !auth.ready}>Log in</button>
          )}
          {owner && view && (
            <button className={policy?.frozen ? 'freeze-btn on' : 'freeze-btn'} disabled={locked || legs.length === 0} title={why ?? (policy?.frozen ? 'Unfreeze: the contract signs again and new agent keys must be approved' : 'Freeze: stop everything the contract signs and revoke every trading key. Withdrawals to you still work.')} onClick={toggleFreeze}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
              <span className="lbl">{busy === 'freeze' ? 'Signing…' : policy?.frozen ? 'Frozen · Unfreeze' : 'Freeze all'}</span>
            </button>
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
          setup={canSign && !dry ? { done: setupCount, total: 5 } : undefined}
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
        <main className={route.tab === 'trade' ? 'wide' : undefined}>
          {attention && (
            <p className={`attention${'dismiss' in attention && attention.dismiss ? ' has-x' : ''}`} role="status">
              <span>{attention.text} <a href={attention.href}>{attention.link}</a></span>
              {'dismiss' in attention && attention.dismiss && (
                <button type="button" className="banner-x" aria-label="Hide the setup reminder" title="Hide this reminder (it stays in your account menu)" onClick={attention.dismiss}>×</button>
              )}
            </p>
          )}

          {route.tab === 'portfolio' && (
            <Panel id="portfolio">
              <nav className="subnav" aria-label="Portfolio">
                <a href="#/portfolio" aria-current={route.rest[0] !== 'legs' ? 'page' : undefined}>Positions and PnL</a>
                <a href="#/portfolio/legs" aria-current={route.rest[0] === 'legs' ? 'page' : undefined}>Legs</a>
              </nav>
              {route.rest[0] === 'legs' ? (
                <>
                  <section className="card wide" aria-labelledby="legs-h">
                    <h2 id="legs-h">Legs</h2>
                    <LegCards view={view} owner={owner} loading={loading} error={error} selected={selLeg} onSelect={setSelLeg} onGo={go} onAddLeg={addLeg} busy={busy} />
                  </section>
                  <LegPanel view={view} demo={demo} leg={selLeg} onLeg={setSelLeg} />
                </>
              ) : (
              <OverviewTab view={view} owner={owner} canSign={canSign} locked={locked} why={why} sign={signCommand} run={run} done={done} onCloseHedge={(c, legs) => hedge(false, c, legs)} onGo={go} />
              )}
            </Panel>
          )}

          {route.tab === 'easy' && (
            <Panel id="easy">
              <StrategiesPanel view="running" legs={legs} owner={owner} canSign={canSign} events={mine} sign={signCommand} tick={view?.snapshot.at} />
              <EasyTab view={view} owner={owner} locked={locked} why={why} sign={signCommand} session={session} run={run} done={done} onGo={go} onStrategy={(text) => setStrategyAsk((a) => ({ text, n: a.n + 1 }))} onStrategyChoose={(family) => setStrategyChoose((c) => ({ family, n: c.n + 1 }))} />
              <StrategiesPanel embedded view="build" choose={strategyChoose} prefill={strategyAsk} legs={legs} owner={owner} canSign={canSign} events={mine} sign={signCommand} tick={view?.snapshot.at} leg={route.params.get('leg') === null ? undefined : Number(route.params.get('leg'))} />
            </Panel>
          )}

          {route.tab === 'trade' && (
            <Panel id="trade">
              <TradeTab
                view={view}
                owner={owner}
                canSign={canSign}
                locked={locked}
                why={why}
                sign={signCommand}
                session={session}
                events={mine}
                run={run}
                done={done}
                onCloseHedge={(c, legs) => hedge(false, c, legs)}
                onGo={go}
                mode={route.params.get('mode') === 'hedge' ? 'hedge' : undefined}
                initial={{
                  ...(route.params.get('leg') !== null ? { leg: Number(route.params.get('leg')) } : {}),
                  ...(route.params.get('coin') ? { coin: route.params.get('coin')! } : {}),
                }}
              />
            </Panel>
          )}

          {route.tab === 'setup' && (
          <Panel id="setup">
            <section className="card" aria-labelledby="setup-h">
              <h2 id="setup-h">Setup · {setupCount} of 5 done</h2>
              {setupHidden && setupCount < 5 && (
                <p className="muted small">The reminder at the top is hidden. <button type="button" className="link" onClick={() => hideSetup(false)}>Show it again</button></p>
              )}
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
                  <span className={setupDone[2] ? 'ok' : 'todo'}>{setupDone[2] ? 'done' : 'to do'}</span>
                  <button disabled={legs.length === 0} onClick={() => go(unfunded[0] ? `fund?leg=${unfunded[0].leg}` : 'fund')}>Open Fund</button>
                </li>
                <li>
                  <div>
                    <strong>4. Approve agent</strong>
                    <p className="muted small">You sign one approval per leg exactly as listed; the contract signs it for Hyperliquid and the service posts it.{approvalBlocked && ' Fund the legs first (step 3).'}</p>
                  </div>
                  <span className={setupDone[3] ? 'ok' : 'todo'}>{setupDone[3] ? 'done' : 'to do'}</span>
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
                  {policyForm()}
                </li>
              </ol>
            </section>

          </Panel>
          )}

          {route.tab === 'protect' && (
          <Panel id="protect">
          <div className="grid">
            <div className="col">
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
              <DecisionCard rows={decisionList} mode={view?.decision?.mode} canSign={canSign} busy={busy} onAccept={acceptDecision} onDecline={declineDecision} onHide={(d) => hide(d.id)} onMode={setMode} onAsk={askProposal} />
            </div>
            <div className="col">
              <section className="card" aria-labelledby="agent-h">
                <h2 id="agent-h">Rebalancing agent</h2>
                <p className="muted small">The NEAR account that may move USDC between your legs when one nears liquidation, with a daily cap and a cooldown the contract enforces.</p>
                {policyForm()}
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
            </div>
          </div>
          </Panel>
          )}

          {route.tab === 'fund' && (
            <Panel id="fund">
              <FundTab view={view} owner={owner} leg={route.params.get('leg') === null ? undefined : Number(route.params.get('leg'))} canSign={canSign} dry={dry} locked={locked} busy={busy} why={why} onGo={go} onMove={moveToTrading} onWithdraw={withdrawLeg} onChanged={() => void refresh()} onRebalance={rebalance} />
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
      {owner && (
        <nav className="bottom-nav" aria-label="Sections">
          {tabDefs.map((t) => (
            <a key={t.id} href={`#/${t.id}`} aria-current={route.tab === t.id ? 'page' : undefined}>
              <NavIcon id={t.id} />
              <span>{t.label}</span>
              {t.dot && <span className="dot" role="img" aria-label={t.dot} />}
            </a>
          ))}
        </nav>
      )}
    </>
  );
}

const ICONS: Record<string, string> = {
  trade: 'M3 3v18h18 M7 15l4-4 3 3 5-6',
  portfolio: 'M3 7h18v13H3z M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2',
  strategies: 'M4 6h16 M4 12h10 M4 18h6',
  fund: 'M12 3v18 M17 7H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  protect: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
function NavIcon({ id }: { id: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(ICONS[id] ?? '').split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
}

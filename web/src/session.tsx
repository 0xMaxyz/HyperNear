// 1-click trading: one wallet signature starts a session whose key lives in this tab (sessionStorage, gone when the tab
// closes); orders and cancels are then signed by that key with no wallet popup. The agent accepts the key only for
// placeOrder / cancelOrder (and placeHedge when ticked), only for this owner, only until expiry, inside its order policy; a freeze ends it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, DEFAULT_SESSION_ACTIONS, newCommand, newSessionSpec, type ChainTag, type Command, type SessionSpec } from './hypernear';
import { currentAgent, post, type OwnerView } from './api';
import { sendSpec, type Sign } from './trading';

interface Stored {
  pk: Hex;
  spec: SessionSpec;
}

const slot = (owner: Hex) => `hypernear.session.${currentAgent()}.${owner.toLowerCase()}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function load(owner: Hex): Stored | undefined {
  try {
    const raw = sessionStorage.getItem(slot(owner));
    const s = raw ? (JSON.parse(raw) as Stored) : undefined;
    return s && s.spec.expiresAt > nowSec() ? s : undefined;
  } catch {
    return undefined;
  }
}
function save(owner: Hex, s: Stored | undefined) {
  try {
    if (s) sessionStorage.setItem(slot(owner), JSON.stringify(s));
    else sessionStorage.removeItem(slot(owner));
  } catch {
    /* storage off: the session still works until this page reloads */
  }
}

export const SESSION_DURATIONS = [
  { sec: 15 * 60, label: '15 min' },
  { sec: 3600, label: '1 hour' },
  { sec: 8 * 3600, label: '8 hours' },
] as const;

export interface SessionApi {
  /** the live session, if this tab holds one the agent still lists */
  spec?: SessionSpec;
  secondsLeft: number;
  /** signs `c` with the session key when the session covers it; otherwise undefined (the wallet signs) */
  signFor: (c: Command) => Promise<Hex> | undefined;
  start: (ttlSec: number, withHedge?: boolean) => Promise<string>;
  end: () => Promise<string>;
}

export function useSession(owner: Hex | undefined, view: OwnerView | undefined, ownerSign: Sign, chainTag: ChainTag, contractId: string): SessionApi {
  const [stored, setStored] = useState<Stored | undefined>(() => (owner ? load(owner) : undefined));
  const [tick, setTick] = useState(0);

  useEffect(() => setStored(owner ? load(owner) : undefined), [owner]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  // the agent is the authority: after a restart, a freeze or endSession elsewhere it no longer lists the key, so drop it here
  useEffect(() => {
    if (!owner || !stored || !view?.sessions) return;
    if (!view.sessions.some((s) => s.key === stored.spec.key) || stored.spec.expiresAt <= nowSec()) {
      save(owner, undefined);
      setStored(undefined);
    }
  }, [owner, stored, view?.sessions, tick]);

  const account = useMemo(() => (stored ? privateKeyToAccount(stored.pk) : undefined), [stored]);
  const live = stored && stored.spec.expiresAt > nowSec() ? stored : undefined;

  const signFor = useCallback(
    (c: Command) => {
      if (!live || !account || !owner || c.owner.toLowerCase() !== owner.toLowerCase()) return undefined;
      if (!(live.spec.actions as string[]).includes(c.action)) return undefined;
      return account.signTypedData(commandTypedData(chainTag, contractId, c) as never);
    },
    [live, account, owner, chainTag, contractId],
  );

  const start = useCallback(
    async (ttlSec: number, withHedge = false) => {
      if (!owner) throw new Error('Log in first');
      const pk = generatePrivateKey();
      // opening a hedge (two legs at once) is never part of the default set: the owner ticks it for this session
      const spec = newSessionSpec(privateKeyToAccount(pk).address, ttlSec, Date.now(), {}, withHedge ? [...DEFAULT_SESSION_ACTIONS, 'placeHedge'] : undefined);
      await sendSpec(ownerSign, owner, 'startSession', '/session/start', spec); // the one wallet signature
      const s = { pk, spec };
      save(owner, s);
      setStored(s);
      return `1-click trading on for ${SESSION_DURATIONS.find((d) => d.sec === ttlSec)?.label ?? `${Math.round(ttlSec / 60)} min`}. Orders and cancels on this tab no longer open your wallet`;
    },
    [owner, ownerSign],
  );

  const end = useCallback(async () => {
    if (!owner || !stored) return '1-click trading is already off';
    save(owner, undefined);
    setStored(undefined);
    // the key ends its own session: no wallet popup. The key is already forgotten here, so a failure leaves it unusable anyway
    const command = newCommand(owner, 'endSession', stored.spec.key);
    const sig = await privateKeyToAccount(stored.pk).signTypedData(commandTypedData(chainTag, contractId, command) as never);
    await post('/session/end', { command, sig }).catch(() => undefined);
    return '1-click trading off';
  }, [owner, stored, chainTag, contractId]);

  return { spec: live?.spec, secondsLeft: live ? live.spec.expiresAt - nowSec() : 0, signFor, start, end };
}

const left = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.max(1, Math.floor(s / 60))} min`);

/** The ticket's footer line: on with time left and Turn off, or off with a duration and Turn on. */
export function SessionControl({ s, run, locked, why }: { s: SessionApi; run: (key: string, fn: () => Promise<string>) => Promise<void>; locked: boolean; why?: string }) {
  const [ttl, setTtl] = useState<number>(3600);
  const [hedge, setHedge] = useState(false);
  if (s.spec) {
    return (
      <div className="session on" role="status">
        <span>1-click trading on · {left(s.secondsLeft)} left{(s.spec.actions as string[]).includes('placeHedge') ? ' · hedges included' : ''}</span>
        <button className="link" onClick={() => run('session', s.end)}>Turn off</button>
      </div>
    );
  }
  return (
    <div className="session">
      <span className="muted">Each order opens your wallet.</span>
      <label className="sr-only" htmlFor="session-ttl">1-click duration</label>
      <select id="session-ttl" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
        {SESSION_DURATIONS.map((d) => <option key={d.sec} value={d.sec}>{d.label}</option>)}
      </select>
      <button disabled={locked} title={why ?? 'One signature now; orders and cancels on this tab are then signed without a popup, inside the agent policy. Freeze ends it.'} onClick={() => run('session', () => s.start(ttl, hedge))}>
        Turn on 1-click
      </button>
      <label className="t-check" title="A hedge opens two positions at once, so it counts both legs against the per-order cap. Off by default."><input type="checkbox" checked={hedge} onChange={(e) => setHedge(e.target.checked)} /> Also allow opening hedges</label>
    </div>
  );
}

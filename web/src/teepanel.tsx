import { useEffect, useState } from 'react';
import type { ChainTag } from '@hypernear/client';
import type { LegSnap } from './api';
import { HASH_RE, inTeeMode, isDevRun, nsToDate, priceMicro, usd, type TeeAgentInfo, type TeeState } from './tee';

/** Placeholder until the Phala verification page of the shipped image exists (T2). */
const VERIFY_URL = (import.meta.env.VITE_TEE_VERIFY_URL as string | undefined) ?? 'https://proof.t16z.com/';
const when = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  state?: TeeState;
  error?: string;
  /** the TEE agent's address is configured (VITE_TEE_AGENT_URL) */
  teeUrl?: string;
  legs: LegSnap[];
  chainTag: ChainTag;
  canSign: boolean;
  busy: string | null;
  why?: string;
  lookup: (account: string) => Promise<TeeAgentInfo | null>;
  onSwitch: (account: string, hash: string) => void;
  onPay: (leg: number, months: number) => void;
  onLeave: () => void;
}

/** What the contract knows about the owner's TEE agent: registered or not, expired or not, and honestly how it was registered. */
function Attestation({ agent, chainTag }: { agent: TeeAgentInfo | null | undefined; chainTag: ChainTag }) {
  if (!agent) return <span className="flag">not registered on the contract (the TEE agent has not booted or registered)</span>;
  const exp = nsToDate(agent.expires_ns);
  const expired = exp.getTime() <= Date.now();
  return (
    <>
      <span className={expired ? 'flag' : 'ok-text'}>{expired ? `expired ${when(exp)}: the agent must register again` : `registered, expires ${when(exp)}`}</span>
      {isDevRun(chainTag) && <span className="muted"> · dev-registered (testnet), no hardware quote</span>}
    </>
  );
}

export function HostingCard(p: Props) {
  const mode = inTeeMode(p.state) ? 'tee' : 'server';
  const [choice, setChoice] = useState<'server' | 'tee'>(mode);
  useEffect(() => setChoice(mode), [mode]);
  const price = p.state?.priceUsd;
  const offered = Boolean(price && p.state?.feeAddress);
  const priceLabel = offered ? `${usd(priceMicro(price!))}/month` : 'not offered';

  return (
    <section className="card wide" aria-labelledby="host-h">
      <h2 id="host-h">Agent hosting</h2>
      {p.error ? (
        <p className="state" role="alert">Could not read your hosting mode from the contract: {p.error}</p>
      ) : !p.state ? (
        <p className="state">Reading your hosting mode from the contract…</p>
      ) : (
        <>
          <fieldset className="mode" disabled={p.busy !== null}>
            <legend>Who holds the trading keys</legend>
            <label className={choice === 'server' ? 'on' : ''}>
              <input type="radio" name="host" checked={choice === 'server'} onChange={() => setChoice('server')} />
              Server (free)
            </label>
            <label className={choice === 'tee' ? 'on' : ''}>
              <input type="radio" name="host" checked={choice === 'tee'} onChange={() => setChoice('tee')} />
              TEE ({priceLabel})
            </label>
          </fieldset>
          {choice === 'server' ? (
            <ServerNote mode={mode} onLeave={p.onLeave} canSign={p.canSign} busy={p.busy} why={p.why} />
          ) : (
            <TeeCard {...p} state={p.state} mode={mode} offered={offered} />
          )}
        </>
      )}
    </section>
  );
}

function ServerNote({ mode, onLeave, canSign, busy, why }: { mode: string; onLeave: () => void; canSign: boolean; busy: string | null; why?: string }) {
  const [sure, setSure] = useState(false);
  return (
    <>
      <p className="muted small">The HyperNear server makes one Hyperliquid trading key per leg and runs the guard. Free. Its operator runs the code, so you trust the operator within the contract and order limits.</p>
      {mode === 'tee' && (
        <div className="leave">
          <p className="flag">You are in TEE mode. Going back to the server revokes the TEE's trading keys on Hyperliquid.</p>
          {sure ? (
            <div className="actions tight">
              <button className="danger" disabled={!canSign || busy !== null} title={why} onClick={onLeave}>{busy === 'tee-leave' ? 'Waiting for signature…' : 'Leave TEE: sign and revoke its keys'}</button>
              <button onClick={() => setSure(false)}>Keep TEE</button>
            </div>
          ) : (
            <button disabled={!canSign || busy !== null} title={why} onClick={() => setSure(true)}>Leave TEE…</button>
          )}
        </div>
      )}
    </>
  );
}

function TeeCard(p: Props & { state: TeeState; mode: 'server' | 'tee'; offered: boolean }) {
  const { state: s } = p;
  const [account, setAccount] = useState('');
  const [hash, setHash] = useState('');
  const [found, setFound] = useState<TeeAgentInfo | null | undefined>();
  const [lookErr, setLookErr] = useState<string>();
  const [leg, setLeg] = useState(0);
  const [months, setMonths] = useState('1');
  const inTee = p.mode === 'tee';
  const rec = s.tee;
  const paidUntil = rec && BigInt(rec.paid_until_ns) > 0n ? nsToDate(rec.paid_until_ns) : null;
  const paidActive = paidUntil ? paidUntil.getTime() > Date.now() : false;
  const m = Number(months);
  const monthsOk = Number.isInteger(m) && m >= 1 && m <= 12;
  const perMonth = s.priceUsd ? priceMicro(s.priceUsd) : 0;
  const total = perMonth * (monthsOk ? m : 0);
  const payLeg = p.legs.find((l) => l.leg === leg) ?? p.legs[0];
  const legFree = payLeg ? Number(payLeg.clearinghouse.withdrawable) + payLeg.spotUsdc : 0;
  const hashOk = HASH_RE.test(hash.trim());

  async function look() {
    setLookErr(undefined);
    setFound(undefined);
    try {
      const a = await p.lookup(account.trim());
      setFound(a);
      if (a) setHash(a.measurement_hash);
    } catch (e) {
      setLookErr((e as Error).message);
    }
  }

  return (
    <div className="tee">
      {!p.offered && <p className="state">This contract does not offer TEE mode (no price or fee address in get_config).</p>}
      <p className="muted small">
        The agent runs inside a trusted execution environment. Its trading keys exist only in its memory, and the contract lets only the instance you name, running the measurement you name, act for you.
      </p>
      <dl className="kv tee-kv">
        <dt>Measurement</dt>
        <dd className="mono">{rec?.measurement_hash ?? 'none: not in TEE mode'}</dd>
        <dt>TEE agent account</dt>
        <dd className="mono">{rec?.agent_account ?? 'none'}</dd>
        <dt>Attestation</dt>
        <dd>{inTee ? <Attestation agent={s.agent} chainTag={p.chainTag} /> : <span className="muted">shown once you are in TEE mode</span>}</dd>
        <dt>Paid until</dt>
        <dd>{paidUntil ? <span className={paidActive ? 'ok-text' : 'flag'}>{paidActive ? when(paidUntil) : `${when(paidUntil)}, ended`}</span> : <span className="muted">not paid yet</span>}</dd>
        <dt>Months paid</dt>
        <dd>{rec?.months_paid ?? 0}</dd>
      </dl>
      <p className="small">
        <a href={VERIFY_URL} target="_blank" rel="noreferrer">Verify the attestation on Phala&apos;s verifier</a>
        <span className="muted">{isDevRun(p.chainTag) ? ' (this testnet agent is dev-registered: there is no hardware quote to verify)' : ''}</span>
      </p>
      {!p.teeUrl && <p className="state">VITE_TEE_AGENT_URL is not set, so this page cannot talk to a TEE agent for setup.</p>}

      {!inTee && (
        <div className="fields">
          <label>
            TEE agent account (printed by the TEE agent when it boots)
            <input value={account} onChange={(e) => { setAccount(e.target.value); setFound(undefined); }} spellCheck={false} placeholder="name.contract.testnet" />
          </label>
          <div className="actions tight">
            <button disabled={!account.trim()} onClick={look}>Look up on the contract</button>
            {found === null && <span className="flag">not registered on the contract</span>}
            {found && <span className="ok-text">registered{isDevRun(p.chainTag) ? ' (dev, no hardware quote)' : ''}; measurement filled in</span>}
            {lookErr && <span className="flag">{lookErr}</span>}
          </div>
          <label>
            Measurement hash you accept (0x and 64 hex)
            <input value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} aria-invalid={hash !== '' && !hashOk} placeholder="0x…" />
          </label>
          <button
            className="primary"
            disabled={!p.canSign || p.busy !== null || !p.offered || !account.trim() || !hashOk}
            title={p.why}
            onClick={() => p.onSwitch(account.trim(), hash.trim().toLowerCase())}
          >
            {p.busy === 'tee-switch' ? 'Waiting for signature…' : 'Switch to TEE: sign'}
          </button>
          <p className="muted small">You sign setTee with exactly this account and measurement. Then pay below and run Prepare agents against the TEE agent.</p>
        </div>
      )}

      {inTee && s.priceUsd && s.feeAddress && (
        <div className="fields pay">
          <strong>Pay for TEE hosting</strong>
          <div className="fields inline">
            <label>
              From leg
              <select value={leg} onChange={(e) => setLeg(Number(e.target.value))}>
                {p.legs.map((l) => (
                  <option key={l.leg} value={l.leg}>Leg {l.leg}</option>
                ))}
              </select>
            </label>
            <label>
              Months, 1 to 12
              <input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" aria-invalid={!monthsOk} />
            </label>
          </div>
          <p className="small" aria-live="polite">
            You pay <strong>{usd(total)}</strong> ({monthsOk ? m : '?'} × {usd(perMonth)}) to <code title={s.feeAddress}>{s.feeAddress}</code>, sent from leg {payLeg?.leg ?? '?'}&apos;s Hyperliquid account
            {payLeg && <span className={legFree < total / 1e6 ? 'flag' : 'muted'}> ({usd(legFree * 1e6)} available there{legFree < total / 1e6 ? ', not enough' : ''})</span>}.
          </p>
          <button className="primary" disabled={!p.canSign || p.busy !== null || !monthsOk || !payLeg} title={p.why} onClick={() => p.onPay(payLeg!.leg, m)}>
            {p.busy === 'tee-pay' ? 'Waiting for signature…' : `Pay ${usd(total)}: sign`}
          </button>
          <p className="muted small">The contract signs a Hyperliquid transfer of this amount from the leg. You sign the price and address shown here, and the contract refuses any other.</p>
        </div>
      )}
      {inTee && <p className="muted small">To go back to the server, choose Server above: leaving revokes the TEE&apos;s trading keys.</p>}
    </div>
  );
}

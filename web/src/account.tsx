import { useEffect, useRef, useState } from 'react';

export interface AuthAccount {
  /** how the owner logged in: passkey, email, or a wallet name */
  method: string;
  email?: string;
  wallets: { address: string; kind: 'embedded' | 'external' }[];
  linkWallet?: () => void;
  /** embedded wallets only */
  exportWallet?: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  owner: string;
  /** a real login, not the recorded-data demo */
  signedIn: boolean;
  account?: AuthAccount;
  network?: string;
  mode: string;
  onLogout: () => void;
  onLogin?: () => void;
  onLeaveDemo?: () => void;
  onGo: (tab: string) => void;
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** A 5x5 mirrored pattern from the address digits, so two owners look different at a glance. Decoration only, not a check. */
function Mark({ addr }: { addr: string }) {
  const hex = addr.toLowerCase().replace(/^0x/, '');
  const cells = Array.from({ length: 15 }, (_, i) => (parseInt(hex[i] ?? '', 16) || 0) >= 8);
  return (
    <svg className="acct-mark" viewBox="-1 -1 7 7" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      {cells.flatMap((on, i) => {
        if (!on) return [];
        const x = i % 3;
        const y = Math.floor(i / 3);
        const r = <rect key={i} x={x} y={y} width={1} height={1} />;
        return x < 2 ? [r, <rect key={`m${i}`} x={4 - x} y={y} width={1} height={1} />] : [r];
      })}
    </svg>
  );
}

export function AccountMenu({ open, onClose, owner, signedIn, account, network, mode, onLogout, onLogin, onLeaveDemo, onGo }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<string>();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? undefined : c)), 1500);
    } catch {
      setCopied(undefined); // clipboard blocked: the full address is selectable in the Account section
    }
  };

  const go = (tab: string) => {
    onClose();
    onGo(tab);
  };

  // Privy mounts its dialogs in a normal body portal. Ours sits in the top layer and makes the page inert, so leave the top layer
  // first and open Privy on the next frame, or its dialog opens behind ours and cannot be used.
  const thenPrivy = (fn: () => void) => () => {
    ref.current?.close();
    onClose();
    requestAnimationFrame(() => fn());
  };

  const wallets: AuthAccount['wallets'] = signedIn && account ? account.wallets : [];
  const linkWallet = signedIn ? account?.linkWallet : undefined;
  const exportWallet = signedIn ? account?.exportWallet : undefined;
  const isOwner = (a: string) => a.toLowerCase() === owner.toLowerCase();
  const canExport = Boolean(exportWallet) && wallets.some((w) => w.kind === 'embedded' && isOwner(w.address));
  const state = mode.startsWith('live') ? 'live' : mode.startsWith('recorded') ? 'recorded' : 'connecting';

  return (
    <dialog ref={ref} className="account acct" aria-labelledby="acct-menu-h" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="acct-body">
        <div className="acct-id">
          <Mark addr={owner} />
          <div className="acct-who">
            <h2 id="acct-menu-h">{signedIn ? 'Your account' : 'Recorded data'}</h2>
            <p className="acct-addr">
              <code title={owner}>
                <span aria-hidden="true">{short(owner)}</span>
                <span className="sr-only">{owner}</span>
              </code>
              <button className="acct-copy" onClick={() => copy(owner)}>
                {copied === owner ? 'Copied' : 'Copy'}
                <span className="sr-only"> owner address</span>
              </button>
            </p>
          </div>
          <button className="acct-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="acct-pills">
          {network ? <span className={`net ${network}`}>Hyperliquid {network}</span> : <span className="pill">Network not connected</span>}
          <span className={`pill acct-state is-${state}`}>
            <span className="dot-s" aria-hidden="true" />
            {state === 'live' ? 'Live' : state === 'recorded' ? 'Recorded data' : 'Connecting…'}
          </span>
          {signedIn && account && <span className="pill">via {account.method}</span>}
        </div>

        <section className="acct-sec" aria-labelledby="acct-account-h">
          <h3 id="acct-account-h">Account</h3>
          <dl className="acct-rows">
            <div>
              <dt>Owner address</dt>
              <dd><code className="acct-full">{owner}</code></dd>
            </div>
            {signedIn && account && (
              <div>
                <dt>Signed in with</dt>
                <dd>{account.email ? `${account.method}, ${account.email}` : account.method}</dd>
              </div>
            )}
            <div>
              <dt>Agent</dt>
              <dd>{mode}</dd>
            </div>
          </dl>
          {!signedIn && <p className="acct-note">This is the recorded demo owner. Log in to use your own account.</p>}
        </section>

        {signedIn && account && (
          <section className="acct-sec" aria-labelledby="acct-wallets-h">
            <h3 id="acct-wallets-h">Wallets</h3>
            <ul className="plain acct-wallets">
              {wallets.map((w) => (
                <li key={w.address}>
                  <code title={w.address}>{w.address.slice(0, 8)}…{w.address.slice(-6)}</code>
                  <span className="acct-badges">
                    <span className="chip">{w.kind === 'embedded' ? 'embedded' : 'external'}</span>
                    {isOwner(w.address) && <span className="chip on">owner</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="acct-note">The owner address stays {owner.slice(0, 6)}… whichever wallet you connect. Extra wallets only send deposits.</p>
          </section>
        )}

        <section className="acct-sec" aria-labelledby="acct-actions-h">
          <h3 id="acct-actions-h">Actions</h3>
          {linkWallet && (
            <div className="acct-action">
              <p id="acct-link-d">Add another wallet to send deposits from.</p>
              <button onClick={thenPrivy(linkWallet)} aria-describedby="acct-link-d">Link a wallet</button>
            </div>
          )}
          {exportWallet && canExport && (
            <div className="acct-action sensitive">
              <p id="acct-export-d"><strong>Sensitive.</strong> Shows the private key of your embedded wallet; anyone who sees it controls this account.</p>
              <button onClick={thenPrivy(exportWallet)} aria-describedby="acct-export-d">Export key</button>
            </div>
          )}
          {exportWallet && (
            <details className="acct-caveat">
              <summary>Passkey or embedded-wallet signing: not yet verified</summary>
              <p>Signing with a passkey or embedded wallet is not yet verified end to end (claim C13). A browser wallet such as MetaMask is the tested path.</p>
            </details>
          )}
          <ul className="plain acct-links">
            <li><button onClick={() => go('fund')}>Fund a leg<span aria-hidden="true">›</span></button></li>
            <li><button onClick={() => go('learn')}>How it works<span aria-hidden="true">›</span></button></li>
          </ul>
        </section>

        <div className="acct-foot">
          {signedIn ? (
            <button className="danger-soft" onClick={onLogout}>Log out</button>
          ) : (
            <>
              {onLeaveDemo && <button onClick={() => (onClose(), onLeaveDemo())}>Leave demo</button>}
              {onLogin && <button className="primary" onClick={onLogin}>Log in</button>}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

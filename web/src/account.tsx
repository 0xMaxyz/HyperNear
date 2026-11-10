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
      setCopied(undefined); // clipboard blocked: the full address is selectable in the dialog
    }
  };

  const go = (tab: string) => {
    onClose();
    onGo(tab);
  };

  return (
    <dialog ref={ref} className="account" aria-labelledby="acct-h" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="acct-body">
        <div className="acct-head">
          <h2 id="acct-h">{signedIn ? 'Your account' : 'Recorded data'}</h2>
          <button onClick={onClose} aria-label="Close">×</button>
        </div>

        <dl className="kv acct-kv">
          <dt>Owner address</dt>
          <dd className="addr-full">
            <code>{owner}</code>
            <button className="small-btn" onClick={() => copy(owner)}>{copied === owner ? 'Copied' : 'Copy'}</button>
          </dd>
          {signedIn && account && (
            <>
              <dt>Signed in with</dt>
              <dd>{account.email ? `${account.method}, ${account.email}` : account.method}</dd>
            </>
          )}
          <dt>Network</dt>
          <dd>{network ? `Hyperliquid ${network}` : 'not connected'}</dd>
          <dt>Agent</dt>
          <dd>{mode}</dd>
        </dl>

        {!signedIn && <p className="muted small">This is the recorded demo owner. Log in to use your own account.</p>}

        {signedIn && account && (
          <section aria-labelledby="acct-wallets-h">
            <h3 id="acct-wallets-h">Wallets</h3>
            <ul className="plain">
              {account.wallets.map((w) => (
                <li key={w.address}>
                  <code>{w.address.slice(0, 8)}…{w.address.slice(-6)}</code> <span className="chip">{w.kind === 'embedded' ? 'embedded' : 'external'}</span>
                  {w.address.toLowerCase() === owner.toLowerCase() && <span className="chip on">owner</span>}
                </li>
              ))}
            </ul>
            <p className="muted small">Your owner address stays {owner.slice(0, 6)}… whichever wallet you connect. Extra wallets are only used to send deposits.</p>
            <div className="actions tight">
              {account.linkWallet && <button onClick={account.linkWallet}>Link a wallet</button>}
              {account.exportWallet && account.wallets.some((w) => w.kind === 'embedded' && w.address.toLowerCase() === owner.toLowerCase()) && (
                <button onClick={account.exportWallet}>Export key</button>
              )}
            </div>
            {account.exportWallet && <p className="muted small">Signing with a passkey or embedded wallet is not yet verified end to end (claim C13). A browser wallet such as MetaMask is the tested path.</p>}
          </section>
        )}

        <div className="actions tight acct-links">
          <button onClick={() => go('fund')}>Fund a leg</button>
          <button onClick={() => go('learn')}>How it works</button>
        </div>

        <div className="acct-foot">
          {signedIn ? (
            <button className="danger-soft" onClick={onLogout}>Log out</button>
          ) : (
            <>
              {onLogin && <button className="primary" onClick={onLogin}>Log in</button>}
              {onLeaveDemo && <button onClick={() => (onClose(), onLeaveDemo())}>Leave demo</button>}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

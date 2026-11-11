import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useSignTypedData, useWallets } from '@privy-io/react-auth';
import type { Hex } from 'viem';
import { HYPERNEAR_DOMAIN_TYPE, type OwnerIntentTypedData } from '@hypernear/client';
import { App, type Auth } from './App';
import type { AuthAccount } from './account';
import './styles.css';

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** localStorage read, or write when a value is given; blocked storage (private windows) just means no pin. */
function store(key: string, value?: string): string | undefined {
  try {
    if (value === undefined) return localStorage.getItem(key) ?? undefined;
    localStorage.setItem(key, value);
  } catch {
    /* no storage: the owner is then whatever Privy lists first */
  }
  return value;
}

/** Signs typed data with the logged-in wallet: Privy's hook first, then the raw provider; both errors if both fail. */
function WithPrivy() {
  const privy = usePrivy();
  const { ready, authenticated, login, logout, user } = privy;
  // linkWallet and exportWallet exist on the Privy hook; typed loosely so a version rename only costs the menu entry
  const extra = privy as unknown as { linkWallet?: () => void; exportWallet?: () => Promise<unknown> };
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  // The owner is the first wallet this browser saw for this user. Linking another wallet for deposits must never change it.
  const pinKey = user ? `hypernear-owner:${user.id}` : undefined;
  const pinned = pinKey ? store(pinKey) : undefined;
  const primary = (pinned ?? user?.wallet?.address)?.toLowerCase();
  const wallet = pinned ? wallets.find((w) => w.address.toLowerCase() === primary) : (wallets.find((w) => w.address.toLowerCase() === primary) ?? wallets[0]);
  useEffect(() => {
    if (pinKey && !pinned && wallet) store(pinKey, wallet.address.toLowerCase());
  }, [pinKey, pinned, wallet]);
  const linked = (user?.linkedAccounts ?? []) as unknown as { type: string; address?: string; walletClientType?: string }[];
  const account: AuthAccount = {
    method: linked.find((a) => a.type === 'passkey') ? 'passkey' : linked.find((a) => a.type === 'email') ? 'email' : (linked.find((a) => a.type === 'wallet' && a.walletClientType !== 'privy')?.walletClientType ?? 'wallet'),
    email: linked.find((a) => a.type === 'email')?.address,
    wallets: wallets.map((w) => ({ address: w.address, kind: w.walletClientType === 'privy' ? 'embedded' : 'external' })),
    linkWallet: extra.linkWallet,
    exportWallet: extra.exportWallet && (() => void extra.exportWallet!()),
  };
  const auth: Auth = {
    ready,
    authenticated,
    address: authenticated && wallet ? (wallet.address.toLowerCase() as Hex) : undefined,
    account,
    login,
    logout,
    sign: async (td: OwnerIntentTypedData) => {
      if (!wallet) throw new Error('No wallet connected.');
      try {
        const { signature } = await signTypedData(
          { domain: td.domain as never, types: td.types as never, primaryType: td.primaryType, message: td.message },
          { address: wallet.address }
        );
        return signature as Hex;
      } catch (b) {
        try {
          const provider = await wallet.getEthereumProvider();
          const payload = { domain: td.domain, types: { EIP712Domain: HYPERNEAR_DOMAIN_TYPE, ...td.types }, primaryType: td.primaryType, message: td.message };
          return (await provider.request({ method: 'eth_signTypedData_v4', params: [wallet.address, JSON.stringify(payload)] })) as Hex;
        } catch (a) {
          throw new Error(`Signing failed. Privy signTypedData: ${msg(b)}. Wallet provider: ${msg(a)}`);
        }
      }
    },
  };
  return <App auth={auth} />;
}

const noPrivy: Auth = {
  ready: true,
  authenticated: false,
  login: () => undefined,
  logout: () => undefined,
  sign: async () => {
    throw new Error('Login is off: VITE_PRIVY_APP_ID is not set.');
  },
  loginOff: true,
};

/** Whether the page is dark: a forced data-theme wins, otherwise the system setting. Re-reads when either changes. */
function useDark() {
  const read = () => {
    const forced = document.documentElement.dataset.theme;
    return forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(read());
    mq.addEventListener('change', on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', on);
      mo.disconnect();
    };
  }, []);
  return dark;
}

/**
 * Privy's modal defaults to a light theme. The hex theme and accent mirror our --surface and --ink tokens (Privy needs literal hex,
 * not CSS variables); styles.css then pins the modal's own variables to the live tokens, so the colours also follow a theme change
 * without a re-render.
 */
function ThemedPrivy({ appId }: { appId: string }) {
  const dark = useDark();
  const config = useMemo(
    () => ({
      loginMethods: ['passkey', 'email', 'wallet'] as ('passkey' | 'email' | 'wallet')[],
      embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' as const } },
      appearance: {
        walletChainType: 'ethereum-only' as const,
        theme: (dark ? '#1d1c16' : '#fbfaf6') as `#${string}`,
        accentColor: (dark ? '#ece8dc' : '#1b1a17') as `#${string}`,
        landingHeader: 'Log in to HyperNear',
      },
    }),
    [dark],
  );
  return (
    <PrivyProvider appId={appId} config={config}>
      <WithPrivy />
    </PrivyProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{APP_ID ? <ThemedPrivy appId={APP_ID} /> : <App auth={noPrivy} />}</StrictMode>
);

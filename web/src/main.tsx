import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useSignTypedData, useWallets } from '@privy-io/react-auth';
import type { Hex } from 'viem';
import { HYPERNEAR_DOMAIN_TYPE, type OwnerIntentTypedData } from '@hypernear/client';
import { App, type Auth } from './App';
import './styles.css';

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Signs typed data with the logged-in wallet: Privy's hook first, then the raw provider; both errors if both fail. */
function WithPrivy() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const primary = user?.wallet?.address?.toLowerCase();
  const wallet = wallets.find((w) => w.address.toLowerCase() === primary) ?? wallets[0];
  const auth: Auth = {
    ready,
    authenticated,
    address: authenticated && wallet ? (wallet.address.toLowerCase() as Hex) : undefined,
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {APP_ID ? (
      <PrivyProvider
        appId={APP_ID}
        config={{
          loginMethods: ['passkey', 'email', 'wallet'],
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          appearance: { walletChainType: 'ethereum-only' },
        }}
      >
        <WithPrivy />
      </PrivyProvider>
    ) : (
      <App auth={noPrivy} />
    )}
  </StrictMode>
);

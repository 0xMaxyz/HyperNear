// C13: does Privy sign the HyperNear owner intent (EIP-712, domain {name, version, salt}, no chainId), and does viem recover the logged-in address?
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useSignTypedData, useWallets, type ConnectedWallet } from '@privy-io/react-auth';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { HYPERNEAR_DOMAIN_TYPE, ownerIntentTypedData } from '@hypernear/client';

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const CONTRACT_ID = (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? 'leash-spike-1107.testnet';

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function typedDataFor(owner: Hex) {
  return ownerIntentTypedData({ chainTag: 'near-testnet', contractId: CONTRACT_ID, owner, nonce: 0, intent: { type: 'freeze', frozen: false } });
}

async function check(label: string, owner: Hex, td: ReturnType<typeof typedDataFor>, sign: () => Promise<Hex>) {
  try {
    const signature = await sign();
    const recovered = await recoverTypedDataAddress({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message, signature });
    const ok = recovered.toLowerCase() === owner.toLowerCase();
    return `${ok ? 'PASS' : 'FAIL'} ${label}: recovered ${recovered}, expected ${owner}`;
  } catch (e) {
    return `FAIL ${label}: ${(e as Error).message}`;
  }
}

function Page() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (s: string) => setLines((l) => [...l, s]);

  async function run(w: ConnectedWallet) {
    setBusy(true);
    const owner = w.address.toLowerCase() as Hex;
    const td = typedDataFor(owner);
    add(`--- ${w.walletClientType} (${w.address}), wallet chainId ${w.chainId}`);
    add(`domain ${JSON.stringify(td.domain)}`);
    // A: raw EIP-1193 eth_signTypedData_v4, works for the embedded wallet and external ones
    add(
      await check('A eth_signTypedData_v4 via wallet provider', owner, td, async () => {
        const provider = await w.getEthereumProvider();
        const payload = { domain: td.domain, types: { EIP712Domain: HYPERNEAR_DOMAIN_TYPE, ...td.types }, primaryType: td.primaryType, message: td.message };
        return (await provider.request({ method: 'eth_signTypedData_v4', params: [w.address, JSON.stringify(payload, bigintSafe)] })) as Hex;
      })
    );
    // B: Privy's hook (embedded wallet only)
    if (w.walletClientType === 'privy') {
      add(
        await check('B useSignTypedData (Privy hook)', owner, td, async () => {
          const { signature } = await signTypedData({ domain: td.domain as never, types: td.types as never, primaryType: td.primaryType, message: td.message }, { address: w.address });
          return signature as Hex;
        })
      );
    }
    setBusy(false);
  }

  async function selfTest() {
    const acct = privateKeyToAccount(generatePrivateKey());
    const td = typedDataFor(acct.address.toLowerCase() as Hex);
    add(await check('self-test local key', acct.address, td, () => acct.signTypedData({ domain: td.domain as never, types: td.types, primaryType: td.primaryType, message: td.message } as never)));
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 16px' }}>
      <h1>HyperNear C13: Privy signTypedData check</h1>
      <p>Contract id <code>{CONTRACT_ID}</code>, intent <code>freeze(false)</code>, nonce 0.</p>
      <button onClick={selfTest}>Self-test (local key, no Privy)</button>{' '}
      {!ready ? <span>Privy loading</span> : authenticated ? <button onClick={logout}>Log out</button> : <button onClick={login}>Log in with Privy</button>}
      {authenticated && (
        <section>
          <p>User {user?.id}. {wallets.length} wallet(s) connected:</p>
          <ul>
            {wallets.map((w) => (
              <li key={w.address}>
                {w.walletClientType} {w.address}{' '}
                <button disabled={busy} onClick={() => run(w)}>Sign sample intent</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <pre id="c13-out" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{lines.join('\n')}</pre>
    </main>
  );
}

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
        <Page />
      </PrivyProvider>
    ) : (
      <p>Set VITE_PRIVY_APP_ID.</p>
    )}
  </StrictMode>
);

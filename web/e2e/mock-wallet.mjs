// A mock MetaMask (EIP-1193 + EIP-6963) backed by a throwaway key, injected into a Playwright page.
export async function installMockWallet(page, acct) {
    await page.exposeFunction('__sign', async (method, params) => {
      if (method === 'personal_sign') return acct.signMessage({ message: { raw: params[0] } });
      if (method === 'eth_signTypedData_v4') {
        const t = JSON.parse(params[1]);
        const { EIP712Domain, ...types } = t.types;
        return acct.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
      }
      throw new Error(`mock wallet: unsupported ${method}`);
    });
    await page.addInitScript((address) => {
      const provider = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
          if (method === 'eth_chainId') return '0x1';
          if (method === 'net_version') return '1';
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_requestPermissions') return null;
          return window.__sign(method, params);
        },
        on() {}, removeListener() {},
      };
      window.ethereum = provider;
      const info = { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'MetaMask', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.metamask' };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    }, acct.address);
}

// Headless probe for the C13 page: self-test, Privy init, and a mock MetaMask (EIP-1193 + EIP-6963) backed by a throwaway key.
import { chromium } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const url = process.env.C13_URL ?? 'http://localhost:5173/c13.html';
const mock = process.argv.includes('--mock-wallet');
const acct = privateKeyToAccount(generatePrivateKey());
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const log = [];
const seen = new Set();
page.on('console', (m) => {
  const s = `console.${m.type()}: ${m.text().slice(0, 300)}`;
  if (!seen.has(s)) { seen.add(s); log.push(s); }
});
page.on('pageerror', (e) => log.push(`pageerror: ${e.message.slice(0, 300)}`));
page.on('response', (r) => { if (/privy\.io/.test(r.url()) && r.status() >= 400) log.push(`http ${r.status()} ${r.url().slice(0, 120)}`); });

if (mock) {
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

await page.goto(url);
await page.waitForTimeout(8000); // first load triggers Vite dep optimisation and a reload
await page.reload();
await page.getByRole('button', { name: /Self-test/ }).click();
console.log('self-test:', (await page.locator('#c13-out').innerText()).trim());
await page.getByRole('button', { name: /Log in with Privy/ }).click({ timeout: 20000 }).catch((e) => log.push(`login button: ${e.message.slice(0, 120)}`));
await page.waitForTimeout(4000);
await page.screenshot({ path: 'test-results/c13-login.png' });
if (mock) {
  await page.getByText('Continue with a wallet').click({ timeout: 10000 }).catch((e) => log.push(`click wallet: ${e.message.slice(0, 120)}`));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-results/c13-wallets.png' });
  await page.getByText('MetaMask', { exact: false }).first().click({ timeout: 10000 }).catch((e) => log.push(`click MetaMask: ${e.message.slice(0, 120)}`));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/c13-after-wallet.png' });
  const btn = page.getByRole('button', { name: /Sign sample intent/ });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(5000);
    console.log('mock wallet result:\n' + (await page.locator('#c13-out').innerText()));
  }
}
console.log('--- log\n' + log.join('\n'));
await browser.close();

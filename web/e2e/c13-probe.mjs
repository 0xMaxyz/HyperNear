// Headless probe for the C13 page: self-test, Privy init, and a mock MetaMask (EIP-1193 + EIP-6963) backed by a throwaway key.
import { chromium } from '@playwright/test';
import { installMockWallet } from './mock-wallet.mjs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const url = process.env.C13_URL ?? 'http://localhost:5173/c13.html';
const mock = process.argv.includes('--mock-wallet');
const email = process.argv.includes('--email'); // Privy dashboard test account: test-NNNN@privy.io, one-time code 123456
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

if (mock) await installMockWallet(page, acct);

await page.goto(url);
await page.waitForTimeout(8000); // first load triggers Vite dep optimisation and a reload
await page.reload();
await page.getByRole('button', { name: /Self-test/ }).click();
console.log('self-test:', (await page.locator('#c13-out').innerText()).trim());
await page.getByRole('button', { name: /Log in with Privy/ }).click({ timeout: 20000 }).catch((e) => log.push(`login button: ${e.message.slice(0, 120)}`));
await page.waitForTimeout(4000);
await page.screenshot({ path: 'test-results/c13-login.png' });
if (email) {
  const addr = `test-${Math.floor(1000 + Math.random() * 9000)}@privy.io`;
  await page.getByPlaceholder('your@email.com').fill(addr);
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/c13-otp.png' });
  await page.locator('input').first().click();
  await page.keyboard.type('123456', { delay: 100 });
  await page.waitForTimeout(12000);
  await page.screenshot({ path: 'test-results/c13-after-email.png' });
  for (const b of await page.getByRole('button', { name: /Sign sample intent/ }).all()) {
    await b.click();
    await page.waitForTimeout(6000);
  }
  console.log('email result:\n' + (await page.locator('#c13-out').innerText()));
}
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

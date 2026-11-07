// Screenshots and a click-through of the D5 page. Needs `vite` on http://localhost:5173 built with
// VITE_AGENT_URL=http://localhost:8787 (the Privy-allowed origin), then starts mock agents itself, one per scenario.
// Output: screenshots/*.png and a PASS/FAIL line per check on stdout.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';

const PAGE = 'http://localhost:5173/';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

async function withAgent(fixture, fn) {
  const p = spawn('node', ['e2e/mock-agent.mjs'], { env: { ...process.env, MOCK_FIXTURE: fixture }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { p.stdout.once('data', res); p.once('exit', (c) => rej(new Error(`mock agent exited early (${c})`))); });
  try { await fn(); } finally { p.kill(); await new Promise((r) => setTimeout(r, 300)); }
}

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/403|422|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(PAGE);
  await page.waitForTimeout(5000); // first load: Vite dep optimisation reloads once
  await page.reload();
  return { page, errors, ctx };
}
const shot = (page, name, full = true) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
const demo = async (page) => { await page.getByRole('button', { name: 'Explore recorded data' }).click(); await page.waitForTimeout(3500); };

// 1. logged out, and agent unreachable (no mock running)
{
  const { page, errors, ctx } = await open();
  await shot(page, '01-intro');
  check('intro renders with login and demo buttons', (await page.getByRole('button', { name: /Log in with/ }).count()) === 1 && (await page.getByRole('button', { name: 'Explore recorded data' }).count()) === 1);
  await demo(page);
  check('agent down shows an error state', await page.getByText(/Cannot reach the agent/).first().isVisible());
  await shot(page, '02-agent-down');
  check('no page errors (intro, agent down)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// 2. recorded data: hedged (light desktop, mobile, dark), guard-triggering fixture, empty owner
await withAgent('hedged', async () => {
  const { page, errors, ctx } = await open();
  await demo(page);
  check('dry-run badge shown', await page.getByText('dry-run data').isVisible());
  check('legs table lists both legs', (await page.locator('tbody tr').count()) >= 2);
  check('break-even card has a price', await page.locator('.kv dd.big').first().isVisible());
  check('event log shows guard events', (await page.locator('.log li').count()) >= 3);
  check('signing buttons are disabled when only viewing', await page.getByRole('button', { name: 'Open hedge' }).isDisabled());
  await shot(page, '03-hedged-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, '04-hedged-mobile');
  check('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('no page errors (hedged)', errors.length === 0, errors.join(' | '));
  await ctx.close();
  const d = await open({ colorScheme: 'dark' });
  await demo(d.page);
  await shot(d.page, '05-hedged-dark');
  await d.ctx.close();
});
await withAgent('near-liquidation', async () => {
  const { page, ctx } = await open();
  await demo(page);
  await shot(page, '06-guard-trigger');
  check('guard trigger is flagged on a leg', (await page.locator('td .flag').count()) >= 1);
  await ctx.close();
});

// 3. real Privy login with a mock MetaMask, then every signing action against a mock agent that verifies the signatures
await withAgent('empty', async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const { ctx, page } = await (async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await installMockWallet(page, acct);
    await page.goto(PAGE);
    await page.waitForTimeout(5000);
    await page.reload();
    return { ctx, page };
  })();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Create legs/).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(1500);
  check('logged in with the wallet address', (await page.locator('.who .addr').innerText()).toLowerCase().startsWith(acct.address.toLowerCase().slice(0, 6)));
  await shot(page, '07-logged-in-empty');
  const notice = () => page.locator('.notice').first().innerText().catch(() => '');
  const act = async (name, expect) => {
    await page.getByRole('button', { name }).click();
    await page.locator('.notice').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    const t = await notice();
    check(`${name}: ${expect.test(t) ? 'ok' : 'unexpected'}`, expect.test(t), t.slice(0, 160));
  };
  await act('Create legs', /Registered legs 0 and 1/);
  await act('Enable agent', /enabled/);
  await act('Freeze', /frozen/);
  await act('Unfreeze', /unfrozen/);
  await act('Open hedge', /Hedge on BTC opened/);
  await act('Close hedge', /Hedge on BTC closed/);
  await shot(page, '08-signed-flow');
  check('no page errors (signed flow)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');

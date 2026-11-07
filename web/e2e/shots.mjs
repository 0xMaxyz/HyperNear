// Screenshots and a click-through of the D5 page against the REAL agent in `--dry-run --serve` (no keys, recorded fixtures).
// Needs `vite` on http://localhost:5173 (the Privy-allowed origin) and the workspace packages built. Run from web/.
// Output: screenshots/*.png and a PASS/FAIL line per check on stdout.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';

const PAGE = 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

async function withAgent(fixture, fn) {
  const p = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: fixture, PORT: '8787' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { p.stdout.once('data', res); p.once('exit', (c) => rej(new Error(`agent exited early (${c})`))); });
  try { await fn(); } finally { p.kill(); await new Promise((r) => setTimeout(r, 300)); }
}

async function open({ wallet, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  if (wallet) await installMockWallet(page, wallet);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/403|422|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(PAGE);
  await page.waitForTimeout(5000); // first load: Vite dep optimisation reloads once
  await page.reload();
  return { page, errors, ctx };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const demo = async (page, ms = 3500) => { await page.getByRole('button', { name: 'Explore recorded data' }).click(); await page.waitForTimeout(ms); };

// 1. logged out, and agent unreachable (no agent running)
{
  const { page, errors, ctx } = await open();
  await shot(page, '01-intro');
  check('intro renders with login and demo buttons', (await page.getByRole('button', { name: /Log in with/ }).count()) === 1 && (await page.getByRole('button', { name: 'Explore recorded data' }).count()) === 1);
  await page.getByRole('button', { name: 'Explore recorded data' }).click();
  await page.getByText(/Cannot reach the agent/).first().waitFor({ timeout: 15000 }).catch(() => {});
  check('agent down shows an error state', await page.getByText(/Cannot reach the agent/).first().isVisible());
  await shot(page, '02-agent-down');
  check('no page errors (intro, agent down)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// 2. recorded data from the real dry-run agent: hedged fixture, with its scripted guard replay (about 22 s)
await withAgent('hedged', async () => {
  const { page, errors, ctx } = await open();
  await demo(page, 26000);
  check('dry-run badge shown', await page.getByText('dry-run data').isVisible());
  check('legs table lists the three legs with roles', (await page.locator('tbody tr').count()) === 3 && (await page.getByText('reserve, source for the guard').count()) === 1);
  check('break-even card shows a price from the agent', /\$7\d,\d{3}/.test(await page.locator('.kv dd.big').first().innerText()), await page.locator('.kv dd.big').first().innerText());
  check('guard replay reached the log', (await page.locator('.log li .tag', { hasText: 'guard.rebalance.posted' }).count()) >= 1);
  check('signing buttons are disabled when only viewing', await page.getByRole('button', { name: 'Open hedge' }).isDisabled());
  check('freeze copy mentions revoked trading keys', (await page.getByText(/revokes the agents' Hyperliquid trading keys/).count()) === 1);
  await shot(page, '03-hedged-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, '04-hedged-mobile');
  check('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await shot(page, '05-hedged-dark');
  check('no page errors (hedged)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});
await withAgent('near-liquidation', async () => {
  const { page, ctx } = await open();
  await demo(page);
  await shot(page, '06-guard-trigger');
  check('guard trigger is flagged on a leg', (await page.locator('td .flag').count()) >= 1);
  await ctx.close();
});

// 3. decision proposal and freeze revocation: the agent does not emit these in dry-run yet, so the SSE body is injected
//    here in the shape agreed with contract-dev. Everything else on the page is the real dry-run agent.
await withAgent('hedged', async () => {
  const { page, ctx } = await open();
  const owner = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  const now = Date.now();
  const frames = [
    { id: 1, at: now - 9000, type: 'guard.ok', data: { owner, legs: ['leg0:BTC', 'leg1:BTC'] } },
    { id: 2, at: now - 5000, type: 'agents.revoked', data: { owner, legs: [0, 1, 2].map((leg) => ({ leg, name: `leash-leg${leg}`, ok: true })) } },
    {
      id: 3, at: now - 2000, type: 'decision.proposed',
      data: { owner, id: 'd-1', action: 'reduce_hedge', coin: 'BTC', ratio: '0.25', source: 'less_risky_of_two', flagged: true, latencyMs: 2400,
        factors: { hedgeNeeded: 0.62, fundingMaterial: 0.93, nearLiquidation: 0.04, inProfit: 0.11, volatile: 0.55 },
        rationale: 'Funding on the short leg costs more than the hedge protects at the current distance to liquidation, so shrinking the hedge by a quarter is the smaller change.' },
    },
  ];
  await page.route('**/events', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: frames.map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') }));
  await demo(page, 4000);
  check('decision panel shows action, source, factors and rationale', (await page.getByText('Jev and Claude disagreed').count()) === 1 && (await page.locator('.probs li').count()) === 5 && (await page.locator('.rationale').count()) === 1);
  check('revoked event is in the log', (await page.locator('.log li', { hasText: 'trading keys revoked on Hyperliquid: 3 of 3' }).count()) === 1);
  check('Accept is disabled when only viewing', await page.getByRole('button', { name: /Accept and sign/ }).isDisabled());
  await page.getByRole('button', { name: 'Dismiss' }).click();
  check('Dismiss clears the proposal', (await page.getByText(/No proposal waiting/).count()) === 1);
  await page.reload();
  await demo(page, 4000);
  await shot(page, '07-decision-and-revoked');
  await ctx.close();
});

// 4. real Privy login with a mock MetaMask; the owner is not in the fixtures, so legs are empty and hedge commands are
//    refused after their signature is verified (an unverified signature would be a 401 "bad signature", not "opted")
await withAgent('hedged', async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const { page, ctx, errors } = await open({ wallet });
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Create legs/).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(1500);
  check('logged in with the wallet address', (await page.locator('.who .addr').innerText()).toLowerCase().startsWith(wallet.address.toLowerCase().slice(0, 6)));
  check('empty state names the next step', (await page.getByText(/No legs registered for this owner/).count()) === 1);
  await shot(page, '08-logged-in-empty');
  const act = async (name, expect) => {
    await page.getByRole('button', { name }).click();
    await page.locator('.notice').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    const t = await page.locator('.notice').first().innerText();
    check(`${name}: ${t.slice(0, 110)}`, expect.test(t));
  };
  await act('Create legs', /Registered legs 0 and 1 \(simulated/);
  await act('Open hedge', /not opted/);
  await act('Close hedge', /not opted/);
  await shot(page, '09-signed-command-refused');
  check('no page errors (signed flow)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');

// Screenshots and a click-through of the D5 page against the REAL agent in `--dry-run --serve` (no keys, recorded fixtures).
// Needs `vite` on http://localhost:5173 (the Privy-allowed origin) and the workspace packages built. Run from web/.
// Output: screenshots/*.png and a PASS/FAIL line per check on stdout.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// 2. recorded data from the real dry-run agent: hedged fixture, with its scripted replay: guard demo, then 5 recorded proposals (23 to 33 s after connect), then agents.revoked (about 35 s)
await withAgent('hedged', async () => {
  const { page, errors, ctx } = await open();
  await demo(page, 42000);
  check('dry-run badge shown', await page.getByText('dry-run data').isVisible());
  check('legs table lists the three legs with roles', (await page.locator('tbody tr').count()) === 3 && (await page.getByText('reserve, source for the guard').count()) === 1);
  check('break-even card shows a price from the agent', /\$7\d,\d{3}/.test(await page.locator('.kv dd.big').first().innerText()), await page.locator('.kv dd.big').first().innerText());
  const proposals = await page.locator('.log li .tag', { hasText: 'decision.proposed' }).count();
  check('5 recorded proposals reached the log', proposals === 5, String(proposals));
  check('decision panel shows action, source, model, five factors and a rationale', (await page.locator('section[aria-labelledby=dec-h] .big-action').count()) === 1 && (await page.locator('.probs li').count()) === 5 && (await page.locator('.rationale').count()) === 1 && (await page.locator('section[aria-labelledby=dec-h] dt', { hasText: 'Model' }).count()) === 1);
  check('agents.revoked reached the log', (await page.locator('.log li', { hasText: 'trading keys revoked on Hyperliquid' }).count()) === 1);
  check('Accept and Dismiss are disabled when only viewing', (await page.getByRole('button', { name: /Accept and sign/ }).isDisabled()) && (await page.getByRole('button', { name: 'Dismiss' }).isDisabled()));
  await page.getByRole('button', { name: 'Ask for a proposal' }).click();
  await page.waitForTimeout(2500);
  check('Ask for a proposal adds a proposal to the log', (await page.locator('.log li .tag', { hasText: 'decision.proposed' }).count()) === 6);
  check('guard replay reached the log', (await page.locator('.log li .tag', { hasText: 'guard.rebalance.posted' }).count()) >= 1);
  check('signing buttons are disabled when only viewing', await page.getByRole('button', { name: 'Open hedge' }).isDisabled());
  check('freeze copy mentions revoked trading keys', (await page.getByText(/revokes the agents' Hyperliquid trading keys/).count()) === 1);
  await shot(page, '03-hedged-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, '04-hedged-mobile');
  const wide = await page.evaluate(() => {
    const vw = window.innerWidth;
    const rows = [...document.querySelectorAll('html, body, body *')].map((el) => ({ el, r: el.getBoundingClientRect(), sw: el.scrollWidth, cw: el.clientWidth }));
    const out = rows.filter((x) => x.r.right > vw + 1 || x.sw > x.cw + 1).slice(0, 6).map((x) => `${x.el.tagName}.${x.el.className} right=${Math.round(x.r.right)} sw=${x.sw} cw=${x.cw}`);
    return `innerWidth=${vw} docScroll=${document.documentElement.scrollWidth}; ${out.join(' ; ')}`;
  });
  check('no horizontal overflow at 390px', (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), wide);
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

// 2b. the real proposal from the live models (agent/results/decision-live.json: source disagree, flagged, claude-opus-5-5),
//     fed to the page as one decision.proposed event, to check that a flagged disagreement reads clearly
await withAgent('hedged', async () => {
  const live = JSON.parse(readFileSync(new URL('../../agent/results/decision-live.json', import.meta.url), 'utf8')).proposed;
  const { page, ctx } = await open();
  const frame = { id: 1, at: Date.now() - 3000, type: 'decision.proposed', data: live };
  await page.route('**/events', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: `id: 1
event: decision.proposed
data: ${JSON.stringify(frame)}

` }));
  await demo(page, 4000);
  const panel = page.locator('section[aria-labelledby=dec-h]');
  check('live flagged disagreement: action, source, model and look-twice are shown', /hold/i.test(await panel.locator('.big-action').innerText()) && (await panel.getByText(/disagreed/).count()) === 1 && (await panel.getByText(live.model).count()) >= 1 && (await panel.getByText(/look twice/).count()) === 1);
  await shot(page, '07-decision-live-flagged');
  await ctx.close();
});

// 3. real Privy login with a mock MetaMask; the owner is not in the fixtures, so legs are empty and hedge commands are
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
  await page.locator('fieldset.mode label', { hasText: 'Off' }).click();
  await page.locator('.notice').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const modeNote = await page.locator('.notice').first().innerText();
  check(`autonomy Off (signed command): ${modeNote.slice(0, 80)}`, /Autonomy set to off/.test(modeNote));
  await page.locator('fieldset.mode label', { hasText: 'Auto' }).click();
  await page.waitForTimeout(2500);
  const autoNote = await page.locator('.notice').first().innerText();
  check(`autonomy Auto is refused for an owner that has not opted in: ${autoNote.slice(0, 80)}`, /not opted/.test(autoNote));
  await act('Open hedge', /not opted/);
  await act('Close hedge', /not opted/);
  await shot(page, '09-signed-command-refused');
  check('no page errors (signed flow)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');

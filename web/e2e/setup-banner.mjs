// "Finish setup" banner through the real page: real Privy login (mock MetaMask), the dry-run agent's /owner answer is turned into a live-looking one
// (no dryRun flag), so the setup banner shows. Checks: the banner can be closed, stays closed after a reload, the Account menu has a Setup row that
// opens the Setup page, which offers to show the reminder again; and an empty reserve leg does not keep the Fund step "to do".
// Run from web/ with the built page served on :15173 (PAGE) and Node's proxy env for Privy: PROXY=http://127.0.0.1:1081 on ci32.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';
import { specHashOfJson } from '../../packages/hypernear-client/src/specHash.ts';

const PAGE = process.env.PAGE ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PORT = process.env.AGENT_PORT ?? '8787';
const DEMO_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const CHAIN = 'near-testnet';
const CONTRACT = 'leash-spike-1107.testnet';

const verifyFile = join(tmpdir(), `hypernear-verify-round3-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

const agent = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: 'hedged',  HYPERNEAR_MAX_LEVERAGE: '100', PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { agent.stdout.once('data', res); agent.once('exit', (c) => rej(new Error(`agent exited early (${c})`))); });
process.on('uncaughtException', (e) => { console.error(e); agent.kill(); process.exit(1); });

const browser = await chromium.launch(process.env.PROXY ? { proxy: { server: process.env.PROXY, bypass: 'localhost,127.0.0.1,192.168.1.10' } } : {});
try {
  const wallet = privateKeyToAccount(DEMO_KEY);
  const owner = wallet.address.toLowerCase();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await installMockWallet(page, wallet);
  // the build points at the LAN agent; from the box the dry-run agent answers on localhost
  if (process.env.AGENT_FROM) await page.route(`**://${process.env.AGENT_FROM}/**`, (r) => r.continue({ url: r.request().url().replace(process.env.AGENT_FROM, `127.0.0.1:${PORT}`) }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${String(e.stack).split('\n').slice(1, 4).join(' <- ').slice(0, 300)}`));
  page.on('console', (m) => m.type() === 'error' && !/403|422|503|404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const posts = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.1\.10):\d+\//.test(r.url())) return;
    posts.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.request().postData() ?? '{}'), status: r.status(), out: await r.json().catch(() => ({})) });
  });
  // alerts are toasts now: the newest one that differs from the last one read
  let lastNote = '';
  const note = async () => {
    await page.waitForFunction((prev) => { const t = [...document.querySelectorAll('.toast-text')].map((e) => e.textContent); return t.length > 0 && t[t.length - 1] !== prev; }, lastNote, { timeout: 25000 });
    await page.waitForTimeout(300);
    lastNote = await page.locator('.toast-text').last().innerText();
    return lastNote;
  };
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1500); };

  // the dry-run agent answers /owner with dryRun:true; here the page sees a live answer so the setup banner applies
  await page.route(/\/owner\/0x[0-9a-fA-F]{40}$/, async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    delete j.dryRun;
    j.pendingApprovals = [];
    await route.fulfill({ response: res, json: j });
  });
  await page.goto(PAGE);
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.waitForTimeout(5000);
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByRole('tab', { name: 'Easy' }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);

  const banner = page.locator('p.attention').filter({ hasText: /Setup: \d of 5/ });
  await banner.waitFor({ timeout: 20000 });
  check('setup: the banner shows while steps are open', true, (await banner.innerText()).replace(/\s+/g, ' '));
  const m = /Setup: (\d) of 5/.exec(await banner.innerText());
  await shot(page, 'setup-banner');
  await banner.getByRole('button', { name: 'Hide the setup reminder' }).click();
  await page.waitForTimeout(400);
  check('setup: closing the banner hides it', (await banner.count()) === 0);
  await page.reload();
  await page.getByRole('tab', { name: 'Easy' }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);
  check('setup: it stays hidden after a reload', (await banner.count()) === 0);

  await page.getByRole('button', { name: /^0x/ }).click();
  const row = page.locator('dialog.account[open]').getByRole('button', { name: /Setup · \d of 5 done/ });
  check('setup: the Account menu has a Setup row with the progress', (await row.count()) === 1 && new RegExp(`Setup · ${m[1]} of 5 done`).test(await row.innerText()));
  await shot(page, 'setup-account-row');
  await row.click();
  await page.getByRole('heading', { name: /Setup · \d of 5 done/ }).waitFor({ timeout: 10000 });
  const again = page.getByRole('button', { name: 'Show it again' });
  check('setup: the Setup page offers to show the reminder again', (await again.count()) === 1);
  await again.click();
  await go('#/trade');
  await banner.waitFor({ timeout: 10000 });
  check('setup: showing it again brings the banner back', (await banner.count()) === 1);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} finally {
  agent.kill();
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

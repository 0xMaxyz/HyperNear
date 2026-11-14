// Account modal through the real page: real Privy login (mock MetaMask), then against the dry-run agent: open the Account modal, screenshot it
// (dark and light, desktop and phone width), check Escape and a backdrop click close it, and that "Link a wallet" closes it first so that Privy's
// own dialog opens in front, not behind (a native <dialog>.showModal() sits in the top layer and makes the page inert).
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

  await page.goto(PAGE);
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.waitForTimeout(5000);
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByRole('tab', { name: 'Easy' }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);

  const modal = page.locator('dialog.account[open]');
  const chip = page.getByRole('button', { name: /^0x/ });
  const open = async () => { await chip.click(); await modal.waitFor({ timeout: 5000 }); await page.waitForTimeout(400); };
  const sizes = [['desktop', 1280, 900], ['phone', 390, 844]];
  for (const [name, w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await open();
      check(`account (${name}, ${theme}): one dialog is open`, (await page.getByRole('dialog').count()) === 1);
      const box = await modal.boundingBox();
      check(`account (${name}, ${theme}): it fits the viewport and nothing scrolls sideways`, box.x >= -1 && box.x + box.width <= w + 1 && (await modal.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)), JSON.stringify(box));
      await page.screenshot({ path: `${OUT}account-${name}-${theme}.png` });
      await page.keyboard.press('Escape');
      check(`account (${name}, ${theme}): Escape closes it`, (await modal.count()) === 0);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await open();
  await page.mouse.click(6, 6);
  await page.waitForTimeout(300);
  check('account: a click on the backdrop closes it', (await modal.count()) === 0);

  // Link a wallet: our dialog must close first, and Privy's own dialog must open in front and be clickable
  await open();
  const link = modal.getByRole('button', { name: /Link a wallet/ });
  check('account: "Link a wallet" is offered', (await link.count()) === 1);
  await link.click();
  await page.waitForTimeout(500);
  check('account: our dialog closed before Privy opened', (await modal.count()) === 0);
  // Privy's UI is what sits at the centre of the page now (it is not behind a top-layer dialog and the page is not inert under it)
  const inFront = () => page.evaluate(() => { const t = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return Boolean(t && t.closest('#headlessui-portal-root')); });
  let front = false;
  for (let i = 0; i < 30 && !front; i++) { front = await inFront(); if (!front) await page.waitForTimeout(500); }
  await shot(page, 'account-privy-link');
  check("account: Privy's dialog is in front, not behind", front);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} finally {
  agent.kill();
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

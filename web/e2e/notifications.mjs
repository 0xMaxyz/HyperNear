// Notifications panel (the bell): one-line times at 1280 and 390 px, day groups, filter, Mark all read kept across a reload, Escape and backdrop close.
// Same harness as setup-banner.mjs (dry-run agent replay, mock wallet). Run from web/ with the built page on PAGE.
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
  await page.waitForTimeout(3500);

  const bell = page.getByRole('button', { name: /^Notifications/ });
  const panel = page.locator('div.pop.notifications');
  const badge = async () => Number((await bell.locator('.count').innerText().catch(() => '0')) || 0);
  const unread0 = await badge();
  check('bell: the badge counts unread events', unread0 > 0, `${unread0}`);
  await bell.click();
  await panel.waitFor({ timeout: 10000 });
  check('panel: opening it does not mark everything read', (await badge()) === unread0);
  const rows = panel.locator('li.notif');
  const nRows = await rows.count();
  check('panel: rows and day groups', nRows > 0 && (await panel.locator('h3.notif-day').count()) > 0, `${nRows} rows`);
  const oneLine = async (tag) => {
    const bad = await panel.locator('time.notif-time').evaluateAll((els) => els.filter((e) => e.getClientRects().length !== 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    check(`panel: every time fits on one line (${tag})`, bad.length === 0, bad.join(' | '));
  };
  await oneLine('1280');
  await page.waitForTimeout(400); // the panel fades in over 120 ms
  await shot(page, 'notifications-dark');
  const noJson = (await panel.locator('.notif-title, .notif-detail').allInnerTexts()).filter((t) => /[{}]\s*"|":/.test(t));
  check('panel: no raw JSON in rows', noJson.length === 0, noJson.slice(0, 2).join(' | '));

  const needs = panel.getByRole('button', { name: /Needs attention/ });
  await needs.click();
  const nNeeds = await rows.count();
  check('panel: Needs attention filters to errors and warnings', (await panel.locator('li.notif.sev-success, li.notif.sev-info').count()) === 0 && nNeeds <= nRows, `${nNeeds} of ${nRows}`);
  await panel.getByRole('button', { name: /^All/ }).click();
  check('panel: All brings the rows back', (await rows.count()) === nRows);

  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached', timeout: 5000 });
  check('panel: Escape closes it', (await panel.count()) === 0);
  await bell.click();
  await panel.waitFor();
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);
  check('panel: a click on the backdrop closes it', (await panel.count()) === 0);

  // the dry-run agent keeps emitting events (guard, stress test), so "zero unread" races it: what must hold is that every row still unread is
  // newer than the saved read time, and that the saved read time survives a reload
  const staleUnread = async () => {
    const seen = await page.evaluate(() => Number(Object.entries(localStorage).find(([k]) => k.includes('notif-seen'))?.[1] ?? 0));
    const rowsUnread = await panel.locator('li.notif.unread time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute('datetime') ?? '')));
    return { seen, stale: rowsUnread.filter((t) => !(t > seen)).length };
  };
  await bell.click();
  await panel.getByRole('button', { name: 'Mark all read' }).click();
  const a1 = await staleUnread();
  check('panel: Mark all read saves a read time and no older row stays unread', a1.seen > 0 && a1.stale === 0, JSON.stringify(a1));
  await page.keyboard.press('Escape');
  const seenBefore = a1.seen;
  await page.reload();
  await page.getByRole('tab', { name: 'Easy' }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(3500);
  await bell.click();
  await panel.waitFor();
  const a2 = await staleUnread();
  check('panel: the read time survives a reload and no older row is unread again', a2.seen >= seenBefore && a2.stale === 0, JSON.stringify(a2));
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  await bell.click();
  await panel.waitFor();
  await oneLine('390');
  const box = await panel.boundingBox();
  check('panel: a full-width sheet on a phone', box && box.x <= 8 && box.x + box.width >= 380, JSON.stringify(box));
  await page.waitForTimeout(400);
  await shot(page, 'notifications-phone-dark');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await bell.click();
  await panel.waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'notifications-light');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} finally {
  agent.kill();
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

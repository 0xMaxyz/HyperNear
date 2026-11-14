// Rebalance legs through the real page: real Privy login (mock MetaMask), then against the REAL agent in `--dry-run --serve`:
// the Fund tab's Rebalance card (pick legs 1 and 2, shares 50/50, preview, sign), the job that moves the money, and the balances after.
// UNIFIED=1 runs the same with unified legs (one balance, no move-to-trading step). The signed request is recovered to the owner with the
// page's own builders and its specHash is compared with the hash of the spec it carried.
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

const agent = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: 'hedged', HYPERNEAR_DRY_UNIFIED: process.env.UNIFIED === '1' ? '1' : '0', HYPERNEAR_MAX_LEVERAGE: '100', PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
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

  const unified = process.env.UNIFIED === '1';
  await go('#/fund');
  await page.getByRole('heading', { name: 'Rebalance legs' }).waitFor({ timeout: 20000 });
  const fundText = await page.locator('main').innerText();
  check(`fund: the legs are ${unified ? 'unified accounts (one balance, no move-to-trading step)' : 'default accounts'}`, unified ? /unified account/.test(fundText) && !/Move to the trading balance/.test(fundText) : !/This leg is a unified account/.test(fundText));
  await page.getByLabel('Include leg 1').check();
  await page.getByLabel('Include leg 2').check();
  check('rebalance: two legs picked, an even split of 50 and 50', (await page.getByLabel('Share of leg 1, percent').inputValue()) === '50' && (await page.getByLabel('Share of leg 2, percent').inputValue()) === '50');
  await page.locator('.rb-moves li').first().waitFor({ timeout: 15000 });
  const move = await page.locator('.rb-moves li').first().innerText();
  check('rebalance: the preview names the move before signing', /Leg 1 → leg 2: \$\d/.test(move), move);
  await shot(page, `rebalance-preview${unified ? '-unified' : ''}`);
  await page.getByRole('button', { name: /Sign · Rebalance/ }).click();
  check('rebalance: signed and started', /Rebalance started: 1 move/.test(await note()));
  await page.getByText(/Rebalanced: 1 move/).waitFor({ timeout: 40000 });
  check('rebalance: the job finished', true);
  await page.waitForTimeout(1500);
  const cells = await page.locator('.rb-table tbody tr').evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
  const now = (leg) => Number(cells.find((c) => c[0].includes(`Leg ${leg}`))[1].replace(/[^0-9.]/g, ''));
  check('rebalance: legs 1 and 2 now hold the same amount', Math.abs(now(1) - now(2)) < 0.02, `leg1 ${now(1)} leg2 ${now(2)}`);
  await shot(page, `rebalance-done${unified ? '-unified' : ''}`);
  const rb = posts.find((p) => p.path === '/rebalance');
  check('rebalance: the agent accepted it (202)', rb?.status === 202);
  check('rebalance: command.specHash is the hash of the spec it carried', rb && rb.body.command.specHash === specHashOfJson(rb.body.spec) && rb.body.command.action === 'rebalanceLegs', JSON.stringify(rb?.body.spec));
  check('rebalance: signed by the owner wallet', rb && (await verify.commandSigner(rb.body, CHAIN, CONTRACT)) === owner);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} finally {
  agent.kill();
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

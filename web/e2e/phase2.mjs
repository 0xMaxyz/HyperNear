// Legs and strategies UI against the REAL agent in `--dry-run --serve`, nothing injected: leg detail with the recorded candles, the
// strategies panel (recorded drafts from draft-live.json, a simulated strategy list, start/pause/resume/stop verified by the
// agent) and the recorded strategy events. The signer is the public example key behind the fixtures' demo owner (dry-run
// only). Signed requests are also checked here with the page's own builders. Run from web/ with vite on :5173.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';
import { specHash } from '../../agent/src/strategy/spec.ts';

const PAGE = 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DEMO_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const CHAIN = 'near-testnet';
const CONTRACT = 'leash-spike-1107.testnet';
// the recorded builder drafts the dry-run agent answers with (agent/results/draft-live.json): same text, same answer
const TEXT_GRID = 'Run a grid on BTC about 2% either side of the current price with 5 levels, about 11 dollars per level.';
const TEXT_DCA = 'Buy about 11 dollars of ETH every 6 hours, 8 times, never paying more than 3% above the current price. Close it all when I stop it.';
const TEXT_BAD = 'Grid on BTC with 20x leverage and 500 dollars.';

const verifyFile = join(tmpdir(), `hypernear-verify-p2-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

async function withAgent(fn) {
  const p = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_UNIFIED: '0', HYPERNEAR_DRY_FIXTURE: 'hedged', PORT: '8787' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { p.stdout.once('data', res); p.once('exit', (c) => rej(new Error(`agent exited early (${c})`))); });
  try { await fn(); } finally { p.kill(); await new Promise((r) => setTimeout(r, 300)); }
}

const browser = await chromium.launch();
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); }); // the agent child dies with its stdout pipe
await withAgent(async () => {
  const wallet = privateKeyToAccount(DEMO_KEY);
  const owner = wallet.address.toLowerCase();
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctxB.newPage();
  await installMockWallet(page, wallet);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/403|422|503|404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const posts = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !r.url().startsWith('http://localhost:8787')) return; // the agent's calls only, not Privy's
    posts.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.request().postData() ?? '{}'), status: r.status(), out: await r.json().catch(() => ({})) });
  });

  await page.goto(PAGE);
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Leg detail/).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(3000);
  const sseStart = Date.now(); // the agent replays the recorded events from the moment /events connects

  // ---- leg detail
  const label = (await page.locator('.chart').getAttribute('aria-label')) ?? '';
  check('leg detail: chart drawn from the recorded candles', (await page.locator('.chart canvas').count()) >= 1 && /candles, \d+ bars/.test(label), label);
  check('leg detail: positions table lists leg 0', (await page.locator('#leg-h').locator('xpath=ancestor::section').locator('table.mini tbody tr').count()) >= 1);
  check('leg detail: open orders state is explicit in dry-run', (await page.getByText('The recorded fixtures hold no open orders.').count()) === 1);
  await page.locator('fieldset.mode label', { hasText: 'Leg 1' }).click();
  await page.waitForTimeout(800);
  check('leg detail: leg 1 shows its short position', (await page.getByText(/Positions on leg 1/).count()) === 1 && (await page.getByText(/BTC short/).count()) >= 1);
  await page.locator('fieldset.mode label', { hasText: 'Leg 0' }).click();
  await page.waitForTimeout(800);

  // ---- the recorded strategy is listed first
  check('the recorded grid-live-1 is listed as running, with Pause and Stop', (await page.locator('table.mini tr', { hasText: 'grid-live-1' }).getByText('running').count()) === 1);
  await shot(page, '20-leg-detail');

  // ---- a draft the agent refuses
  await page.getByLabel('Your rules').fill(TEXT_BAD);
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft.refused').waitFor({ timeout: 20000 });
  check('refused draft: the agent\'s error is listed, the rejected spec is inspectable, no Start button', (await page.locator('.draft.refused li', { hasText: 'maxLeverage 20' }).count()) === 1 && (await page.locator('.draft.refused details').count()) === 1 && (await page.getByRole('button', { name: 'Start strategy' }).count()) === 0);
  await shot(page, '21-strategy-refused');

  // ---- a TWAP draft (read only), then the grid draft, start
  await page.getByLabel('Your rules').fill(TEXT_DCA);
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft h4', { hasText: 'TWAP / DCA on ETH' }).waitFor({ timeout: 20000 });
  check('TWAP draft reads in words: size, count, interval, limit, flatten on stop', (await page.getByText(/Buys 0\.0049 ETH 8 times, one every 6 h, never paying more than \$2,311\.57/).count()) === 1 && (await page.getByText('close the position').count()) === 1);
  await shot(page, '22-strategy-draft-twap');
  await page.getByLabel('Your rules').fill(TEXT_GRID);
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft h4', { hasText: 'Grid on BTC' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  check('grid draft: readable spec, a warning, and the hash recomputed in the browser matches', (await page.getByText(/Places 5 buy levels/).count()) === 1 && (await page.locator('.warnings li').count()) >= 1 && (await page.getByText(/recomputed in your browser, it matches/).count()) === 1);
  await shot(page, '23-strategy-draft-grid');
  const note = async () => { await page.locator('.notice').first().waitFor({ timeout: 25000 }); await page.waitForTimeout(1000); return page.locator('.notice').first().innerText(); };
  await page.getByRole('button', { name: 'Start strategy' }).click();
  check('Start: the agent verified the command and its specHash', /Strategy btc-grid started on leg 3/.test(await note()));
  check('btc-grid is running, the recorded grid-live-1 on that leg was replaced', (await page.locator('table.mini tr', { hasText: 'btc-grid' }).getByText('running').count()) === 1 && (await page.locator('table.mini tr', { hasText: 'grid-live-1' }).getByText('stopped').count()) === 1);

  await page.locator('table.mini tr', { hasText: 'btc-grid' }).scrollIntoViewIfNeeded();
  await shot(page, '24-strategy-running');

  // ---- pause, resume, stop
  const row = () => page.locator('table.mini tr', { hasText: 'btc-grid' });
  await row().getByRole('button', { name: 'Pause' }).click();
  check('Pause is accepted', /btc-grid paused/.test(await note()));
  check('a paused strategy offers Resume', (await row().getByRole('button', { name: 'Resume' }).count()) === 1);
  await row().getByRole('button', { name: 'Resume' }).click();
  check('Resume: the agent accepted the signed startStrategy over the stored spec hash', /btc-grid resumed/.test(await note()));
  await row().getByRole('button', { name: 'Stop' }).click();
  check('Stop is accepted', /btc-grid stopped/.test(await note()));
  await page.waitForTimeout(800);

  // ---- the requests the agent accepted were signed by the owner over exactly these things
  const byPath = (p) => posts.find((x) => x.path === p);
  const start = byPath('/strategy/start');
  const resume = byPath('/strategy/resume');
  const signed = posts.filter((q) => q.body.sig);
  let allOwner = signed.length >= 4;
  for (const q of signed) if ((await verify.commandSigner(q.body, CHAIN, CONTRACT)) !== owner) { allOwner = false; console.log('  wrong signer on', q.path); }
  check(`every signed request recovers to the owner (${[...new Set(signed.map((q) => q.path))].join(', ')})`, allOwner);
  check('start: command.specHash equals the agent\'s specHash(spec); agent answered 200', start.body.command.specHash === specHash(start.body.spec) && start.status === 200);
  check('resume: command.coin is the strategy id, specHash is the hash of the stored spec; agent answered 200', resume.body.command.coin === 'btc-grid' && resume.body.command.specHash === specHash(start.body.spec) && resume.status === 200);
  check('the draft requests carried the owner and the text', posts.filter((q) => q.path === '/strategy/draft').every((q) => q.body.owner === owner && q.body.text.length > 0) && posts.filter((q) => q.path === '/strategy/draft').length === 3);

  // ---- the recorded strategy events arrive on /events (grid, then twap), about 75 s after the connection
  const wait = Math.max(0, 85_000 - (Date.now() - sseStart));
  await page.waitForTimeout(wait);
  const lines = await page.locator('.log.compact li').allInnerTexts();
  check('strategy log has the recorded grid and TWAP events, in words', lines.length >= 10 && lines.some((l) => /grid-live-1: started/.test(l)) && lines.some((l) => /slice \d+ of \d+/.test(l)) && lines.some((l) => /restored after a restart/.test(l)) && lines.some((l) => /\(recorded\)/.test(l)), `${lines.length} lines`);
  await shot(page, '27-strategy-log-recorded');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot(page, '25-phase2-mobile');
  check('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(1200);
  await shot(page, '26-phase2-dark');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctxB.close();
});
await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');

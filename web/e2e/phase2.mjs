// Phase 2 UI against the real agent in `--dry-run --serve`: leg detail with the recorded candles, then the strategies panel.
// The dry-run agent has no strategy routes yet, so /strategy/* and /strategies/* are answered here, in the shapes of
// agent/src/server.ts. The drafts come from the agent's own validateSpec, diffSpecs and warningsFor (only the model step is
// replaced by a fixed spec). Signed requests are real: they are checked with the page's own builders and the agent's specHash.
// The signer is the public example key behind the fixtures' demo owner (dry-run only). Run from web/ with vite on :5173.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';
import { diffSpecs, warningsFor } from '../../agent/src/strategy/builder.ts';
import { specHash, validateSpec } from '../../agent/src/strategy/spec.ts';

const PAGE = 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DEMO_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const CHAIN = 'near-testnet';
const CONTRACT = 'leash-spike-1107.testnet';

const verifyFile = join(tmpdir(), `hypernear-verify-p2-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

// ---- drafts: the model step is a fixed spec, everything after it is the agent's code
const orderPolicy = { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 };
const ownerState = { nonce: 0, frozen: false, agent: 'agent.dry-run', daily_cap: 50e6, cooldown_sec: 30, day: 0, spent_today: 0, last_rebalance_ns: 0 };
const ctx = (busy = []) => ({ orderPolicy, registeredLegs: [0, 1, 2, 3], reservedLegs: [0, 1, 2], busyLegs: busy, owner: ownerState, agentId: 'agent.dry-run', otherTopUpBudget: 0 });
const grid = (over = {}) => ({ id: 'grid-btc-1', type: 'grid', leg: 3, coin: 'BTC', params: { lower: 70000, upper: 80000, levels: 10, sizePerLevel: '0.00015' }, limits: { maxNotional: 200, maxLeverage: 3, maxDailyLoss: 15, topUpCapPerDay: 0 }, onStop: 'cancel', ...over });
const running = grid();
const widened = grid({ params: { lower: 68000, upper: 82000, levels: 14, sizePerLevel: '0.00015' }, limits: { maxNotional: 200, maxLeverage: 3, maxDailyLoss: 20, topUpCapPerDay: 0 } });
function draftFor(text, existing) {
  const spec = /widen/i.test(text) ? widened : /leverage|huge|all in/i.test(text) ? null : running;
  if (!spec) {
    const bad = grid({ id: 'grid-btc-2', leg: 3, params: { lower: 70000, upper: 80000, levels: 10, sizePerLevel: '0.002' }, limits: { maxNotional: 200, maxLeverage: 20, maxDailyLoss: 15, topUpCapPerDay: 0 } });
    const v = validateSpec(bad, ctx());
    return { ok: false, errors: v.errors, draft: bad };
  }
  const c = ctx(existing ? ['xx'] : []);
  const v = validateSpec(spec, ctx());
  if (!v.ok) throw new Error(`fixture spec invalid: ${v.errors.join('; ')}`);
  const cur = existing && spec.id === running.id ? running : undefined;
  return { spec: v.spec, specHash: specHash(v.spec), diff: { against: cur ? spec.id : 'new', changes: cur ? diffSpecs(cur, v.spec) : [] }, warnings: warningsFor(v.spec, c, 75698.5, false) };
}

async function withAgent(fn) {
  const p = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: 'hedged', PORT: '8787' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { p.stdout.once('data', res); p.once('exit', (c) => rej(new Error(`agent exited early (${c})`))); });
  try { await fn(); } finally { p.kill(); await new Promise((r) => setTimeout(r, 300)); }
}

const browser = await chromium.launch();
await withAgent(async () => {
  const wallet = privateKeyToAccount(DEMO_KEY);
  const owner = wallet.address.toLowerCase();
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctxB.newPage();
  await installMockWallet(page, wallet);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/403|422|503|404|Failed to load resource/.test(m.text()) && errors.push(m.text()));

  // the strategy side of the agent, in the shapes of agent/src/server.ts
  let state = 'none';
  const posts = [];
  const json = (route, status, body) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...body, dryRun: true }) });
  await page.route('**/strategies/*', (route) => json(route, 200, { owner, strategies: state === 'none' ? [] : [{ id: running.id, type: 'grid', leg: 3, coin: 'BTC', state, deadman: 'unavailable', held: 0, resting: state === 'running' ? 6 : 0 }] }));
  await page.route('**/strategy/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
    const path = new URL(req.url()).pathname;
    const body = JSON.parse(req.postData() ?? '{}');
    posts.push({ path, body });
    if (path === '/strategy/draft') return json(route, 200, draftFor(body.text, state !== 'none'));
    if (path === '/strategy/start') { state = 'running'; return json(route, 200, { id: body.spec.id, state: 'running' }); }
    if (path === '/strategy/pause') { state = 'paused'; return json(route, 200, { id: body.command.coin, state: 'paused' }); }
    if (path === '/strategy/stop') { state = 'stopped'; return json(route, 200, { id: body.command.coin, state: 'stopped' }); }
    return json(route, 404, { error: 'not found' });
  });
  const at = Date.now();
  const ev = [
    ['strategy.started', { id: 'grid-btc-1', leg: 3 }],
    ['strategy.order', { id: 'grid-btc-1', leg: 3, oid: 1, level: 0, side: 'buy', px: 70000, sz: '0.00015' }],
    ['strategy.order', { id: 'grid-btc-1', leg: 3, oid: 2, level: 1, side: 'buy', px: 71111.1, sz: '0.00015' }],
    ['strategy.fill', { id: 'grid-btc-1', leg: 3, oid: 2, level: 1, side: 'buy', px: 71111.1, sz: '0.00015' }],
    ['strategy.order.refused', { id: 'grid-btc-1', leg: 3, level: 9, side: 'buy', px: 80000, reason: 'exposure after this order $212.00 would exceed maxNotional $200' }],
    ['strategy.paused', { id: 'grid-btc-1', leg: 3, reason: 'owner', cancelled: [1, 2, 3] }],
  ].map(([type, data], i) => ({ id: i + 1, at: at - (6 - i) * 4000, type, data }));
  await page.route('**/events', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: ev.map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') }));

  await page.goto(PAGE);
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Leg detail/).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(3000);

  // ---- leg detail
  check('leg detail: chart canvas drawn from the recorded candles', (await page.locator('.chart canvas').count()) >= 1 && /candles, \d+ bars/.test((await page.locator('.chart').getAttribute('aria-label')) ?? ''), (await page.locator('.chart').getAttribute('aria-label')) ?? '');
  check('leg detail: positions table lists leg 0 BTC long with entry and liquidation', (await page.locator('#leg-h').locator('xpath=ancestor::section').locator('table.mini tbody tr').count()) >= 1);
  check('leg detail: open orders state is explicit in dry-run', (await page.getByText('The recorded fixtures hold no open orders.').count()) === 1);
  await page.locator('fieldset.mode label', { hasText: 'Leg 1' }).click();
  await page.waitForTimeout(800);
  check('leg detail: switching to leg 1 shows its short position', (await page.getByText(/Positions on leg 1/).count()) === 1 && (await page.getByText(/BTC short/).count()) >= 1);
  await page.locator('fieldset.mode label', { hasText: 'Leg 0' }).click();
  await page.waitForTimeout(800);
  await shot(page, '20-leg-detail');

  // ---- draft and refuse
  await page.getByLabel('Your rules').fill('Be all in with huge leverage on BTC');
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft.refused').waitFor({ timeout: 15000 });
  check('a draft the agent refuses lists every error and starts nothing', (await page.locator('.draft.refused li').count()) >= 2 && (await page.getByRole('button', { name: 'Start strategy' }).count()) === 0);
  await shot(page, '21-strategy-refused');

  // ---- draft, read, start
  await page.getByLabel('Your rules').fill('Grid on BTC from 70000 to 80000, 10 levels, 0.00015 each, on leg 3');
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft h4', { hasText: 'Grid on BTC, leg 3' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const draftBody = posts.find((p) => p.path === '/strategy/draft' && /Grid on BTC/.test(p.body.text));
  check('the draft request carries the owner and the text', draftBody?.body.owner === owner);
  check('spec is readable, with limits, warnings and the recomputed hash', (await page.getByText(/Places 10 buy levels between \$70,000 and \$80,000/).count()) === 1 && (await page.locator('.warnings li').count()) >= 1 && (await page.getByText(/recomputed in your browser, it matches/).count()) === 1);
  await shot(page, '22-strategy-draft');
  await page.getByRole('button', { name: 'Start strategy' }).click();
  await page.locator('.notice').first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(1500);
  check('Start strategy: notice and the strategy appears in the list', /Strategy grid-btc-1 started/.test(await page.locator('.notice').first().innerText()) && (await page.locator('table.mini td', { hasText: 'grid-btc-1' }).count()) >= 1);
  const start = posts.find((p) => p.path === '/strategy/start');
  const signer = start ? await verify.commandSigner(start.body, CHAIN, CONTRACT) : '';
  check('start command: signed by the owner, action startStrategy, specHash equals the agent\'s specHash(spec)', signer === owner && start.body.command.action === 'startStrategy' && start.body.command.specHash === specHash(start.body.spec), `${start?.body.command.specHash?.slice(0, 12)}`);
  check('the signed spec is the spec the draft showed', JSON.stringify(start.body.spec) === JSON.stringify(running));

  // ---- diff against the running strategy
  await page.getByLabel('Your rules').fill('Widen my grid to 68000 to 82000 with 14 levels');
  await page.getByRole('button', { name: 'Draft strategy' }).click();
  await page.locator('.draft table.mini').waitFor({ timeout: 15000 });
  check('diff against the running strategy lists the changed fields', (await page.locator('.draft table.mini tbody tr').count()) >= 3 && (await page.locator('.draft code', { hasText: 'params.lower' }).count()) === 1);
  await shot(page, '23-strategy-diff-running');

  // ---- pause and stop (signed), strategy log
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForTimeout(2500);
  check('Pause: signed pauseStrategy with the strategy id', (() => { const p = posts.find((x) => x.path === '/strategy/pause'); return p?.body.command.action === 'pauseStrategy' && p.body.command.coin === 'grid-btc-1'; })());
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForTimeout(2500);
  const stop = posts.find((x) => x.path === '/strategy/stop');
  check('Stop: signed stopStrategy with the strategy id', stop?.body.command.action === 'stopStrategy' && stop.body.command.coin === 'grid-btc-1');
  for (const x of posts.filter((q) => q.body.sig)) {
    const who = await verify.commandSigner(x.body, CHAIN, CONTRACT);
    if (who !== owner) check(`signer on ${x.path}`, false, who);
  }
  check('every signed strategy command recovers to the owner', posts.filter((q) => q.body.sig).length === 3);
  check('strategy log shows orders, a fill, a refusal and a pause in words', (await page.locator('.log.compact li').count()) === 6 && (await page.locator('.log.compact li.flag').count()) >= 1 && (await page.getByText(/order refused by the limits: exposure after this order/).count()) === 1);
  await shot(page, '24-strategies-and-log');
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

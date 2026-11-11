// The trading flows through the real page: real Privy login (mock MetaMask), then, against the REAL agent in `--dry-run --serve`:
// place a one-sided market order from Trade, see it as its own position in Overview, close a leg, hedge again with leg 1's own leverage and margin
// mode, protect a position with a bracket, cancel it from Open orders, withdraw to the owner's wallet. Every signed request is recovered to the owner
// with the page's own builders and its specHash is compared with the hash of the spec it carried. Also captures the dark login modal.
// Run from web/ with the built page served on :5173 (PAGE) and Node's proxy env for Privy: PROXY=http://127.0.0.1:1081 on ci32.
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

const verifyFile = join(tmpdir(), `hypernear-verify-trading-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

const agent = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: 'hedged', PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${String(e.stack).split(String.fromCharCode(10)).slice(1, 4).join(' <- ').slice(0, 300)}`));
  page.on('console', (m) => m.type() === 'error' && !/403|422|503|404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const posts = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.1\.10):\d+\//.test(r.url())) return;
    posts.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.request().postData() ?? '{}'), status: r.status(), out: await r.json().catch(() => ({})) });
  });
  const note = async () => { await page.locator('.notice').first().waitFor({ timeout: 25000 }); await page.waitForTimeout(900); return page.locator('.notice').first().innerText(); };
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1500); };

  await page.goto(PAGE);
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.waitForTimeout(2500);
  await shot(page, 'trading-privy-login-dark');
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#privy-dialog, [role=dialog]') ?? document.body).backgroundColor);
  check('privy login modal follows the dark theme (not white)', !/^rgb\(2[45]\d, 2[45]\d, 2[45]\d\)$/.test(bg), bg);
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);

  // ---- one-sided market order on leg 2 (flat in the fixture), 4x isolated
  await go('#/trade');
  await page.locator('main select').first().selectOption('2'); // the first select on the ticket is the leg
  await page.getByLabel(/^Size, BTC/).fill('0.0002');
  await page.getByLabel(/^Leverage/).fill('4');
  await page.getByLabel('Margin').selectOption('isolated');
  check('trade: the ticket says what signing will do', await page.getByText(/Buy 0\.0002 BTC at market on leg 2 at 4x isolated/).isVisible());
  await shot(page, 'trading-ticket');
  await page.getByRole('button', { name: 'Sign and send' }).click();
  check('trade: the agent accepted the signed market order', /Buy 0\.0002 BTC at market on leg 2 at 4x isolated/.test(await note()));
  await go('#/overview');
  const lone = page.locator('section', { has: page.getByRole('heading', { name: 'BTC long, one leg' }) });
  check('overview: the new position is its own one-sided card with a PnL breakdown', (await lone.count()) === 1 && (await lone.getByText('Net if closed now (estimate)').count()) === 1 && (await lone.getByText('4x isolated').count()) === 1);
  check('overview: the hedge and the one-sided trade are separate positions', (await page.getByRole('heading', { name: 'BTC hedge' }).count()) === 1);
  await shot(page, 'trading-overview-onesided');
  await lone.getByRole('button', { name: 'Close leg' }).click();
  check('overview: closing the leg is a signed reduce-only order', /Closed leg 2's BTC/.test(await note()));
  await page.waitForTimeout(800);
  check('overview: the closed position is gone', (await page.getByRole('heading', { name: 'BTC long, one leg' }).count()) === 0);

  // ---- close the hedge's second leg, then hedge again with leg 1's own leverage and margin mode
  const hedgeCard = page.locator('section', { has: page.getByRole('heading', { name: 'BTC hedge' }) });
  await hedgeCard.getByRole('button', { name: 'Close leg' }).nth(1).click();
  check('overview: leg 1 closed on its own', /Closed leg 1's BTC/.test(await note()));
  await go('#/hedge');
  await page.getByLabel(/^Leg 1 leverage/).fill('4');
  await page.getByLabel('Leg 1 margin').selectOption('isolated');
  await page.getByRole('button', { name: 'Open hedge' }).click();
  check('hedge: opened with the leg 1 settings in the message', /Hedge on BTC opened at ratio 0\.5 \(leg 1 4x isolated\)/.test(await note()));
  await go('#/overview');
  check('overview: leg 1 now runs 4x isolated while leg 0 stays 3x cross', (await page.locator('section', { has: page.getByRole('heading', { name: 'BTC hedge' }) }).getByText('4x isolated').count()) === 1 && (await page.getByText('3x cross').count()) >= 1);

  // ---- protect leg 0 with a bracket, see it under Open orders, cancel it
  await go('#/strategies?protect=0&coin=BTC');
  await page.getByText('Take-profit and stop-loss', { exact: true }).click();
  await shot(page, 'trading-protect');
  await page.getByRole('button', { name: 'Sign and place' }).click();
  await page.getByText(/Protection placed on leg 0/).waitFor({ timeout: 25000 });
  check('protect: the bracket was placed', true);
  await go('#/trade');
  check('trade: open orders lists both bracket orders, sized to the position', (await page.locator('table.mini tr', { hasText: 'whole position' }).count()) === 2);
  await shot(page, 'trading-open-orders');
  await page.locator('table.mini tr', { hasText: 'whole position' }).first().getByRole('button', { name: 'Cancel' }).click();
  check('trade: cancel is a signed command', /Order cancelled/.test(await note()));

  // ---- withdraw to the owner's wallet
  await go('#/fund?leg=0');
  const wd = page.locator('section', { has: page.getByRole('heading', { name: 'Withdraw to my wallet' }) });
  await wd.getByLabel('Amount, USDC').fill('3');
  check('fund: withdraw states the fee and what arrives', await page.getByText(/You receive \$2\.00/).isVisible());
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  check('fund: withdrawal accepted by the agent', /Withdrew 3 USDC from leg 0 to your wallet \(you receive 2\.00\)/.test(await note()));
  await shot(page, 'trading-withdraw');

  // ---- what the agent accepted was signed by the owner over exactly these specs
  const placed = posts.filter((q) => q.path === '/order/place');
  const cancelled = posts.filter((q) => q.path === '/order/cancel');
  const hedge = posts.find((q) => q.path === '/hedge/open');
  const withdraw = posts.find((q) => q.path === '/relay' && q.body.intent?.type === 'withdraw');
  let allOwner = true;
  for (const q of posts.filter((x) => x.body.sig && x.body.command)) if ((await verify.commandSigner(q.body, CHAIN, CONTRACT)) !== owner) { allOwner = false; console.log('  wrong signer on', q.path); }
  check('every signed command recovers to the owner', allOwner && posts.filter((x) => x.body.command).length >= 6);
  check('placeOrder: command.specHash is the hash of the spec sent, all answered 200', placed.length >= 4 && placed.every((q) => q.body.command.specHash === specHashOfJson(q.body.spec) && q.status === 200), `${placed.length} orders`);
  check('placeOrder: the market order carries the exact leverage and margin the owner chose', placed[0].body.spec.leverage === 4 && placed[0].body.spec.isCross === false && placed[0].body.spec.type === 'market');
  check('cancelOrder: bound to its spec too', cancelled.length === 1 && cancelled[0].body.command.specHash === specHashOfJson(cancelled[0].body.spec) && cancelled[0].status === 200);
  check('openHedge: the leg 1 spec is signed (specHash) and the agent accepted it', hedge?.body.spec?.leg1Leverage === 4 && hedge.body.spec.leg1IsCross === false && hedge.body.command.specHash === specHashOfJson(hedge.body.spec) && hedge.status === 200);
  check('withdraw: an owner intent through the relayer, answered ok', withdraw?.status === 200 && withdraw.out.ok === true && (await verify.intentSigner(withdraw.body, CHAIN, CONTRACT)) === owner);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const t of ['overview', 'trade']) {
    await go(`#/${t}`);
    check(`no horizontal overflow at 390px on ${t}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  await shot(page, 'trading-phone');
  const hist = await (await fetch(`http://127.0.0.1:${PORT}/history/${owner}`)).json();
  const bad = hist.rows.filter((r) => Object.values(r).some((v) => v === null));
  if (bad.length) console.log('rows with null:', JSON.stringify(bad.slice(0, 3)));
  const pos = await (await fetch(`http://127.0.0.1:${PORT}/positions/${owner}`)).json();
  console.log('positions:', JSON.stringify(pos.positions.map((c) => ({ kind: c.kind, totals: c.totals }))).slice(0, 600));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} finally {
  agent.kill();
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

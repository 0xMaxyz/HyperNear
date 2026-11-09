// Screenshots and a click-through of the D5 page against the REAL agent in `--dry-run --serve` (no keys, recorded fixtures).
// Needs `vite` on http://localhost:5173 (the Privy-allowed origin) and the workspace packages built. Run from web/.
// Output: screenshots/*.png and a PASS/FAIL line per check on stdout.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';

const PAGE = 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
// Request bodies are checked with the page's own builders (bundled here), so a wrong domain or field shows up as a wrong signer.
const verifyFile = join(tmpdir(), `hypernear-verify-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

async function withAgent(fixture, fn, port = '8787') {
  const p = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: fixture, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  await demo(page, 48000);
  check('dry-run badge shown', await page.getByText('dry-run data').isVisible());
  check('legs table lists the three legs with roles', (await page.locator('table').first().locator('tbody tr').count()) === 3 && (await page.getByText('reserve, source for the guard').count()) === 1, `${await page.locator('table').first().locator('tbody tr').count()} rows; ${(await page.locator('table').first().locator('tbody').allInnerTexts()).join(' | ').replace(/\s+/g, ' ').slice(0, 300)}`);
  check('break-even card shows a price from the agent', /\$7\d,\d{3}/.test(await page.locator('.kv dd.big').first().innerText()), await page.locator('.kv dd.big').first().innerText());
  const proposals = await page.locator('.log li .tag', { hasText: 'decision.proposed' }).count();
  check('5 recorded proposals reached the log', proposals === 5, String(proposals));
  check('decision panel shows action, source, model, five factors and a rationale', (await page.locator('section[aria-labelledby=dec-h] .big-action').count()) === 1 && (await page.locator('.probs li').count()) === 5 && (await page.locator('.rationale').count()) === 1 && (await page.locator('section[aria-labelledby=dec-h] dt', { hasText: 'Model' }).count()) === 1);
  check('agents.revoked reached the log', (await page.locator('.log li', { hasText: 'trading keys revoked on Hyperliquid' }).count()) === 1);
  check('Accept and Dismiss are disabled when only viewing', (await page.getByRole('button', { name: /Accept and sign/ }).isDisabled()) && (await page.getByRole('button', { name: 'Dismiss' }).isDisabled()));
  await page.getByRole('button', { name: 'Ask for a proposal' }).click();
  await page.waitForTimeout(2500);
  check('Ask for a proposal adds a proposal to the log', (await page.locator('.log li .tag', { hasText: 'decision.proposed' }).count()) === 6);
  check('guard replay reached the log, in words', (await page.locator('.log li', { hasText: 'rebalance posted to Hyperliquid' }).count()) >= 1);
  check('signing buttons are disabled when only viewing', await page.getByRole('button', { name: 'Open hedge' }).isDisabled());
  check('freeze copy mentions revoked trading keys', (await page.getByText(/revokes the agents' Hyperliquid trading keys/).count()) === 1);
  // the freeze sweep (orders.swept, replayed after agents.revoked): one log row with per-leg NEAR tx links, and the two freeze steps
  const sweepRow = page.locator('.log li', { hasText: 'Freeze sweep: 2 resting orders cancelled on 2 legs (18.5 s)' });
  check('orders.swept in the log, in words', (await sweepRow.count()) === 1);
  check('sweep row links each leg tx to the NEAR testnet explorer', (await sweepRow.locator('a[href^="https://testnet.nearblocks.io/txns/"]').count()) === 2);
  check('freeze step: trading keys revoked', (await page.locator('.freeze-steps li', { hasText: 'Trading keys: revoked on 3 of 3 legs' }).count()) === 1);
  check('freeze step: resting orders cleared (2)', (await page.locator('.freeze-steps li', { hasText: 'Resting orders: cleared (2)' }).count()) === 1);
  await shot(page, '03-hedged-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, '04-hedged-mobile');
  const wide = await page.evaluate(() => {
    const vw = window.innerWidth;
    const rows = [...document.querySelectorAll('html, body, body *')].map((el) => ({ el, r: el.getBoundingClientRect(), sw: el.scrollWidth, cw: el.clientWidth }));
    const out = rows.filter((x) => x.r.right > vw + 1 || x.sw > x.cw + 1).slice(5, 18).map((x) => `${x.el.tagName}.${x.el.className} right=${Math.round(x.r.right)} sw=${x.sw} cw=${x.cw}`);
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
// 2b. the freeze steps when the sweep is still pending, and when it failed: events injected through a tiny SSE server, /owner patched to frozen
{
  const frames = (evs) => evs.map((e) => `id: ${e.id}
event: ${e.type}
data: ${JSON.stringify(e)}

`).join('');
  const revoked = { id: 1, at: Date.now(), type: 'agents.revoked', data: { legs: [0, 1, 2].map((leg) => ({ leg, ok: true })) } };
  const leg = (n, extra) => ({ leg: n, address: '0x' + String(n).repeat(40), found: 1, skipped: 0, cancelled: 0, txHashes: [], hl: [], ...extra });
  const cases = [
    ['pending', [revoked], /Resting orders: pending/, '13-sweep-pending'],
    ['whole sweep failed', [revoked, { id: 2, at: Date.now(), type: 'orders.swept', data: { trigger: 'freeze', legs: [], cancelled: 0, ms: 1200, error: 'NEAR RPC timeout' } }], /Resting orders: failed: NEAR RPC timeout \(anyone can retry: see README\)/, '14-sweep-failed'],
    ['one leg failed', [revoked, { id: 2, at: Date.now(), type: 'orders.swept', data: { trigger: 'freeze', cancelled: 1, ms: 9100, legs: [leg(0, { cancelled: 1, txHashes: ['9xTzQ4pL2a'], hl: ['ok'] }), leg(1, { hl: ['err: order not found'] }), leg(2, { found: 0 })] } }], /Resting orders: failed: leg 1: err: order not found/, '15-sweep-leg-failed'],
  ];
  let cur = [];
  const sse = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }); res.write(frames(cur)); });
  await new Promise((r) => sse.listen(9797, r));
  await withAgent('hedged', async () => {
    for (const [name, evs, want, file] of cases) {
      cur = evs;
      const { page, ctx } = await open();
      await page.route('**/events', (route) => route.continue({ url: 'http://localhost:9797/events' }));
      await page.route(/\/owner\/0x/, async (route) => {
        const r = await route.fetch();
        const j = await r.json();
        await route.fulfill({ response: r, json: { ...j, policy: { ...(j.policy ?? { agent: null, daily_cap: 0, spent_today: 0, cooldown_sec: 0, nonce: 0 }), frozen: true } } });
      });
      await demo(page, 3000);
      const t = (await page.locator('.freeze-steps').innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`freeze steps (${name}): ${t.slice(0, 150)}`, want.test(t.replace(/Trading keys.*?Resting/, 'Resting')));
      if (name === 'one leg failed') check('failed leg is named in the log row', (await page.locator('.log li.flag', { hasText: 'Freeze sweep' }).count()) === 1 && (await page.locator('.log ul.sub li', { hasText: 'Leg 1' }).count()) === 1);
      await shot(page, file);
      await ctx.close();
    }
  });
  sse.closeAllConnections();
  sse.close();
}
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

// 4. the demo owner. 0x2c75…5c23, the fixtures' owner, is the address of a widely published web3 example key; it is a
//    public test key, used here only against --dry-run (and our testnet scripts). Signing as it lets every signed
//    action run through the UI against the real dry-run agent. The dry-run fixtures have approved agents on every
//    leg, so GET /owner is staged: unprepared, then prepared (with the agent's own /agents/prepare answer), then as
//    recorded. The signed requests are real; only that view is staged.
const DEMO_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
await withAgent('hedged', async () => {
  const wallet = privateKeyToAccount(DEMO_KEY);
  const owner = wallet.address.toLowerCase();
  const { page, ctx, errors } = await open({ wallet });
  let stage = 'unprepared';
  let prepared;
  const posts = [];
  await page.route('**/owner/*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    if (stage !== 'approved') {
      const keyOf = (leg) => prepared?.legs.find((l) => l.leg === leg)?.agent;
      const agentFor = (l) => (stage === 'unprepared' ? null : { address: keyOf(l.leg).address, name: keyOf(l.leg).name, approvedAt: null });
      j.legs = j.legs.map((l) => ({ ...l, agent: agentFor(l), ...(stage === 'unprepared' ? { needsPrepare: true } : {}) }));
      j.snapshot.legs = j.snapshot.legs.map((l) => ({ ...l, agent: agentFor(l) }));
      j.pendingApprovals = stage === 'prepared' ? prepared.pendingApprovals : [];
    }
    await route.fulfill({ response: res, json: j });
  });
  await page.route('**/agents/prepare', async (route) => {
    const res = await route.fetch();
    if (res.status() === 200) { prepared = await res.json(); stage = 'prepared'; }
    await route.fulfill({ response: res });
  });
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST') return;
    const path = new URL(r.url()).pathname;
    const body = JSON.parse(r.request().postData() ?? '{}');
    const out = await r.json().catch(() => ({}));
    posts.push({ path, body, status: r.status(), out });
    if (path === '/relay' && body.intent?.type === 'approveAgent' && posts.filter((p) => p.body.intent?.type === 'approveAgent').length >= (prepared?.pendingApprovals.length ?? 99)) stage = 'approved';
  });
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Create legs/).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);
  check('logged in as the demo owner and its legs load', (await page.locator('table').first().locator('tbody tr').count()) === 3 && (await page.locator('.who .addr').innerText()).toLowerCase().startsWith(owner.slice(0, 6)), `${await page.locator('table').first().locator('tbody tr').count()} rows; ${await page.locator('.who .addr').innerText()}`);
  check('staged view: Prepare agents is open, Approve agent is not yet', (await page.getByRole('button', { name: 'Prepare agents' }).isEnabled()) && (await page.getByRole('button', { name: 'Approve agent' }).isDisabled()));
  await shot(page, '10-demo-owner-unprepared');
  const note = async () => { await page.locator('.notice').first().waitFor({ timeout: 25000 }); await page.waitForTimeout(900); return page.locator('.notice').first().innerText(); };
  const click = async (name, expect) => { await page.getByRole('button', { name }).click(); const t = await note(); check(`${name}: ${t.slice(0, 100)}`, expect.test(t)); };
  await click('Prepare agents', /Agent keys prepared/);
  check('prepared: Approve agent is now open', await page.getByRole('button', { name: 'Approve agent' }).isEnabled());
  await click('Approve agent', /Approved the agent key on 3 legs/);
  await shot(page, '11-demo-owner-approved');
  await click('Update policy', /Agent agent\.dry-run enabled/);
  await page.locator('fieldset.mode label', { hasText: 'Auto' }).click();
  check('autonomy Auto is accepted for the opted-in owner', /Autonomy set to auto/.test(await note()));
  await page.locator('fieldset.mode label', { hasText: 'Propose' }).click();
  check('autonomy back to Propose', /Autonomy set to propose/.test(await note()));
  await click('Freeze', /Account frozen/);
  await click('Close hedge', /Hedge on BTC closed/);
  // Accept: whatever proposal the panel shows; the agent checks the command against that proposal's action
  const acceptedFor = await page.locator('section[aria-labelledby=dec-h] .big-action').innerText();
  await click('Accept and sign', /Accepted:/);
  check(`decision.accepted reached the log for "${acceptedFor}"`, (await page.locator('.log li .tag', { hasText: 'decision.accepted' }).count()) >= 1);
  // Reject: ask for a fresh proposal, then dismiss it
  await page.getByRole('button', { name: 'Ask for a proposal' }).click();
  await page.locator('section[aria-labelledby=dec-h] .big-action').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await click('Dismiss', /Proposal dismissed/);
  check('decision.rejected (reason owner) reached the log', (await page.locator('.log li', { hasText: /rejected: .*owner/ }).count()) >= 1);
  await shot(page, '12-demo-owner-decided');
  // every signed request recovers to the demo owner with the page's own builders; approvals were signed exactly as listed
  const signed = posts.filter((p) => p.body.sig);
  let allOwner = signed.length > 0;
  for (const p of signed) {
    const who = p.body.intent ? await verify.intentSigner(p.body, 'near-testnet', 'leash-spike-1107.testnet') : await verify.commandSigner(p.body, 'near-testnet', 'leash-spike-1107.testnet');
    if (who !== owner) { allOwner = false; console.log('  wrong signer on', p.path, who); }
  }
  check(`all ${signed.length} signed requests recover to the demo owner (${[...new Set(signed.map((p) => p.path))].join(', ')})`, allOwner);
  const approvals = posts.filter((p) => p.body.intent?.type === 'approveAgent').map((p) => p.body.intent);
  check('each approveAgent intent equals the agent-listed pendingApprovals entry', approvals.length === 3 && approvals.every((i) => prepared.pendingApprovals.some((x) => JSON.stringify(x) === JSON.stringify(i))));
  check('no page errors (demo owner)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});


// 5. optional TEE mode against two real dry-run agents: the server agent (8787) and the owner's TEE agent (8788, VITE_TEE_AGENT_URL).
//    The dry run has no contract: the page's fixture plays get_config / get_tee / get_tee_agent and applies setTee / payTee itself.
await withAgent('hedged', () => withAgent('hedged', async () => {
  const wallet = privateKeyToAccount(DEMO_KEY);
  const owner = wallet.address.toLowerCase();
  const { page, ctx, errors } = await open({ wallet });
  const posts = [];
  const hits = { server: 0, tee: 0 };
  let prepared = false;
  page.on('request', (r) => { const u = r.url(); if (/:8787\/owner\//.test(u)) hits.server++; if (/:8788\/owner\//.test(u)) hits.tee++; });
  await page.route('http://localhost:8788/agents/prepare', async (route) => { const res = await route.fetch(); prepared = true; posts.push({ path: '8788/agents/prepare' }); await route.fulfill({ response: res }); });
  await page.route('http://localhost:8788/owner/*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    if (!prepared) j.legs = j.legs.map((l) => ({ ...l, agent: null, needsPrepare: true }));
    await route.fulfill({ response: res, json: j });
  });
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !/:8787\/relay/.test(r.url())) return;
    posts.push({ path: '/relay', body: JSON.parse(r.request().postData() ?? '{}') });
  });
  await page.getByRole('button', { name: /Log in with/ }).click();
  await page.getByText('Continue with a wallet').click({ timeout: 15000 });
  await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
  await page.getByText(/Create legs/).first().waitFor({ timeout: 40000 });
  const host = page.locator('section[aria-labelledby=host-h]');
  await host.getByText('Server (free)').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  check('Agent hosting offers Server (free) and TEE with the price from get_config', (await host.locator('label.on', { hasText: 'Server (free)' }).count()) === 1 && (await host.getByText('TEE ($5.00/month)').count()) === 1);
  await shot(page, '30-hosting-server');
  await host.getByText('TEE ($5.00/month)').click();
  await host.getByLabel(/TEE agent account/).fill('leash-tee-1.hypernear-dry-run.testnet');
  await host.getByRole('button', { name: 'Look up on the contract' }).click();
  await host.getByText(/measurement filled in/).waitFor({ timeout: 5000 });
  const hash = await host.getByLabel(/Measurement hash you accept/).inputValue();
  check('look-up fills the measurement hash from get_tee_agent', /^0x[0-9a-f]{64}$/.test(hash), hash);
  await shot(page, '31-tee-choose');
  const note = async () => { await page.locator('.notice').first().waitFor({ timeout: 25000 }); await page.waitForTimeout(900); return page.locator('.notice').first().innerText(); };
  await host.getByRole('button', { name: /Switch to TEE/ }).click();
  const t1 = await note();
  check(`Switch to TEE: ${t1.slice(0, 90)}`, /Switched to TEE mode/.test(t1));
  await host.getByText(/^Pay for TEE hosting/).waitFor({ timeout: 15000 });
  check('TEE card shows measurement, agent account and the dev label (never "verified")', (await host.locator('dd', { hasText: hash }).count()) === 1 && (await host.getByText('dev-registered (testnet), no hardware quote').count()) === 1 && !/TDX|verified/i.test(await host.innerText()));
  check('tee.switched in the log: "TEE keys revoked on 3 legs"', (await page.locator('.log li', { hasText: 'TEE keys revoked on 3 legs' }).count()) >= 1);
  check('owner calls now go to the TEE agent', hits.tee >= 1, JSON.stringify(hits));
  await host.getByLabel('Months, 1 to 12').fill('2');
  const pay = await host.locator('p', { hasText: /^You pay/ }).innerText();
  check(`Pay shows amount and destination before signing: ${pay.slice(0, 120)}`, /\$10\.00 \(2 × \$5\.00\) to 0x7b1e0a5f3c2d4e6f8091a2b3c4d5e6f708192a3b/.test(pay));
  await host.getByRole('button', { name: /^Pay \$10\.00/ }).click();
  const t2 = await note();
  check(`Pay: ${t2.slice(0, 90)}`, /Paid 2 months of TEE hosting from leg 0/.test(t2));
  await host.locator('dt', { hasText: 'Months paid' }).locator('xpath=following-sibling::dd[1]').filter({ hasText: '2' }).waitFor({ timeout: 15000 });
  check('tee.paid in the log', (await page.locator('.log li', { hasText: 'TEE payment: 2 months paid from leg 0' }).count()) >= 1);
  await page.getByRole('button', { name: 'Prepare agents' }).click();
  const t3 = await note();
  check(`Prepare agents goes to the TEE agent: ${t3.slice(0, 70)}`, /Agent keys prepared/.test(t3) && posts.some((p) => p.path === '8788/agents/prepare'));
  check('setup text for TEE mode', (await page.getByText(/in its own memory and the contract approves it for you/).count()) === 1);
  await shot(page, '32-tee-mode');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, '33-tee-mobile');
  check('no horizontal overflow at 390px (TEE)', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await shot(page, '34-tee-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await host.getByText('Server (free)').click();
  check('leaving TEE warns that it revokes the TEE trading keys', (await host.getByText(/revokes the TEE's trading keys on Hyperliquid/).count()) === 1);
  await host.getByRole('button', { name: 'Leave TEE…' }).click();
  await shot(page, '35-tee-leave');
  await host.getByRole('button', { name: /^Leave TEE: sign/ }).click();
  const t4 = await note();
  check(`Leave TEE: ${t4.slice(0, 90)}`, /Back on the server/.test(t4));
  await host.locator('label.on', { hasText: 'Server (free)' }).waitFor({ timeout: 15000 });
  check('after leaving, the card is back in server mode', (await host.getByText(/^Pay for TEE hosting/).count()) === 0);
  const sent = posts.filter((p) => p.body?.sig);
  const types = sent.map((p) => p.body.intent.type);
  check(`signed setTee, payTee, setTee: ${types.join(', ')}`, types.join() === 'setTee,payTee,setTee');
  let allOwner = true;
  for (const p of sent) if ((await verify.intentSigner(p.body, 'near-testnet', 'leash-spike-1107.testnet')) !== owner) allOwner = false;
  check('setTee and payTee intents recover to the owner', allOwner);
  const pay1 = sent[1].body.intent;
  check('payTee carries priceMicro 5000000 and the fee address from get_config', pay1.priceMicro === 5000000 && pay1.feeAddress === '0x7b1e0a5f3c2d4e6f8091a2b3c4d5e6f708192a3b' && pay1.months === 2 && pay1.leg === 0);
  const zero = sent[2].body.intent;
  check('leaving signs setTee with the zero hash and an empty account', /^0x0{64}$/.test(zero.measurementHash) && zero.agentAccount === '');
  check('no page errors (TEE)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}, '8788'));


await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');

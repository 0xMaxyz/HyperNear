// The demo video: a scripted screen recording (Playwright recordVideo, 1280x720, no voiceover, injected captions) of the
// real page against the real agent in `--dry-run --serve`, signing as the demo owner. Run from web/ on ci32 with vite
// running on :5173 with VITE_AGENT_URL=http://localhost:8788 (this script serves that port).
//   output: ../demo/hypernear-demo.webm  (mp4 is encoded by the ci32 job script when ffmpeg is available)
//
// What is real and what is not (also told to whoever asks):
//  - Every click goes through the real page; every signature is made by the demo owner's wallet and every signed
//    request goes to the real dry-run agent, which verifies it (except /relay, which the dry run does not verify; the
//    script recovers those signers itself and aborts on a mismatch).
//  - The dry run serves recorded fixtures, so a stand-in proxy on :8788 does two things the agent cannot: it holds the
//    agent's recorded events and releases them when their scene starts (the guard timeline comes from
//    agent/results/guard-demo-labeled.json, the live run whose numbers the captions quote), and it forwards the rest.
//  - GET /owner is staged during the setup scenes (no legs, then unprepared, prepared, approved, un-hedged), because the
//    fixtures are already set up and hedged. The signed calls in those scenes are real; the view moves after each.
//  - POST /hedge/open: the agent verifies nothing here because the fixture is already hedged (it would refuse); the script
//    checks the signature itself and answers with the dry run's own response shape.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { installMockWallet } from './mock-wallet.mjs';
import { specHash } from '../../agent/src/strategy/spec.ts';

const PAGE = 'http://localhost:5173/';
const AGENT = 'http://localhost:8787';
const PROXY_PORT = 8788;
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../demo/', import.meta.url));
const TMPV = join(tmpdir(), `hypernear-video-${process.pid}`);
// public example key behind the fixtures' demo owner 0x2c75...5c23; dry-run and testnet only
const DEMO_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const CHAIN = 'near-testnet';
const CONTRACT = 'leash-spike-1107.testnet';
const TEXT_GRID = 'Run a grid on BTC about 2% either side of the current price with 5 levels, about 11 dollars per level.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const verifyFile = join(tmpdir(), `hypernear-verify-video-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('./verify-entry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: verifyFile, logLevel: 'error' });
const verify = await import(verifyFile);
const wallet = privateKeyToAccount(DEMO_KEY);
const owner = wallet.address.toLowerCase();

// ------------------------------------------------------------------ the agent and the stand-in proxy in front of it
const agent = spawn('node', ['agent/src/server.ts', '--dry-run', '--serve'], { cwd: REPO, env: { ...process.env, HYPERNEAR_DRY_FIXTURE: 'hedged', PORT: '8787' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { agent.stdout.once('data', res); agent.once('exit', (c) => rej(new Error(`agent exited early (${c})`))); });
const cleanup = () => { try { agent.kill(); } catch {} };
process.on('exit', cleanup);
let finishing = false;
process.on('uncaughtException', (e) => { if (finishing) return; console.error(e); cleanup(); process.exit(1); });

const clients = new Set();
let nextId = 2_000_000;
const frame = (e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const emit = (type, data) => { const e = { id: nextId++, at: Date.now(), type, data }; for (const w of clients) w(frame(e)); };
const held = { proposals: [], revoked: [] };
// one upstream connection: the agent replays its recorded events once, the proxy keeps the ones a scene will release
(async () => {
  const r = await fetch(`${AGENT}/events`);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const e = JSON.parse(data.slice(6));
      if (e.type === 'decision.proposed') held.proposals.push(e);
      else if (e.type === 'agents.revoked') held.revoked.push(e);
      else if (/^(guard\.|stress\.)/.test(e.type)) continue; // the guard timeline is the labeled live run, played by the guard scene
      else if (/^strategy\./.test(e.type) && e.data.recorded) continue; // recorded strategy events come from the result files
      else for (const w of clients) w(frame(e)); // simulated starts, decision.accepted, commands: forwarded at once
    }
  }
})().catch((e) => console.error('upstream events', e));

createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
    const w = (s) => res.write(s);
    clients.add(w);
    req.on('close', () => clients.delete(w));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const up = await fetch(`${AGENT}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  res.writeHead(up.status, { 'content-type': 'application/json', ...cors });
  res.end(Buffer.from(await up.arrayBuffer()));
}).listen(PROXY_PORT);

/** Plays frames [{dt, type, data}] on /events with their relative spacing divided by `speed`. */
async function play(frames, speed = 1) {
  let last = 0;
  for (const f of frames) {
    await sleep(Math.max(0, (f.dt - last) / speed));
    last = f.dt;
    emit(f.type, { ...f.data, owner });
  }
}
const guardFrames = () => {
  const g = readJson('../../agent/results/guard-demo-labeled.json');
  const t0 = g.timeline.find((x) => x.event === 'stress.marginMoved').t;
  return g.timeline.filter((x) => x.t >= t0).map((x) => ({ dt: x.t - t0, type: x.event, data: { ...x.detail, recorded: true } }));
};
const strategyFrames = () => {
  const out = [];
  let base = 0;
  for (const f of ['grid-live.json', 'twap-live.json']) {
    const evs = readJson(`../../agent/results/${f}`).events.filter((e) => e.type.startsWith('strategy.'));
    for (const e of evs) out.push({ dt: base + e.t, type: e.type, data: { ...e.data, recorded: true } });
    base += (evs.at(-1)?.t ?? 0) + 6000;
  }
  return out;
};

// ------------------------------------------------------------------ the browser
const browser = await chromium.launch();

// a warm-up pass (not recorded): Vite optimises its dependencies on the first load, which would show as a blank video
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(PAGE);
  await sleep(6000);
  await ctx.close();
}

mkdirSync(TMPV, { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: TMPV, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await installMockWallet(page, wallet);
const t0 = Date.now();
const mark = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}`);

// overlays: injected into the page, outside React's root; the first frame is already the title card
await page.addInitScript(() => {
  const paper = '#f4f1ea';
  const ink = '#1b1a17';
  const ready = () => {
    if (document.getElementById('demo-card')) return;
    const card = document.createElement('div');
    card.id = 'demo-card';
    card.style.cssText = `position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:18px;padding:64px;background:${ink};color:${paper};font:600 38px/1.3 system-ui,sans-serif;text-align:center;z-index:2147483647`;
    const cap = document.createElement('div');
    cap.id = 'demo-cap';
    cap.style.cssText = `position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:none;width:max-content;max-width:1080px;padding:13px 22px;background:${ink};color:${paper};font:600 22px/1.35 system-ui,sans-serif;text-align:center;border-radius:6px;box-shadow:0 2px 14px rgba(0,0,0,.4);z-index:2147483646`;
    const cur = document.createElement('div');
    cur.id = 'demo-cursor';
    cur.style.cssText = `position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid ${ink};background:rgba(244,241,234,.85);border-radius:50%;pointer-events:none;z-index:2147483645;transform:translate(640px,360px);transition:transform .55s ease-in-out;opacity:0`;
    document.documentElement.append(card, cap, cur);
    card.style.display = 'flex';
    card.innerHTML = `<div>HyperNear: smart accounts for Hyperliquid</div><div style="font-weight:400;font-size:26px;max-width:960px">Keys held by NEAR Chain Signatures.<br>Policy in a public NEAR contract.</div>`;
  };
  const pad = document.createElement('style');
  pad.textContent = 'main { padding-bottom: 640px !important; }';
  document.addEventListener('DOMContentLoaded', () => { document.head.append(pad); ready(); });
  if (document.readyState !== 'loading') ready();
});
const card = (html, small = '') => page.evaluate(([h, s]) => { const c = document.getElementById('demo-card'); c.innerHTML = h ? `<div>${h}</div>${s ? `<div style="font-weight:400;font-size:26px;max-width:980px">${s}</div>` : ''}` : ''; c.style.display = h ? 'flex' : 'none'; }, [html, small]);
const cap = (text) => page.evaluate((t) => { const c = document.getElementById('demo-cap'); c.textContent = t; c.style.display = t ? 'block' : 'none'; }, text);
/** Where the click happens: a ring glides to the element, pulses, then the real click is made. */
async function tap(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.evaluate(([x, y]) => { const c = document.getElementById('demo-cursor'); c.style.opacity = '1'; c.style.transform = `translate(${x}px, ${y}px)`; }, [b.x + b.width / 2, b.y + b.height / 2]);
  await sleep(750);
  await page.evaluate(() => { const c = document.getElementById('demo-cursor'); c.animate([{ boxShadow: '0 0 0 0 rgba(27,26,23,.5)' }, { boxShadow: '0 0 0 18px rgba(27,26,23,0)' }], { duration: 450 }); });
  await locator.click();
}
const scrollTo = async (sel, { at = 'top', offset = 16 } = {}) => {
  await page.evaluate(([s, a, o]) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const y = a === 'center' ? r.top + scrollY - (innerHeight - r.height) / 2 : r.top + scrollY - o;
    scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }, [sel, at, offset]);
  await sleep(1100);
};
const section = (id) => `section[aria-labelledby="${id}"]`;
const act = async (locator) => { await tap(locator); await sleep(350); return note(); };
const note = async () => { await page.locator('.notice').first().waitFor({ timeout: 25000 }); return page.locator('.notice').first().innerText(); };

// ---- GET /owner staged during setup; signed calls are real, the view moves after each (see the header)
let stage = 'nolegs';
let prepared;
const posts = [];
const BASE = `http://localhost:${PROXY_PORT}`;
await page.route(`${BASE}/owner/*`, async (route) => {
  const res = await route.fetch();
  const j = await res.json();
  const flat = (l) => ({ ...l, clearinghouse: { ...l.clearinghouse, assetPositions: [] } });
  if (stage === 'nolegs') { j.legs = []; j.snapshot.legs = []; j.pendingApprovals = []; j.guard = []; j.breakeven = []; }
  else if (stage !== 'live') {
    const keyOf = (leg) => prepared?.legs.find((l) => l.leg === leg)?.agent;
    const agentFor = (l) => (stage === 'unprepared' ? null : stage === 'prepared' ? { address: keyOf(l.leg).address, name: keyOf(l.leg).name, approvedAt: null } : l.agent);
    j.legs = j.legs.map((l) => ({ ...l, agent: agentFor(l), ...(stage === 'unprepared' ? { needsPrepare: true } : {}) }));
    j.snapshot.legs = j.snapshot.legs.map((l) => ({ ...(stage === 'unhedged' && l.leg === 0 ? l : flat(l)), agent: agentFor(l) }));
    j.pendingApprovals = stage === 'prepared' ? prepared.pendingApprovals : [];
    j.guard = []; j.breakeven = [];
  }
  await route.fulfill({ response: res, json: j });
});
// the real agent answers these; the staged view moves on before the page refreshes, so there is no idle wait
await page.route(`${BASE}/relay`, async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  if (body.sig && (await verify.intentSigner(body, CHAIN, CONTRACT)) !== owner) throw new Error(`relay signer mismatch on ${body.intent?.type}`);
  const res = await route.fetch();
  posts.push({ path: '/relay', body, status: res.status() });
  if (body.intent?.type === 'registerLeg' && posts.filter((p) => p.body.intent?.type === 'registerLeg').length >= 2) stage = 'unprepared';
  if (body.intent?.type === 'approveAgent' && posts.filter((p) => p.body.intent?.type === 'approveAgent').length >= 3) stage = 'unhedged';
  await route.fulfill({ response: res });
});
await page.route(`${BASE}/agents/prepare`, async (route) => {
  const res = await route.fetch();
  const text = await res.text();
  if (res.status() === 200) { prepared = JSON.parse(text); stage = 'prepared'; }
  await route.fulfill({ status: res.status(), headers: res.headers(), body: text });
});
await page.route(`${BASE}/hedge/open`, async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const who = await verify.commandSigner(body, CHAIN, CONTRACT);
  if (who !== owner || body.command.action !== 'openHedge') throw new Error('open hedge: unexpected signer or action');
  stage = 'live';
  emit('hedge', { owner, op: 'openHedge', coin: 'BTC', simulated: true });
  await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ plan: { ok: true }, simulatedFills: [{ leg: 1, oid: 0, totalSz: '0.0002', avgPx: '75698.5' }], dryRun: true }) });
});

await page.goto(PAGE);
mark('title card');
await sleep(4200);

// ---- 2. the problem
await card('A Hyperliquid master key is a bare EOA.', 'No withdrawal lock. No caps. No freeze.<br>Whoever holds the key can move everything.');
mark('problem');
await sleep(5000);

// ---- 3. log in
await card('');
await cap('Log in with a passkey, email or any wallet (Privy). Your wallet address owns every account below.');
await sleep(2600);
await tap(page.getByRole('button', { name: /Log in with/ }));
await page.getByText('Continue with a wallet').click({ timeout: 15000 });
await sleep(900);
await page.locator('#headlessui-portal-root').getByText('MetaMask').first().click({ timeout: 15000 });
await page.getByText(/Create legs/).first().waitFor({ timeout: 40000 });
await sleep(1200);
mark('logged in');

// ---- 3. setup
await cap('1. Create two Hyperliquid accounts. Their keys belong to the NEAR contract, not to us.');
await scrollTo(section('setup-h'), { offset: 12 });
await sleep(1500);
await act(page.getByRole('button', { name: 'Create legs' }));
await sleep(1300);
await cap('2. Prepare agents: the service makes one Hyperliquid trading key per leg. You sign the request.');
await act(page.getByRole('button', { name: 'Prepare agents' }));
await sleep(1300);
await cap('3. Approve each agent. The NEAR contract signs the Hyperliquid action via MPC. No key ever sits on our server.');
await act(page.getByRole('button', { name: 'Approve agent' }));
await sleep(2200);
mark('setup done');

// ---- 4. hedge
await cap('Open a hedge: leg 1 takes the opposite side of leg 0. You sign the command; it expires in 30 s.');
await scrollTo(section('hedge-h'), { offset: 14 });
await sleep(1400);
await act(page.getByRole('button', { name: 'Open hedge' }));
await sleep(1500);
await cap('Break-even of both legs together, with fees and funding, computed by the agent.');
await sleep(3200);
mark('hedge');

// ---- 5. the guard
await cap('The margin guard watches every leg. When one gets too close to liquidation it tops it up from the reserve leg.');
await scrollTo(section('ev-h'), { offset: 14 });
await sleep(2000);
const frames = guardFrames();
mark('guard timeline starts');
const mid = { trigger: frames.find((f) => f.type === 'guard.trigger').dt, signed: frames.find((f) => f.type === 'guard.rebalance.signed').dt, posted: frames.find((f) => f.type === 'guard.rebalance.posted').dt, recovered: frames.filter((f) => f.type === 'guard.ok').at(-1).dt };
const guardRun = play(frames, 1);
const at = (ms, text) => sleep(ms).then(() => cap(text));
await Promise.all([
  guardRun,
  (async () => {
    const t = Date.now();
    const wait = (ms) => sleep(Math.max(0, ms - (Date.now() - t)));
    await wait(mid.trigger - 200);
    await cap('Detected after +1.5 s: leg 1 is below its margin floor.');
    await wait(mid.signed - 300);
    await cap('The NEAR contract signed the transfer from the reserve leg: +10.3 s. Hyperliquid accepted it: +11.8 s. (live testnet run)');
    await wait(mid.recovered - 400);
    await cap('Leg 1 is safe again: +13.3 s. Capped by your daily limit and a cooldown, enforced on chain.');
  })(),
]);
await sleep(2600);
mark('guard done');

// ---- 6. a decision
await cap('The agent proposes an action. Jev answers first; Claude double-checks. A disagreement is flagged for you.');
await scrollTo(section('dec-h'), { at: 'center' });
const wantUntil = Date.now() + 60000;
while (held.proposals.length < 4 && Date.now() < wantUntil) await sleep(500);
const upTo = held.proposals.findIndex((e) => e.data.flagged && e.data.action !== 'hold' && e.data.source === 'disagree');
for (const e of held.proposals.slice(0, upTo + 1)) { emit('decision.proposed', { ...e.data }); await sleep(900); }
await sleep(2600);
await cap('Nothing runs until you sign. Accepting signs a command for this exact proposal.');
await sleep(1800);
await act(page.getByRole('button', { name: /Accept and sign/ }));
await cap('Accepted. The orders stay inside your order policy and the contract policy.');
await sleep(3000);
mark('decision');

// ---- 7. strategies (phase 2)
await cap('Strategies: describe one in plain words. A model drafts it. It never starts anything.');
await scrollTo(section('strat-h'), { offset: 12 });
await sleep(2200);
await tap(page.getByLabel('Your rules'));
await page.getByLabel('Your rules').pressSequentially(TEXT_GRID, { delay: 22 });
await sleep(500);
await tap(page.getByRole('button', { name: 'Draft strategy' }));
await page.locator('.draft h4', { hasText: 'Grid on BTC' }).waitFor({ timeout: 25000 });
await cap('The agent checks every number against your order policy and the contract policy, and shows the spec in words.');
await scrollTo('.draft', { at: 'center' });
await sleep(3400);
await cap('The hash is recomputed in your browser. You sign exactly this spec.');
await sleep(2600);
await act(page.getByRole('button', { name: 'Start strategy' }));
await cap('Started on its own leg, so its losses stay on that leg. The strategy log follows every order and fill.');
await scrollTo('#strat-list-h', { offset: 20 });
const sFrames = strategyFrames();
await Promise.all([play(sFrames, 14), sleep(8200)]); // the recorded runs last about 130 s; 14x keeps both on screen for 9 s
await sleep(800);
mark('strategies');

// ---- 8. freeze
await cap('Freeze: halts everything the contract signs and revokes the agents\' Hyperliquid trading keys.');
await scrollTo(section('setup-h'), { at: 'center' });
await sleep(1800);
await act(page.getByRole('button', { name: 'Freeze' }));
await sleep(800);
const rev = held.revoked[0];
if (rev) emit('agents.revoked', { ...rev.data });
await scrollTo(section('ev-h'), { offset: 14 });
await cap('Trading keys revoked on Hyperliquid: 3 of 3 legs.');
await sleep(2400);
await cap('In the live run, the old agent\'s next order was rejected 8.9 s after the freeze.');
await sleep(3000);
mark('freeze');

// ---- 9. end card
await cap('');
await card('Every claim tested live on NEAR + Hyperliquid testnet.', 'docs/claims.md<br><span style="font-size:30px;font-weight:600">github.com/OWNER/hypernear</span>');
mark('end card');
await sleep(6200);
const total = (Date.now() - t0) / 1000;
finishing = true;
await page.unrouteAll({ behavior: 'ignoreErrors' }); // a poll still in flight must not fail the shutdown
await ctx.close();
const vid = await page.video().path();
mkdirSync(OUT, { recursive: true });
copyFileSync(vid, join(OUT, 'hypernear-demo.webm'));
console.log(`done: ${total.toFixed(1)} s wall clock from the recording start (the file also holds the first blank frames of the page load); ${join(OUT, 'hypernear-demo.webm')}`);
await browser.close();
cleanup();
process.exit(0);

// Stand-in for `agent --dry-run --serve` while that does not exist: serves agent/fixtures through the agent's HTTP shapes
// (GET /owner/:addr, POST /relay, POST /hedge/*, SSE /events). Numbers come from the recorded fixtures, except the
// break-even fees, which are a flat 0.045% of notional and only exist to fill the card. Not shipped as the demo.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { breakeven } from '../../agent/src/breakeven.ts';

const CHAIN_TAG = process.env.VITE_CHAIN_TAG ?? 'near-testnet';
const CONTRACT = process.env.VITE_CONTRACT_ID ?? 'leash-spike-1107.testnet';
const outfile = join(tmpdir(), `hypernear-verify-${process.pid}.mjs`);
await build({ entryPoints: [new URL('./verify-entry.ts', import.meta.url).pathname.replace(/^/([A-Za-z]:)/, '$1')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' });
const verify = await import(outfile);

const fixture = JSON.parse(readFileSync(new URL(`../../agent/fixtures/${process.env.MOCK_FIXTURE === 'empty' ? 'flat' : (process.env.MOCK_FIXTURE ?? 'hedged')}.json`, import.meta.url), 'utf8'));
const port = Number(process.env.PORT ?? 8787);
const snap = fixture.snapshot;
const state = { frozen: false, agent: null, nonce: 0, registered: process.env.MOCK_FIXTURE === 'empty' ? [] : snap.legs.map((l) => l.leg) };

const dist = (px, liq) => (liq == null ? null : Math.abs(px - Number(liq)) / px);
function guard() {
  return snap.legs.flatMap((l) =>
    l.clearinghouse.assetPositions.filter((a) => Number(a.position.szi) !== 0).map(({ position: p }) => {
      const d = dist(Number(snap.market.mids[p.coin]), p.liquidationPx);
      const ratio = Number(l.clearinghouse.marginSummary.accountValue) / Number(l.clearinghouse.crossMaintenanceMarginUsed);
      const reasons = [...(ratio <= 2 ? ['margin_floor'] : []), ...(d !== null && d <= 0.0012 ? ['latency_move'] : [])];
      return { id: `leg${l.leg}:${p.coin}`, trigger: reasons.length > 0, reasons, distance: d, plausibleMove: 0.0012 };
    })
  );
}
function be() {
  const out = {};
  for (const coin of ['BTC']) {
    const legs = snap.legs.flatMap((l) => l.clearinghouse.assetPositions.filter((a) => a.position.coin === coin && Number(a.position.szi) !== 0).map(({ position: p }) => ({
      side: Number(p.szi) > 0 ? 'long' : 'short', size: Math.abs(Number(p.szi)), entryPx: Number(p.entryPx),
      feesPaid: Math.abs(Number(p.szi)) * Number(p.entryPx) * 0.00045, netFunding: Number(p.cumFunding.sinceOpen) })));
    if (legs.length < 2) continue;
    const mark = Number(snap.market.mids[coin]);
    const r = breakeven({ legs, closeFeeRate: 0.00045, markPx: mark });
    out[coin] = { breakeven: r, feesPaid: legs.reduce((t, l) => t + l.feesPaid, 0), netFunding: legs.reduce((t, l) => t + l.netFunding, 0) };
  }
  return out;
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};
const body = async (req) => { let s = ''; for await (const c of req) s += c; return JSON.parse(s || '{}'); };
let id = 0;
const subs = new Set();
const emit = (type, data) => { const e = { id: ++id, at: Date.now(), type, data }; for (const f of subs) f(e); return e; };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' }); return res.end(); }
  if (/^\/owner\//.test(url.pathname)) {
    const legs = snap.legs.filter((l) => state.registered.includes(l.leg));
    return send(res, 200, {
      dryRun: true, owner: url.pathname.slice(7),
      legs: legs.map((l) => ({ leg: l.leg, address: l.address, agent: l.agent })),
      snapshot: { ...snap, legs }, policy: { nonce: state.nonce, frozen: state.frozen, agent: state.agent, daily_cap: 50_000_000, cooldown_sec: 60, spent_today: 0 },
      orderPolicy: { maxLeverage: 5, maxNotionalUsd: 100, allowedCoins: ['BTC', 'ETH'], slippage: 0.03 }, guard: guard(), breakeven: be(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/relay') {
    const b = await body(req);
    if (b.intent.type === 'registerLeg') { state.registered.push(b.intent.leg); return send(res, 200, { kind: 'registerLeg', leg: b.intent.leg, dryRun: true, address: '0x0' }); }
    if ((await verify.intentSigner(b, CHAIN_TAG, CONTRACT)) !== b.owner) return send(res, 401, { error: 'bad signature (mock agent recovered a different signer)' });
    state.nonce++;
    if (b.intent.type === 'freeze') state.frozen = b.intent.frozen;
    if (b.intent.type === 'setPolicy') state.agent = b.intent.agent;
    emit('relay', { kind: 'ownerExecute', txHash: '0x' + 'ab'.repeat(32) });
    return send(res, 200, { kind: 'ownerExecute', dryRun: true, txHash: 'DRYRUN' + 'x'.repeat(38) });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/hedge/')) {
    const b = await body(req);
    if ((await verify.commandSigner(b, CHAIN_TAG, CONTRACT)) !== b.command.owner) return send(res, 401, { error: 'bad signature (mock agent recovered a different signer)' });
    emit('command', { owner: b.command.owner, action: b.command.action, coin: b.command.coin });
    return send(res, 200, { dryRun: true, plan: { ok: true } });
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    const write = (e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    subs.add(write);
    const owner = snap.owner;
    const script = [
      ['guard.ok', { owner, legs: ['leg0:BTC', 'leg1:BTC'] }],
      ['command', { owner, action: 'openHedge', coin: 'BTC' }],
      ['hedge', { owner, op: 'open', coin: 'BTC', ratio: 0.5, fill: { totalSz: '0.0002', avgPx: '75702.0' } }],
      ['guard.trigger', { owner, triggered: [{ id: 'leg1:BTC' }], plan: { kind: 'rebalance', reason: '' } }],
      ['guard.rebalance.start', { owner, amount: '3.2', fromLeg: 0, toLeg: 1 }],
      ['guard.rebalance.signed', { owner, txHash: '0x' + 'cd'.repeat(32), ms: 7800 }],
      ['guard.rebalance.posted', { owner, ms: 8900 }],
    ];
    if (!process.env.MOCK_NO_SCRIPT) script.forEach(([t, d], i) => setTimeout(() => emit(t, d), 400 + i * 300));
    req.on('close', () => subs.delete(write));
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(port, () => console.log(`mock agent on :${port}`));

// End to end in a real server process (testnet): plain language -> draft -> owner-signed start -> run -> strategy decision
// proposal -> owner-signed accept -> owner-signed stop. Everything goes over HTTP; the owner key signs the Commands.
//   set -a; . ~/secrets/api.env; set +a; NEAR_NETWORK=testnet node agent/scripts/builder-e2e-live.ts
// Needs leg 3 registered, funded and approved (agent/scripts/grid-live.ts). Spawns `node agent/src/server.ts` on :8799 with
// ANTHROPIC_API_KEY and TYPESAFE_API_KEY from the environment (never printed). Saves agent/results/builder-e2e-live.json and
// agent/results/strategy-decision-live.json.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, newCommand, type Command } from '@hypernear/client';
import { specHash } from '../src/strategy/spec.ts';

// well-known PUBLIC web3 test key: a testnet owner only, never funded on any real chain
const owner = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as Hex);
const OW = owner.address.toLowerCase() as Hex;
const PORT = 18400 + Math.floor(Math.random() * 500); // not a fixed port: other jobs on the box run servers too
const BASE = `http://127.0.0.1:${PORT}`;
const TEXT = 'Buy about 11 dollars of BTC four times, one buy every 15 seconds, never paying more than 2% above the current price. Close everything when I stop it.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (!process.env.ANTHROPIC_API_KEY || !process.env.TYPESAFE_API_KEY) throw new Error('ANTHROPIC_API_KEY and TYPESAFE_API_KEY must be set');
if (process.env.NEAR_NETWORK !== 'testnet') throw new Error('set NEAR_NETWORK=testnet');

const server = spawn(process.execPath, ['agent/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), HYPERNEAR_DATA_DIR: process.env.HYPERNEAR_DATA_DIR ?? `${homedir()}/.hypernear-agent-data`, HYPERNEAR_DECIDE_INTERVAL_SEC: '3600' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));

const get = async (path: string) => (await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) })).json() as Promise<any>;
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  return { status: r.status, body: (await r.json()) as any };
};
let chainTag: any;
let nonce = Date.now();
const sign = async (action: Command['action'], coin: string, hash?: string) => {
  nonce = Math.max(Date.now(), nonce + 1); // the Command's nonce and expiry both come from this
  const command = newCommand(OW, action, coin, '0', 30, nonce, hash as Hex | undefined);
  return { command, sig: await owner.signTypedData(commandTypedData(chainTag, 'leash-spike-1107.testnet', command) as never) };
};

// SSE collector
const sse: { type: string; data: any }[] = [];
const ctl = new AbortController();
async function collect() {
  const res = await fetch(`${BASE}/events`, { signal: ctl.signal });
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const m = /^data: (.*)$/m.exec(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (m) sse.push(JSON.parse(m[1]!));
    }
  }
}

const steps: Record<string, unknown> = {};
let ok = false;
try {
  for (let i = 0; ; i++) {
    try {
      chainTag = (await get(`/owner/${OW}`)).config.chainTag;
      break;
    } catch (e) {
      if (i > 60) throw new Error(`server did not come up: ${serverLog.slice(-400)}`);
      await sleep(1000);
    }
  }
  void collect().catch(() => {});

  // 1. draft
  const draft = await post('/strategy/draft', { owner: OW, text: TEXT });
  steps.draft = { status: draft.status, ...draft.body };
  console.log(`draft ${draft.status}: ${draft.body.ok ? `${draft.body.spec.type} ${JSON.stringify(draft.body.spec.params)} warnings ${JSON.stringify(draft.body.warnings)}` : JSON.stringify(draft.body.errors)}`);
  if (!draft.body.ok) throw new Error('draft refused');

  // 2. the owner signs the start over the draft's specHash; a different spec must not start
  const hash = draft.body.specHash as string;
  if (hash !== specHash(draft.body.spec)) throw new Error('specHash from the server differs from the local hash');
  const tampered = { ...draft.body.spec, params: { ...draft.body.spec.params, limitPx: draft.body.spec.params.limitPx + 1 } };
  const bad = await post('/strategy/start', { ...(await sign('startStrategy', '', hash)), spec: tampered });
  steps.startWithTamperedSpec = { status: bad.status, error: bad.body.error };
  const start = await post('/strategy/start', { ...(await sign('startStrategy', '', hash)), spec: draft.body.spec });
  steps.start = { status: start.status, ...start.body };
  console.log(`tampered spec -> ${bad.status}; signed start -> ${start.status} ${start.body.state ?? start.body.error}`);
  if (start.status !== 200) throw new Error('start refused');

  // 3. run to the end
  const id = draft.body.spec.id as string;
  for (let i = 0; i < 90; i++) {
    const s = (await get(`/strategies/${OW}`)).strategies.find((x: any) => x.id === id);
    if (s?.state === 'done') break;
    await sleep(2000);
  }
  const listed = (await get(`/strategies/${OW}`)).strategies.find((x: any) => x.id === id);
  steps.afterRun = listed;
  console.log(`run: ${listed?.state}, ${listed?.twap?.done}/${draft.body.spec.params.slices} slices`);

  // 4. strategy decision proposal, accepted by the owner
  const prop = await post('/decision/propose', { owner: OW, strategyId: id });
  steps.propose = { status: prop.status, ...prop.body };
  let proposed: any;
  for (let i = 0; i < 60 && !proposed; i++) {
    proposed = sse.find((e) => e.type === 'decision.proposed' && e.data.kind === 'strategy');
    if (!proposed) await sleep(1000);
  }
  if (!proposed) throw new Error(`no strategy proposal: ${JSON.stringify(prop)}`);
  console.log(`proposal: ${proposed.data.action} (${proposed.data.source}, ${proposed.data.model}, ${proposed.data.latencyMs} ms) ${proposed.data.rationale}`);
  const accept = await post(`/decision/${proposed.data.id}/accept`, await sign(proposed.data.action, proposed.data.coin));
  steps.accept = { status: accept.status, ...accept.body };
  console.log(`accept -> ${accept.status} ${JSON.stringify(accept.body).slice(0, 200)}`);

  // 5. stop (onStop flatten closes the position)
  const stop = await post('/strategy/stop', await sign('stopStrategy', id));
  steps.stop = { status: stop.status, ...stop.body };
  console.log(`stop -> ${stop.status} ${stop.body.state}`);
  await sleep(4000);
  ok = draft.status === 200 && bad.status === 401 && start.status === 200 && listed?.state === 'done' && accept.status === 200 && stop.status === 200;
} finally {
  const events = sse.filter((e) => /^(strategy|decision)\./.test(e.type)).map((e) => ({ type: e.type, data: e.data }));
  ctl.abort();
  server.kill();
  const result = { at: new Date().toISOString(), ok, owner: OW, text: TEXT, model: 'claude-sonnet-5-5', steps, events };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/builder-e2e-live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  const proposed = events.find((e) => e.type === 'decision.proposed' && (e.data as any).kind === 'strategy');
  if (proposed) {
    writeFileSync(
      new URL('../results/strategy-decision-live.json', import.meta.url),
      JSON.stringify({ at: result.at, via: 'agent server process: POST /decision/propose {strategyId}, then a signed accept on /decision/:id/accept', proposal: proposed.data, accept: steps.accept, events: events.filter((e) => e.type.startsWith('decision.')) }, null, 2) + '\n',
    );
  }
  console.log(`ok=${ok}`);
}
process.exit(ok ? 0 : 1);

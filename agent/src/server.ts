// HTTP API for the web app (node:http, no framework).
//   GET  /owner/:addr   legs, HL snapshot (incl. withdrawable), contract policy, guard evaluation
//   POST /relay         {owner, nonce, intent, sig} -> owner_execute (or {owner, intent:{type:'registerLeg', leg}})
//   POST /hedge/open    {command, sig}: owner-signed EIP-712 Command (action openHedge, expiry <= 60 s, fresh nonce)
//   POST /hedge/close   {command, sig}: same, action closeHedge. Both also need the owner's setPolicy opt-in.
//   GET  /events        SSE: hedge, guard and decision log
// The guard loop (guardLoop.ts) runs in the same process when the NEAR agent key is set.
// Run: node agent/src/server.ts            (keys from env, see config.ts)
//      node agent/src/server.ts --dry-run  (no keys, no network: replays agent/fixtures/)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Hex } from 'viem';
import { HyperNearClient, nearAccount } from '@hypernear/client';
import { loadConfig, type AgentConfig } from './config.ts';
import { EventBus } from './events.ts';
import { ReplayCache, verifyCommand } from './commands.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard, type GuardConfig } from './guard.ts';
import { GuardLoop } from './guardLoop.ts';
import { HedgeRefused, Hedger } from './hedge.ts';
import { guardInputs, Legs } from './legs.ts';
import { HttpError, RateLimiter, Relayer } from './relayer.ts';

export interface Deps {
  config: AgentConfig;
  client: HyperNearClient;
  legs: Legs;
  hedger: Hedger;
  relayer: Relayer;
  bus: EventBus;
  replay: ReplayCache;
  guardConfig: GuardConfig;
  guardLoop?: GuardLoop;
  annualVol?: number;
}

const ADDR = /^0x[0-9a-f]{40}$/;
const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function ownerOf(v: unknown): Hex {
  if (typeof v !== 'string' || !ADDR.test(v.toLowerCase())) throw new HttpError(400, 'owner must be a 0x address');
  return v.toLowerCase() as Hex;
}

/** The owner opted in when its contract policy names an agent (ours, when we know our NEAR agent account). */
async function assertOptedIn(d: Deps, owner: Hex) {
  const st = await d.client.getOwner(owner);
  const ours = d.config.nearAgent?.accountId;
  if (!st?.agent || (ours && st.agent !== ours)) throw new HttpError(403, 'owner has not opted this agent in (setPolicy)');
  if (st.frozen) throw new HttpError(403, 'owner is frozen');
}

export function handler(d: Deps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
        return res.end();
      }
      const ownerPath = /^\/owner\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
      if (req.method === 'GET' && ownerPath) {
        const owner = ownerOf(ownerPath[1]);
        const [snapshot, policy] = await Promise.all([d.legs.snapshot(owner), d.client.getOwner(owner)]);
        const guard = evaluateGuard(guardInputs(snapshot, d.annualVol ?? 0.6), d.guardConfig);
        return send(res, 200, {
          owner,
          legs: snapshot.legs.map((l) => ({ leg: l.leg, address: l.address, agent: l.agent })),
          snapshot,
          policy,
          orderPolicy: d.config.policy,
          guard,
        });
      }
      if (req.method === 'POST' && url.pathname === '/relay') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const out = await d.relayer.relay(ip, await readJson(req));
        d.bus.emit('relay', out);
        return send(res, 200, out);
      }
      if (req.method === 'POST' && (url.pathname === '/hedge/open' || url.pathname === '/hedge/close')) {
        const open = url.pathname === '/hedge/open';
        const cmd = await verifyCommand(
          { chainTag: async () => (await d.client.getConfig()).chain_tag, contractId: d.client.contractId, cache: d.replay },
          await readJson(req),
          open ? 'openHedge' : 'closeHedge'
        );
        await assertOptedIn(d, cmd.owner);
        d.bus.emit('command', { ...cmd });
        const out = open ? await d.hedger.openHedge(cmd.owner, cmd.coin, Number(cmd.ratio)) : await d.hedger.closeHedge(cmd.owner, cmd.coin);
        return send(res, 200, out);
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
        const write = (e: { id: number; type: string }) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        d.bus.since(Number(req.headers['last-event-id'] ?? 0)).forEach(write);
        const off = d.bus.subscribe(write);
        req.on('close', off);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof HedgeRefused ? 422 : 500;
      if (status === 500) console.error('request failed:', (e as Error).message);
      send(res, status, { error: (e as Error).message });
    }
  };
}

export function buildDeps(config: AgentConfig): Deps {
  const rpc = config.nearRpcUrl;
  const sender = config.relayer && nearAccount(config.relayer.accountId, config.relayer.secretKey, rpc ?? (config.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'));
  const client = new HyperNearClient({ contractId: config.contractId, network: config.network, rpcUrl: rpc, sender });
  const bus = new EventBus();
  const legs = new Legs({ client, dataDir: config.dataDir, network: config.network, coins: config.policy.allowedCoins });
  const guardConfig: GuardConfig = { ...DEFAULT_GUARD_CONFIG, marginFloorMultiple: config.guard.marginFloor, latencyP95Sec: config.guard.latencyP95Sec };
  // the guard signs rebalances with the NEAR agent's function-call key, never with the relayer's
  const agentSender = config.nearAgent && nearAccount(config.nearAgent.accountId, config.nearAgent.secretKey, rpc ?? (config.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'));
  const guardLoop = new GuardLoop({
    legs,
    bus,
    agentId: config.nearAgent?.accountId,
    agentClient: agentSender && new HyperNearClient({ contractId: config.contractId, network: config.network, rpcUrl: rpc, sender: agentSender }),
    owners: () => [...new Set([...legs.keys.owners(), ...config.guard.watchOwners])] as Hex[],
    cfg: { intervalMs: config.guard.intervalSec * 1000, guard: guardConfig, annualVol: config.guard.annualVol },
  });
  return {
    config, client, legs, bus, guardConfig, guardLoop, annualVol: config.guard.annualVol,
    replay: new ReplayCache(),
    hedger: new Hedger(legs, config.policy, bus),
    relayer: new Relayer(client, new RateLimiter(config.relayPerMinute)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--dry-run')) {
    const { runDryRun } = await import('./dryrun.ts');
    runDryRun();
  } else {
    const config = loadConfig();
    const deps = buildDeps(config);
    const server = createServer(handler(deps));
    if (config.nearAgent) deps.guardLoop?.start();
    server.listen(config.port, () => {
      console.log(`hypernear agent on :${config.port} (${config.network}, contract ${config.contractId}, relayer ${config.relayer ? 'set' : 'MISSING'}, ` +
        `near agent ${config.nearAgent ? 'set, guard loop on' : 'MISSING, guard loop off'})`);
    });
  }
}

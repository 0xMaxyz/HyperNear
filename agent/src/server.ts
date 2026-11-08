// HTTP API for the web app (node:http, no framework).
//   GET  /owner/:addr   legs, HL snapshot (incl. withdrawable), contract policy, guard evaluation
//   POST /relay         {owner, nonce, intent, sig} -> owner_execute (or {owner, intent:{type:'registerLeg', leg}})
//   POST /hedge/open    {command, sig}: owner-signed EIP-712 Command (action openHedge, expiry <= 60 s, fresh nonce)
//   POST /hedge/close   {command, sig}: same, action closeHedge. Both also need the owner's setPolicy opt-in.
//   POST /decision/propose        {owner, strategyId?}: queue a proposal now (with strategyId: pause/continue/adjust for that running strategy; accept = pause) (202; it arrives on /events as decision.proposed)
//   POST /agents/prepare          {command, sig}: action prepareAgents; creates one HL agent key per registered leg and
//                                 enrols the owner in the guard/decision loops (GET /owner never creates state)
//   POST /decision/:id/accept     {command, sig}: command.action/coin must equal the proposal's; executed within the order policy
//   POST /decision/:id/reject     {command, sig}: action reject, coin = the proposal's; emits decision.rejected {reason:'owner'}
//   POST /decision/mode           {command, sig}: action setDecisionMode, mode ('off'|'propose'|'auto') in command.coin
//   POST /strategy/start  {command, sig, spec}: action startStrategy, command.specHash = specHash(validated spec)
//   POST /strategy/resume {command, sig}: action startStrategy, command.coin = strategy id, command.specHash = hash of the stored spec of a paused/restored strategy
//   POST /strategy/pause|stop {command, sig}: action pauseStrategy|stopStrategy, command.coin = strategy id (kill switch)
//   GET  /strategies/:owner  the owner's strategies (state, held levels, resting orders, dead-man status)
//   POST /strategy/draft  {owner, text}: plain language -> {spec, specHash, diff, warnings} (Claude drafts, spec.ts validates; starts nothing)
//   (after a relayed freeze the server clears resting orders through the contract's cancel_orders and emits orders.swept)
//   GET  /events        SSE: hedge, guard and decision log
// The guard loop (guardLoop.ts) runs in the same process when the NEAR agent key is set.
// Run: node agent/src/server.ts            (keys from env, see config.ts)
//      node agent/src/server.ts --dry-run  (no keys, no network: prints what hedge + guard would do on agent/fixtures/)
//      node agent/src/server.ts --dry-run --serve  (same HTTP API from the fixtures, every response marked dryRun: true)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Hex } from 'viem';
import { HyperNearClient, nearAccount } from '@hypernear/client';
import { loadConfig, type AgentConfig } from './config.ts';
import { EventBus } from './events.ts';
import { ReplayCache, verifyCommand } from './commands.ts';
import { DEFAULT_GUARD_CONFIG, evaluateGuard, type GuardConfig } from './guard.ts';
import { GuardLoop } from './guardLoop.ts';
import { HedgeRefused, Hedger } from './hedge.ts';
import { guardInputs, Legs, pendingApprovals, type OwnerSnapshot } from './legs.ts';
import { claudeEscalator } from './claude.ts';
import { ACTION_IDS, proposeAction, type Action } from './decide.ts';
import { Decider, DECISION_MODES, DecisionModes, proposalEvent, type DecisionMode } from './decisions.ts';
import { jevAsk } from './jev.ts';
import { breakevens, openTime, readPnlData, type LegPnlData } from './pnl.ts';
import { hlPoster, HttpError, RateLimiter, Relayer } from './relayer.ts';
import { livePorts, sweepFrozen, sweptEvent, type LegSweep } from './sweep.ts';
import { claudeAsk, drafter, MAX_DRAFT_TEXT, type Draft } from './strategy/builder.ts';
import { proposeStrategyAction, type StrategyClients } from './strategy/decide.ts';
import { claudeStrategyEscalator, jevAskStrategy } from './strategy/decideClients.ts';
import { StartConflict, StrategyManager } from './strategy/manager.ts';
import { specHash } from './strategy/spec.ts';
import { bootTee, enrollTeeOwner, hlLedgerPort, OwnerScope, shadeBackend } from './tee.ts';

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
  /** proposals, accept, modes; its loop runs only with TYPESAFE_API_KEY and ANTHROPIC_API_KEY set (or in the dry run) */
  decider?: Decider;
  /** Phase 2 strategy runners (absent in the dry run) */
  strategies?: StrategyManager;
  /** after a relayed freeze: clear every leg's resting orders through the contract's cancel_orders (absent: no sweep) */
  sweeper?: (owner: Hex) => Promise<LegSweep[]>;
  /** plain language -> validated spec draft (needs ANTHROPIC_API_KEY) */
  drafter?: (owner: Hex, text: string) => Promise<Draft>;
  annualVol?: number;
  /** which owners this process serves (server: not in TEE mode; tee: paid TEE owners of this image). Absent in the dry run. */
  scope?: OwnerScope;
  /** tee mode: the agent account's contract client (shade-agent-js signs), its account and registered measurement hash */
  tee?: TeeRuntime;
  /** fills, fee rate, funding per leg for the break-even (default: read from HL) */
  pnlData?: (s: OwnerSnapshot) => Promise<LegPnlData[]>;
  /** --dry-run --serve: no NEAR/HL calls; commands are verified, then simulated */
  dryRun?: DryRunHooks;
}

export interface TeeRuntime {
  client: HyperNearClient;
  account: string;
  measurementHash: string;
}

export interface DryRunHooks {
  hedge: (action: 'openHedge' | 'closeHedge', owner: Hex, coin: string, ratio: number) => Promise<Record<string, unknown>>;
  relay: (body: unknown) => Promise<Record<string, unknown>>;
  /** replays the scripted guard sequence to one SSE client; returns a stop function */
  replayEvents: (write: (e: { id: number; type: string; at: number; data: Record<string, unknown> }) => void) => () => void;
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

function send(res: ServerResponse, status: number, body: unknown, dryRun = false) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  const out = dryRun && body && typeof body === 'object' ? { ...(body as object), dryRun: true } : body;
  res.end(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function ownerOf(v: unknown): Hex {
  if (typeof v !== 'string' || !ADDR.test(v.toLowerCase())) throw new HttpError(400, 'owner must be a 0x address');
  return v.toLowerCase() as Hex;
}

/** The owner opted in when its contract policy names an agent (ours, when we know our NEAR agent account). */
async function assertOptedIn(d: Deps, owner: Hex) {
  await assertServed(d, owner);
  const st = await d.client.getOwner(owner);
  const ours = d.config.nearAgent?.accountId;
  // a TEE agent's account is new on every boot, so the contract (not this check) decides who may rebalance for a TEE owner
  const tee = d.scope?.mode === 'tee';
  if (!st || (!tee && (!st.agent || (ours && st.agent !== ours)))) throw new HttpError(403, 'owner has not opted this agent in (setPolicy)');
  if (st.frozen) throw new HttpError(403, 'owner is frozen');
}

/** server mode refuses owners who chose TEE; tee mode refuses everyone who is not a paid TEE owner of this image. */
async function assertServed(d: Deps, owner: Hex) {
  if (!d.scope) return;
  const ok = await d.scope.serves(owner).catch((e) => {
    throw new HttpError(503, `cannot tell whether this agent serves ${owner}: ${(e as Error).message}`);
  });
  if (!ok) throw new HttpError(403, d.scope.mode === 'tee' ? 'owner is not a paid TEE owner of this image (setTee, payTee)' : 'owner runs in TEE mode: use the TEE agent');
}

const verifier = (d: Deps) => ({ chainTag: async () => (await d.client.getConfig()).chain_tag, contractId: d.client.contractId, cache: d.replay });

export function handler(d: Deps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const reply = (status: number, body: unknown) => send(res, status, body, Boolean(d.dryRun));
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
        return res.end();
      }
      const ownerPath = /^\/owner\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
      if (req.method === 'GET' && ownerPath) {
        const owner = ownerOf(ownerPath[1]);
        const [snapshot, policy, cfg] = await Promise.all([d.legs.snapshot(owner), d.client.getOwner(owner), d.client.getConfig()]);
        const guard = evaluateGuard(guardInputs(snapshot, d.annualVol ?? 0.6), d.guardConfig);
        const breakeven = breakevens(snapshot, await (d.pnlData ?? ((s) => readPnlData(d.legs.hl, s)))(snapshot));
        const latest = d.decider?.latest(owner);
        return reply(200, {
          owner,
          config: { contractId: d.client.contractId, chainTag: cfg.chain_tag, agentAccount: d.config.nearAgent?.accountId ?? null, hlNetwork: cfg.hl_mainnet ? 'mainnet' : 'testnet' },
          legs: snapshot.legs.map((l) => ({ leg: l.leg, address: l.address, agent: l.agent && { address: l.agent.address, name: l.agent.name, approvedAt: l.agent.approvedAt ?? null } })),
          // GET never creates state: keys appear after the owner's signed prepareAgents
          needsPrepare: snapshot.legs.some((l) => !l.agent),
          pendingApprovals: pendingApprovals(snapshot),
          snapshot,
          policy,
          orderPolicy: d.config.policy,
          guard,
          breakeven,
          decision: d.decider && { mode: d.decider.d.modes.get(owner), latest: latest ? { ...proposalEvent(latest), status: latest.status, at: latest.at } : null },
        });
      }
      if (req.method === 'POST' && url.pathname === '/relay') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (d.dryRun) {
          if (!d.relayer.limiter.allow(ip)) throw new HttpError(429, 'rate limited');
          return reply(200, await d.dryRun.relay(await readJson(req)));
        }
        const out = await d.relayer.relay(ip, await readJson(req));
        d.bus.emit('relay', out);
        // the sweep for orders that survived the revocation: after the freeze answer is built, off the response path, reported on /events
        if (out.kind === 'freeze' && d.sweeper) {
          const t0 = Date.now();
          d.sweeper(out.owner).then(
            (legs) => d.bus.emit('orders.swept', sweptEvent(out.owner, legs, Date.now() - t0)),
            (e) => d.bus.emit('orders.swept', sweptEvent(out.owner, [], Date.now() - t0, (e as Error).message)),
          );
        }
        if (out.kind === 'approveAgent' && out.ok && d.legs.keys.get(out.owner, out.leg)?.address === out.agent) d.legs.keys.markApproved(out.owner, out.leg);
        // a revoked key is never approved again: the next /owner shows a fresh key to approve
        if (out.kind === 'freeze') for (const r of out.revoked) if (r.ok && d.legs.keys.get(out.owner, r.leg)) d.legs.keys.ensure(out.owner, r.leg, true);
        return reply(200, out);
      }
      if (req.method === 'POST' && url.pathname === '/agents/prepare') {
        const cmd = await verifyCommand(verifier(d), await readJson(req), 'prepareAgents');
        await assertServed(d, cmd.owner);
        if (d.tee) {
          // TEE mode: fresh in-memory keys, approved by the contract (tee_approve_agent); the owner signs nothing more
          const res = await enrollTeeOwner({ legs: d.legs, client: d.tee.client, post: d.relayer.post!, owner: cmd.owner }).catch((e) => {
            throw new HttpError(403, (e as Error).message);
          });
          d.bus.emit('agents.prepared', { owner: cmd.owner, tee: true, legs: res.map((l) => ({ leg: l.leg, agent: l.agent, ok: l.ok })) });
          return reply(200, { owner: cmd.owner, tee: true, legs: res, pendingApprovals: [] });
        }
        const legs = await d.legs.prepare(cmd.owner).catch((e) => {
          throw new HttpError(403, (e as Error).message);
        });
        d.bus.emit('agents.prepared', { owner: cmd.owner, legs: legs.map((l) => ({ leg: l.leg, agent: l.agent.address })) });
        return reply(200, { owner: cmd.owner, legs, pendingApprovals: pendingApprovals({ legs } as unknown as OwnerSnapshot) });
      }
      if (req.method === 'POST' && url.pathname === '/decision/propose') {
        if (!d.relayer.limiter.allow(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, 'rate limited');
        if (!d.decider || (!d.dryRun && !d.config.decide.live)) throw new HttpError(503, 'decision layer off (TYPESAFE_API_KEY and ANTHROPIC_API_KEY not set)');
        const body = (await readJson(req)) as { owner?: unknown; forceAction?: unknown; strategyId?: unknown };
        const owner = ownerOf(body?.owner);
        if (body?.strategyId !== undefined) {
          if (typeof body.strategyId !== 'string') throw new HttpError(400, 'strategyId must be a string');
          const sp = await d.decider.prepareStrategies(owner, body.strategyId);
          if ('skipped' in sp) throw new HttpError(409, sp.skipped);
          for (const input of sp.inputs) void d.decider.runStrategy(input).catch((e) => console.error('strategy proposal failed:', (e as Error).message));
          return reply(202, { owner, strategyId: body.strategyId, queued: true });
        }
        // test-only override for live checks of the execution path; refused unless the process runs with HYPERNEAR_TEST=1
        const force = body?.forceAction;
        if (force !== undefined && (process.env.HYPERNEAR_TEST !== '1' || !ACTION_IDS.includes(force as Action))) throw new HttpError(400, 'forceAction is test-only (HYPERNEAR_TEST=1) and must be a decision action');
        const p = await d.decider.prepare(owner);
        if ('skipped' in p) throw new HttpError(409, p.skipped);
        void d.decider.run(p.input, force as Action | undefined).catch((e) => console.error('proposal failed:', (e as Error).message));
        return reply(202, { owner, coin: p.input.coin, queued: true });
      }
      if (req.method === 'POST' && url.pathname === '/decision/mode') {
        if (!d.decider) throw new HttpError(503, 'decision layer off');
        const cmd = await verifyCommand(verifier(d), await readJson(req), 'setDecisionMode');
        const mode = cmd.coin as DecisionMode;
        if (!DECISION_MODES.includes(mode)) throw new HttpError(400, `mode (command.coin) must be one of ${DECISION_MODES.join(', ')}`);
        if (mode === 'auto') await assertOptedIn(d, cmd.owner);
        d.decider.d.modes.set(cmd.owner, mode);
        d.bus.emit('decision.mode', { owner: cmd.owner, mode });
        return reply(200, { owner: cmd.owner, mode });
      }
      const decision = /^\/decision\/([\w-]{1,64})\/(accept|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && decision) {
        if (!d.decider) throw new HttpError(503, 'decision layer off');
        const [, id, verb] = decision as unknown as [string, string, 'accept' | 'reject'];
        const cmd = await verifyCommand(verifier(d), await readJson(req), verb === 'reject' ? 'reject' : d.decider.get(id).proposal.action);
        if (verb === 'reject') return reply(200, d.decider.reject(id, cmd));
        await assertOptedIn(d, cmd.owner);
        return reply(200, await d.decider.accept(id, cmd));
      }
      if (req.method === 'POST' && (url.pathname === '/hedge/open' || url.pathname === '/hedge/close')) {
        const open = url.pathname === '/hedge/open';
        const cmd = await verifyCommand(verifier(d), await readJson(req), open ? 'openHedge' : 'closeHedge');
        await assertOptedIn(d, cmd.owner);
        d.bus.emit('command', { ...cmd });
        if (d.dryRun) return reply(200, await d.dryRun.hedge(open ? 'openHedge' : 'closeHedge', cmd.owner, cmd.coin, Number(cmd.ratio)));
        const out = open ? await d.hedger.openHedge(cmd.owner, cmd.coin, Number(cmd.ratio)) : await d.hedger.closeHedge(cmd.owner, cmd.coin);
        return reply(200, out);
      }
      const strategies = /^\/strategies\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
      if (req.method === 'GET' && strategies) {
        if (!d.strategies) throw new HttpError(503, 'strategies off');
        const owner = ownerOf(strategies[1]);
        return reply(200, { owner, strategies: d.strategies.list(owner) });
      }
      if (req.method === 'POST' && url.pathname === '/strategy/draft') {
        if (!d.relayer.limiter.allow(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, 'rate limited');
        if (!d.drafter) throw new HttpError(503, 'strategy builder off (ANTHROPIC_API_KEY not set)');
        const b = (await readJson(req)) as { owner?: unknown; text?: unknown };
        if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_DRAFT_TEXT) throw new HttpError(400, `text must be 1-${MAX_DRAFT_TEXT} characters`);
        const draft = await d.drafter(ownerOf(b.owner), b.text);
        return reply(draft.ok ? 200 : 422, draft);
      }
      if (req.method === 'POST' && url.pathname === '/strategy/start') {
        if (!d.strategies) throw new HttpError(503, 'strategies off');
        const body = (await readJson(req)) as { spec?: unknown };
        const cmd = await verifyCommand(verifier(d), body, 'startStrategy');
        await assertOptedIn(d, cmd.owner);
        const v = await d.strategies.validate(cmd.owner, body.spec);
        if (!v.ok) throw new HttpError(422, v.errors.join('; '));
        if (specHash(v.spec) !== cmd.specHash) throw new HttpError(401, 'command.specHash must be the specHash of the spec (the owner signed another spec)');
        d.bus.emit('command', { ...cmd });
        return reply(200, await d.strategies.start(cmd.owner, v.spec));
      }
      if (req.method === 'POST' && url.pathname === '/strategy/resume') {
        if (!d.strategies) throw new HttpError(503, 'strategies off');
        const cmd = await verifyCommand(verifier(d), await readJson(req), 'startStrategy');
        await assertOptedIn(d, cmd.owner);
        const stored = d.strategies.get(cmd.owner, cmd.coin);
        if (!stored) throw new HttpError(404, `no strategy ${cmd.coin} for ${cmd.owner}`);
        if (specHash(stored) !== cmd.specHash) throw new HttpError(401, 'command.specHash is not the hash of the stored spec');
        const v = await d.strategies.validate(cmd.owner, stored); // contract policy again; only a paused strategy passes
        if (!v.ok) throw new HttpError(422, v.errors.join('; '));
        d.bus.emit('command', { ...cmd });
        return reply(200, await d.strategies.start(cmd.owner, v.spec));
      }
      const strategyOp = /^\/strategy\/(pause|stop)$/.exec(url.pathname);
      if (req.method === 'POST' && strategyOp) {
        if (!d.strategies) throw new HttpError(503, 'strategies off');
        const stop = strategyOp[1] === 'stop';
        const cmd = await verifyCommand(verifier(d), await readJson(req), stop ? 'stopStrategy' : 'pauseStrategy');
        d.bus.emit('command', { ...cmd });
        const out = await (stop ? d.strategies.stop(cmd.owner, cmd.coin) : d.strategies.pause(cmd.owner, cmd.coin)).catch((e) => {
          throw new HttpError(404, (e as Error).message);
        });
        return reply(200, out);
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
        const write = (e: { id: number; type: string }) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        d.bus.since(Number(req.headers['last-event-id'] ?? 0)).forEach(write);
        const off = d.bus.subscribe(write);
        const stop = d.dryRun?.replayEvents(write);
        req.on('close', () => {
          off();
          stop?.();
        });
        return;
      }
      reply(404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof HedgeRefused ? 422 : e instanceof StartConflict ? 409 : 500;
      if (status === 500) console.error('request failed:', (e as Error).message);
      reply(status, { error: (e as Error).message });
    }
  };
}

export function buildDeps(config: AgentConfig, tee?: TeeRuntime): Deps {
  const rpc = config.nearRpcUrl;
  const sender = config.relayer && nearAccount(config.relayer.accountId, config.relayer.secretKey, rpc ?? (config.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'));
  const client = new HyperNearClient({ contractId: config.contractId, network: config.network, rpcUrl: rpc, sender });
  const bus = new EventBus();
  // tee mode: HL agent keys live in memory only
  const legs = new Legs({ client, dataDir: tee ? null : config.dataDir, network: config.network, coins: config.policy.allowedCoins });
  const scope = new OwnerScope({
    mode: tee ? 'tee' : 'server',
    client,
    legAddresses: async (o) => (await legs.registered(o)).map((l) => l.address),
    ledger: hlLedgerPort(legs.hl),
    measurement: () => tee?.measurementHash,
  });
  const allOwners = () => [...new Set([...legs.keys.owners(), ...config.guard.watchOwners])] as Hex[];
  const guardConfig: GuardConfig = { ...DEFAULT_GUARD_CONFIG, marginFloorMultiple: config.guard.marginFloor, latencyP95Sec: config.guard.latencyP95Sec };
  // the guard signs rebalances with the NEAR agent's function-call key, never with the relayer's
  const agentSender = config.nearAgent && nearAccount(config.nearAgent.accountId, config.nearAgent.secretKey, rpc ?? (config.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'));
  const guardLoop = new GuardLoop({
    legs,
    bus,
    agentId: tee ? undefined : config.nearAgent?.accountId,
    agentClient: tee ? tee.client : agentSender && new HyperNearClient({ contractId: config.contractId, network: config.network, rpcUrl: rpc, sender: agentSender }),
    owners: () => scope.filter(allOwners()),
    // a strategy leg is topped up only from the reserve leg and within the strategy's own daily budget
    budgetLeftUsd: (o, leg) => d.strategies?.topUpLeft(o, leg),
    onTopUp: (o, leg, usd) => d.strategies?.recordTopUp(o, leg, usd),
    cfg: { intervalMs: config.guard.intervalSec * 1000, guard: guardConfig, annualVol: config.guard.annualVol },
  });
  const hedger = new Hedger(legs, config.policy, bus);
  const d: Deps = {
    config, client, legs, bus, guardConfig, guardLoop, scope, tee, annualVol: config.guard.annualVol, hedger,
    replay: new ReplayCache(),
    relayer: new Relayer(client, new RateLimiter(config.relayPerMinute), hlPoster(config.network), bus),
  };
  const clients = config.decide.live ? { ask: jevAsk(), escalate: claudeEscalator() } : undefined;
  d.decider = new Decider({
    legs, bus, policy: config.policy, annualVol: config.guard.annualVol,
    modes: new DecisionModes(config.dataDir),
    propose: (i) => (clients ? proposeAction(i.state, i.ctx, clients) : Promise.reject(new Error('decision layer off'))),
    execute: (owner, action, coin, orders) => hedger.runOrders(owner, action, coin, orders),
    checkOwner: (owner) => assertOptedIn(d, owner),
    owners: () => scope.filter(allOwners()),
    openedAt: async (s, coin) => openTime((await readPnlData(legs.hl, s)).find((x) => x.leg === 1)?.fills ?? [], coin),
    intervalMs: config.decide.intervalSec * 1000,
    // strategy decisions (propose only): accept pauses the strategy
    proposeStrategy: (i) => (clients ? proposeStrategyAction(i, strategyClients!) : Promise.reject(new Error('decision layer off'))),
    strategyInputs: async (owner, id) => await d.strategies!.inputs(owner, await legs.snapshot(owner), config.guard.annualVol, id),
    executeStrategy: (owner, id) => d.strategies!.pause(owner, id, 'accepted strategy proposal'),
  });
  const strategyClients: StrategyClients | undefined = clients && { ask: jevAskStrategy(), escalate: claudeStrategyEscalator() };
  const strategies = new StrategyManager({ legs, client, policy: config.policy, agentId: tee ? undefined : config.nearAgent?.accountId, hedgeReserveUsd: config.guard.hedgeReserveUsd, dataDir: config.dataDir, served: (o) => scope.stillServes(o), emit: (t, data) => void bus.emit(t, data) });
  d.strategies = strategies;
  if (config.relayer) d.sweeper = (owner) => sweepFrozen(owner, livePorts({ client, hl: legs.hl, network: config.network }));
  if (process.env.ANTHROPIC_API_KEY) {
    d.drafter = drafter({
      ask: claudeAsk(),
      context: (owner, selfId) => strategies.context(owner, selfId),
      current: (owner, id) => strategies.get(owner, id),
      strategies: (owner) => strategies.specs(owner),
      mids: async () => (await legs.hl.allMids()) as Record<string, string>,
      keyReady: (owner, leg) => Boolean(legs.keys.get(owner, leg)?.approvedAt),
    });
  }
  // freeze: cancel resting strategy orders before the revocations kill the agent keys
  d.relayer.onBeforeRevoke = (owner) => d.strategies!.cancelAll(owner);
  return d;
}

/** TEE boot: the agent's own NEAR account and attestation from shade-agent-js, registered with the contract. Nothing secret is stored. */
async function bootTeeRuntime(config: AgentConfig): Promise<TeeRuntime> {
  const { ShadeClient } = await import('@neardefi/shade-agent-js');
  const shade = await ShadeClient.create({
    networkId: config.network,
    agentContractId: config.contractId,
    sponsor: config.relayer && { accountId: config.relayer.accountId, privateKey: config.relayer.secretKey },
  });
  const rpc = config.nearRpcUrl ?? (config.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com');
  const client = new HyperNearClient({ contractId: config.contractId, network: config.network, backend: shadeBackend(shade as never, config.contractId, rpc) });
  const { account, measurementHash } = await bootTee({ shade: shade as never, client, dev: config.tee.dev, expected: config.tee.measurement, fundNear: config.tee.fundNear });
  console.log(`hypernear TEE agent ${account} registered, measurement ${measurementHash}${config.tee.dev ? ' (DEV: no quote)' : ''}`);
  return { client, account, measurementHash };
}

/** TEE boot, step 2: owners named in HYPERNEAR_WATCH_OWNERS that are paid TEE owners get keys now; the others enrol through /agents/prepare. */
async function enrollWatched(d: Deps) {
  for (const owner of d.config.guard.watchOwners as Hex[]) {
    if (!(await d.scope!.serves(owner).catch(() => false))) continue;
    await enrollTeeOwner({ legs: d.legs, client: d.tee!.client, post: d.relayer.post!, owner }).then(
      (r) => console.log(`TEE keys for ${owner}: ${r.map((l) => `leg${l.leg} ${l.ok ? 'approved' : 'FAILED'}`).join(', ')}`),
      (e) => console.error(`TEE enrol of ${owner} failed:`, (e as Error).message),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--dry-run') && process.argv.includes('--serve')) {
    const { buildDryRunDeps } = await import('./dryrun.ts');
    const port = Number(process.env.PORT ?? 8787);
    const deps = buildDryRunDeps(process.env.HYPERNEAR_DRY_FIXTURE ?? 'hedged');
    createServer(handler(deps)).listen(port, () => console.log(`hypernear agent DRY RUN on :${port}: fixtures, no keys, no network`));
  } else if (process.argv.includes('--dry-run')) {
    const { runDryRun } = await import('./dryrun.ts');
    runDryRun();
  } else {
    const config = loadConfig();
    const tee = config.runMode === 'tee' ? await bootTeeRuntime(config) : undefined;
    const deps = buildDeps(config, tee);
    const server = createServer(handler(deps));
    // saved strategies come back paused and their orphaned orders are cancelled; the owner resumes them with a signed start
    void deps.strategies?.restore().then((r) => r.length && console.log(`strategies restored (paused): ${JSON.stringify(r)}`), (e) => console.error('strategy restore failed:', (e as Error).message));
    if (tee) await enrollWatched(deps);
    if (config.nearAgent || tee) deps.guardLoop?.start();
    if (config.decide.live) deps.decider?.start(); // its own timer: the guard never waits on it
    server.listen(config.port, () => {
      console.log(`hypernear agent on :${config.port} (${config.runMode} mode, ${config.network}, contract ${config.contractId}, relayer ${config.relayer ? 'set' : 'MISSING'}, ` +
        `near agent ${config.nearAgent ? 'set, guard loop on' : 'MISSING, guard loop off'}, ` +
        `decisions ${config.decide.live ? `every ${config.decide.intervalSec} s` : 'off (TYPESAFE_API_KEY / ANTHROPIC_API_KEY not set)'})`);
    });
  }
}

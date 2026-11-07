// Strategy runners of all owners: start (validated against the contract policy), pause/stop (kill switch), list.
// Specs and progress are saved to <dataDir>/strategies.json. After a restart every saved runner comes back PAUSED (never
// auto-resumed), and any order its previous process left on the leg is cancelled; the owner resumes by sending the identical
// spec in a new signed start Command.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { HyperNearClient } from '@hypernear/client';
import type { OrderPolicy } from '../config.ts';
import type { Legs } from '../legs.ts';
import { hlPort, type TradingPort } from './port.ts';
import { StrategyRunner, type Emit, type RunnerSaved } from './runner.ts';
import { specHash, validateSpec, type SpecResult, type StrategySpec } from './spec.ts';

/** Legs 0 and 1 are the hedge pair, leg 2 is the guard's reserve (docs/phase2-strategies.md). */
export const RESERVED_LEGS = [0, 1, 2];

export interface ManagerOpts {
  legs: Legs;
  client: HyperNearClient;
  policy: OrderPolicy;
  emit: Emit;
  agentId?: string;
  intervalMs?: number;
  /** Where specs are saved (absent: nothing is persisted). */
  dataDir?: string;
  makePort?: (owner: Hex, leg: number) => Promise<TradingPort>;
}

interface Entry {
  owner: Hex;
  runner: StrategyRunner;
  timer?: ReturnType<typeof setInterval>;
}
type Saved = Record<string, { owner: Hex; spec: StrategySpec; saved: RunnerSaved }>;

export class StrategyManager {
  readonly #o: ManagerOpts;
  readonly #runners = new Map<string, Entry>();
  constructor(o: ManagerOpts) {
    this.#o = o;
    if (o.dataDir) mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  }

  get #file() {
    return join(this.#o.dataDir!, 'strategies.json');
  }
  /** shortcut: rewrites the whole file on every change; fine for a handful of strategies. */
  #save() {
    if (!this.#o.dataDir) return;
    const out: Saved = {};
    for (const [k, e] of this.#runners) {
      const s = e.runner.snapshot();
      if (s.state !== 'stopped' && s.state !== 'done') out[k] = { owner: e.owner, spec: e.runner.spec, saved: s };
    }
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }

  #mine(owner: Hex) {
    return [...this.#runners.values()].filter((r) => r.owner === owner);
  }

  list(owner: Hex) {
    return this.#mine(owner).map((r) => r.runner.status());
  }

  /** The owner's strategy with this id, if it still exists (for diffs and resume). */
  get(owner: Hex, id: string): StrategySpec | undefined {
    const e = this.#runners.get(`${owner}:${id}`);
    return e && e.runner.state !== 'stopped' ? e.runner.spec : undefined;
  }

  #onLeg(owner: Hex, leg: number) {
    return this.#mine(owner).find((r) => r.runner.spec.leg === leg && r.runner.state !== 'stopped' && r.runner.state !== 'done')?.runner;
  }

  /** What the guard may still spend on this leg today (the strategy's topUpCapPerDay); undefined: no strategy runs there. */
  topUpLeft(owner: Hex, leg: number): number | undefined {
    return this.#onLeg(owner, leg)?.topUpLeft();
  }

  recordTopUp(owner: Hex, leg: number, usd: number) {
    this.#onLeg(owner, leg)?.addTopUp(usd);
  }

  /** The runner of an owner's strategy (for the decision layer's facts). */
  runner(owner: Hex, id: string) {
    return this.#runners.get(`${owner}:${id}`)?.runner;
  }

  /** The owner's live specs (not stopped). */
  specs(owner: Hex): StrategySpec[] {
    return this.#mine(owner).filter((r) => r.runner.state !== 'stopped').map((r) => r.runner.spec);
  }

  /** Everything validateSpec needs; `selfId` is excluded from the busy legs and the budget (it is being replaced or resumed). */
  async context(owner: Hex, selfId?: string) {
    const live = this.#mine(owner).filter((r) => (r.runner.state === 'running' || r.runner.state === 'paused') && r.runner.spec.id !== selfId);
    const [registered, st] = await Promise.all([this.#o.legs.registered(owner), this.#o.client.getOwner(owner)]);
    return {
      orderPolicy: this.#o.policy,
      registeredLegs: registered.map((l) => l.leg),
      reservedLegs: RESERVED_LEGS,
      busyLegs: live.map((x) => x.runner.spec.leg),
      owner: st,
      agentId: this.#o.agentId,
      otherTopUpBudget: live.reduce((a, x) => a + x.runner.spec.limits.topUpCapPerDay, 0),
    };
  }

  async validate(owner: Hex, input: unknown): Promise<SpecResult> {
    const id = (input as { id?: unknown } | null)?.id;
    const r = validateSpec(input, await this.context(owner, typeof id === 'string' ? id : undefined));
    if (!r.ok) return r;
    // the leg needs its own HL API wallet, approved by the owner (the runner trades with it)
    if (!this.#o.legs.keys.get(owner, r.spec.leg)?.approvedAt) return { ok: false, errors: [`leg ${r.spec.leg} has no approved agent key (prepareAgents, then approveAgent)`] };
    const self = this.#runners.get(`${owner}:${r.spec.id}`)?.runner;
    if (self && self.state !== 'stopped' && self.state !== 'done' && !(self.state === 'paused' && specHash(self.spec) === specHash(r.spec))) {
      return { ok: false, errors: [`strategy ${r.spec.id} already exists (${self.state}); stop it first, or send the identical spec to resume a paused one`] };
    }
    return r;
  }

  #port(owner: Hex, leg: number) {
    return (this.#o.makePort ?? ((ow, l) => hlPort(this.#o.legs, ow, l, this.#o.policy.slippage)))(owner, leg);
  }

  #runner(owner: Hex, spec: StrategySpec, port: TradingPort, initial?: Partial<RunnerSaved>) {
    return new StrategyRunner({
      spec, port, policy: this.#o.policy, initial,
      emit: (type, data) => this.#o.emit(type, { owner, ...data }),
      isFrozen: async () => Boolean((await this.#o.client.getOwner(owner))?.frozen),
      deadmanSec: Math.max(30, 3 * ((this.#o.intervalMs ?? 15_000) / 1000)),
      onChange: () => this.#save(),
    });
  }

  #schedule(e: Entry) {
    clearInterval(e.timer);
    e.timer = setInterval(() => void e.runner.tick(), this.#o.intervalMs ?? 15_000);
    void e.runner.tick();
  }

  /** Starts a validated spec; the identical spec of a paused strategy resumes it. */
  async start(owner: Hex, spec: StrategySpec) {
    const key = `${owner}:${spec.id}`;
    const existing = this.#runners.get(key);
    if (existing && existing.runner.state === 'paused' && specHash(existing.runner.spec) === specHash(spec)) {
      existing.runner.resume();
      this.#schedule(existing);
      this.#save();
      return existing.runner.status();
    }
    const runner = this.#runner(owner, spec, await this.#port(owner, spec.leg));
    const e: Entry = { owner, runner };
    this.#runners.set(key, e);
    this.#o.emit('strategy.started', { owner, id: spec.id, leg: spec.leg, type: spec.type, coin: spec.coin });
    this.#save();
    this.#schedule(e);
    return runner.status();
  }

  /** After a restart: reload saved strategies as paused and cancel whatever the previous process left resting on their legs. */
  async restore() {
    if (!this.#o.dataDir || !existsSync(this.#file)) return [];
    const saved = JSON.parse(readFileSync(this.#file, 'utf8')) as Saved;
    const out: { id: string; cancelled?: number; error?: string }[] = [];
    for (const [key, s] of Object.entries(saved)) {
      try {
        const runner = this.#runner(s.owner, s.spec, await this.#port(s.owner, s.spec.leg), { ...s.saved, state: 'paused' });
        this.#runners.set(key, { owner: s.owner, runner });
        out.push({ id: s.spec.id, cancelled: await runner.cleanup() });
      } catch (e) {
        this.#o.emit('strategy.restore_failed', { owner: s.owner, id: s.spec.id, error: (e as Error).message });
        out.push({ id: s.spec.id, error: (e as Error).message });
      }
    }
    this.#save();
    return out;
  }

  #get(owner: Hex, id: string) {
    const r = this.#runners.get(`${owner}:${id}`);
    if (!r) throw new Error(`no strategy ${id} for ${owner}`);
    return r;
  }

  async pause(owner: Hex, id: string, reason = 'owner') {
    const r = this.#get(owner, id);
    clearInterval(r.timer);
    await r.runner.pause(reason);
    this.#save();
    return r.runner.status();
  }

  async stop(owner: Hex, id: string, reason = 'owner') {
    const r = this.#get(owner, id);
    clearInterval(r.timer);
    await r.runner.stop(reason);
    this.#save();
    return r.runner.status();
  }

  /** Before a freeze's revocations are posted: cancel every strategy's resting orders while the agent keys still work. */
  async cancelAll(owner: Hex) {
    await Promise.all(this.#mine(owner).map(async (r) => {
      clearInterval(r.timer);
      await r.runner.freeze();
    }));
    this.#save();
  }

  shutdown() {
    for (const r of this.#runners.values()) clearInterval(r.timer);
  }
}

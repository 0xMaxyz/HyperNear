// Strategy runners of all owners: start (validated against the contract policy), pause/stop (kill switch), list.
// shortcut: runners live in memory, so a restart forgets them (resting orders stay on the exchange until cancelled);
// persist the specs under dataDir when this is more than a thin slice.
import type { Hex } from 'viem';
import type { HyperNearClient } from '@hypernear/client';
import type { OrderPolicy } from '../config.ts';
import type { Legs } from '../legs.ts';
import { hlPort, type TradingPort } from './port.ts';
import { StrategyRunner, type Emit } from './runner.ts';
import { validateSpec, type SpecResult, type StrategySpec } from './spec.ts';

/** Legs 0 and 1 are the hedge pair, leg 2 is the guard's reserve (docs/phase2-strategies.md). */
export const RESERVED_LEGS = [0, 1, 2];

export interface ManagerOpts {
  legs: Legs;
  client: HyperNearClient;
  policy: OrderPolicy;
  emit: Emit;
  agentId?: string;
  intervalMs?: number;
  makePort?: (owner: Hex, leg: number) => Promise<TradingPort>;
}

export class StrategyManager {
  readonly #o: ManagerOpts;
  readonly #runners = new Map<string, { owner: Hex; runner: StrategyRunner; timer: ReturnType<typeof setInterval> }>();
  constructor(o: ManagerOpts) {
    this.#o = o;
  }

  #mine(owner: Hex) {
    return [...this.#runners.values()].filter((r) => r.owner === owner);
  }

  list(owner: Hex) {
    return this.#mine(owner).map((r) => r.runner.status());
  }

  async validate(owner: Hex, input: unknown): Promise<SpecResult> {
    const live = this.#mine(owner).filter((r) => r.runner.state === 'running' || r.runner.state === 'paused');
    const [registered, st] = await Promise.all([this.#o.legs.registered(owner), this.#o.client.getOwner(owner)]);
    const r = validateSpec(input, {
      orderPolicy: this.#o.policy,
      registeredLegs: registered.map((l) => l.leg),
      reservedLegs: RESERVED_LEGS,
      busyLegs: live.map((x) => x.runner.spec.leg),
      owner: st,
      agentId: this.#o.agentId,
      otherTopUpBudget: live.reduce((a, x) => a + x.runner.spec.limits.topUpCapPerDay, 0),
    });
    // the leg needs its own HL API wallet, approved by the owner (the runner trades with it)
    if (r.ok && !this.#o.legs.keys.get(owner, r.spec.leg)?.approvedAt) return { ok: false, errors: [`leg ${r.spec.leg} has no approved agent key (prepareAgents, then approveAgent)`] };
    if (r.ok && this.#mine(owner).some((x) => x.runner.spec.id === r.spec.id && x.runner.state !== 'stopped')) return { ok: false, errors: [`strategy ${r.spec.id} already exists`] };
    return r;
  }

  async start(owner: Hex, spec: StrategySpec) {
    const port = await (this.#o.makePort ?? ((ow, leg) => hlPort(this.#o.legs, ow, leg, this.#o.policy.slippage)))(owner, spec.leg);
    const runner = new StrategyRunner({
      spec, port, policy: this.#o.policy,
      emit: (type, data) => this.#o.emit(type, { owner, ...data }),
      isFrozen: async () => Boolean((await this.#o.client.getOwner(owner))?.frozen),
      deadmanSec: Math.max(30, 3 * ((this.#o.intervalMs ?? 15_000) / 1000)),
    });
    const timer = setInterval(() => void runner.tick(), this.#o.intervalMs ?? 15_000);
    this.#runners.set(`${owner}:${spec.id}`, { owner, runner, timer });
    this.#o.emit('strategy.started', { owner, id: spec.id, leg: spec.leg, type: spec.type, coin: spec.coin });
    void runner.tick();
    return runner.status();
  }

  #get(owner: Hex, id: string) {
    const r = this.#runners.get(`${owner}:${id}`);
    if (!r) throw new Error(`no strategy ${id} for ${owner}`);
    return r;
  }

  async pause(owner: Hex, id: string, reason = 'owner') {
    const r = this.#get(owner, id);
    await r.runner.pause(reason);
    return r.runner.status();
  }

  async stop(owner: Hex, id: string, reason = 'owner') {
    const r = this.#get(owner, id);
    clearInterval(r.timer);
    await r.runner.stop(reason);
    return r.runner.status();
  }

  /** Before a freeze's revocations are posted: cancel every strategy's resting orders while the agent keys still work. */
  async cancelAll(owner: Hex) {
    await Promise.all(this.#mine(owner).map(async (r) => {
      clearInterval(r.timer);
      await r.runner.freeze();
    }));
  }

  shutdown() {
    for (const r of this.#runners.values()) clearInterval(r.timer);
  }
}

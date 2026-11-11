// 1-click trading sessions: owner-approved browser keys that may sign placeOrder / cancelOrder for that owner only.
// Kept in memory on purpose: an agent restart ends every session (the owner signs one new startSession), and nothing
// that can sign for an owner is written to disk. A freeze, a TEE switch or endSession ends them sooner.
import type { Hex } from 'viem';
import { MAX_SESSION_SEC, MIN_SESSION_SEC, SESSION_ACTIONS, type SessionAction, type SessionSpec } from '@hypernear/client';
import type { OrderPolicy } from './config.ts';

export interface Session extends SessionSpec {
  owner: Hex;
  /** unix seconds */
  startedAt: number;
}

const ADDR = /^0x[0-9a-f]{40}$/;
const KEYS = new Set(['v', 'key', 'expiresAt', 'actions', 'maxNotionalUsd', 'maxLeverage', 'coins']);
const pos = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Checks the spec exactly as sent (the owner signed its hash), against the clock and the agent's order policy. */
export function parseSessionSpec(raw: unknown, owner: Hex, policy: OrderPolicy, nowSec: number): { ok: true; spec: SessionSpec } | { ok: false; error: string } {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'spec must be an object' };
  const extra = Object.keys(s).filter((k) => !KEYS.has(k));
  if (extra.length) return { ok: false, error: `unknown spec fields: ${extra.join(', ')}` };
  if (s.v !== 1) return { ok: false, error: 'spec.v must be 1' };
  if (typeof s.key !== 'string' || !ADDR.test(s.key)) return { ok: false, error: 'spec.key must be 0x + 40 lowercase hex' };
  if (s.key === owner) return { ok: false, error: 'spec.key must not be the owner' };
  if (!Number.isSafeInteger(s.expiresAt)) return { ok: false, error: 'spec.expiresAt must be unix seconds' };
  const ttl = (s.expiresAt as number) - nowSec;
  if (ttl < MIN_SESSION_SEC || ttl > MAX_SESSION_SEC) return { ok: false, error: `session must last ${MIN_SESSION_SEC} s to ${MAX_SESSION_SEC / 3600} h` };
  const acts = s.actions;
  if (!Array.isArray(acts) || acts.length === 0 || acts.some((a) => !SESSION_ACTIONS.includes(a as SessionAction)) || new Set(acts).size !== acts.length) {
    return { ok: false, error: `spec.actions must be a non-empty subset of ${SESSION_ACTIONS.join(', ')}` };
  }
  if (s.maxNotionalUsd !== undefined && !pos(s.maxNotionalUsd)) return { ok: false, error: 'spec.maxNotionalUsd must be a positive number' };
  if (s.maxLeverage !== undefined && !(Number.isSafeInteger(s.maxLeverage) && (s.maxLeverage as number) >= 1)) return { ok: false, error: 'spec.maxLeverage must be a whole number, 1 or more' };
  if (s.coins !== undefined) {
    if (!Array.isArray(s.coins) || s.coins.length === 0 || s.coins.some((c) => typeof c !== 'string')) return { ok: false, error: 'spec.coins must be a non-empty list of coin names' };
    const off = (s.coins as string[]).filter((c) => !policy.allowedCoins.includes(c));
    if (off.length) return { ok: false, error: `spec.coins outside the order policy: ${off.join(', ')}` };
  }
  return { ok: true, spec: s as unknown as SessionSpec };
}

/** The order policy for a command: the agent's own, narrowed by the session's caps when a session key signed it. */
export function sessionPolicy(policy: OrderPolicy, s?: SessionSpec): OrderPolicy {
  if (!s) return policy;
  return {
    ...policy,
    maxNotionalUsd: Math.min(policy.maxNotionalUsd, s.maxNotionalUsd ?? Infinity),
    maxLeverage: Math.min(policy.maxLeverage, s.maxLeverage ?? Infinity),
    allowedCoins: s.coins ? policy.allowedCoins.filter((c) => s.coins!.includes(c)) : policy.allowedCoins,
  };
}

export class SessionStore {
  readonly #by = new Map<Hex, Map<Hex, Session>>();
  readonly maxPerOwner: number;
  readonly now: () => number;
  // plain fields, not parameter properties: the agent runs on Node's type stripping
  constructor(maxPerOwner = 4, now: () => number = Date.now) {
    this.maxPerOwner = maxPerOwner;
    this.now = now;
  }

  #live(owner: Hex): Map<Hex, Session> {
    const m = this.#by.get(owner) ?? new Map<Hex, Session>();
    const t = Math.floor(this.now() / 1000);
    for (const [k, s] of m) if (s.expiresAt <= t) m.delete(k);
    if (m.size === 0) this.#by.delete(owner);
    return m;
  }

  /** Adds (or replaces) a session; past maxPerOwner the oldest one ends. */
  start(owner: Hex, spec: SessionSpec): Session {
    const m = this.#live(owner);
    m.delete(spec.key);
    while (m.size >= this.maxPerOwner) m.delete([...m.values()].sort((a, b) => a.startedAt - b.startedAt)[0]!.key);
    const s: Session = { ...spec, owner, startedAt: Math.floor(this.now() / 1000) };
    m.set(spec.key, s);
    this.#by.set(owner, m);
    return s;
  }

  get(owner: Hex, key: Hex): Session | undefined {
    return this.#live(owner).get(key);
  }

  list(owner: Hex): Session[] {
    return [...this.#live(owner).values()];
  }

  end(owner: Hex, key: Hex): boolean {
    const m = this.#live(owner);
    const had = m.delete(key);
    if (m.size === 0) this.#by.delete(owner);
    return had;
  }

  /** Ends every session of the owner; returns how many were live. */
  revokeAll(owner: Hex): number {
    const n = this.#live(owner).size;
    this.#by.delete(owner);
    return n;
  }
}

/** What GET /owner and /sessions show: no secrets exist here, the private key never leaves the browser. */
export const publicSession = (s: Session) => ({ key: s.key, startedAt: s.startedAt, expiresAt: s.expiresAt, actions: s.actions, maxNotionalUsd: s.maxNotionalUsd, maxLeverage: s.maxLeverage, coins: s.coins });

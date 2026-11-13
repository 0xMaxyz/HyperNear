// 1-click trading sessions (off-chain, agent service only). The owner signs ONE `startSession` command whose specHash binds a
// SessionSpec naming a fresh key the browser made; until the spec expires, the owner ends it, or a freeze, the agent also
// accepts `placeOrder` / `cancelOrder` / `modifyOrder` commands signed by that key. A session key can never start a session, change any
// setting, accept a decision, start a strategy or touch the contract, and opens a hedge only when the owner ticked `placeHedge` for this
// session (it is not in the default set): only the actions listed here, inside the
// agent's order policy, narrowed further by the spec's own caps.
import type { Hex } from 'viem';

/** The only actions a session key may sign (plus `endSession` of its own key). */
export const SESSION_ACTIONS = ['placeOrder', 'cancelOrder', 'modifyOrder', 'placeHedge'] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];
/** What a session allows unless the owner adds more: single orders only. `placeHedge` is an explicit opt-in. */
export const DEFAULT_SESSION_ACTIONS: SessionAction[] = ['placeOrder', 'cancelOrder', 'modifyOrder'];

/** Session lifetime bounds, seconds. */
export const MIN_SESSION_SEC = 60;
export const MAX_SESSION_SEC = 24 * 3600;
export const DEFAULT_SESSION_SEC = 3600;

export interface SessionSpec {
  v: 1;
  /** the session key's EVM address, lowercase */
  key: Hex;
  /** unix seconds */
  expiresAt: number;
  /** a non-empty subset of SESSION_ACTIONS */
  actions: SessionAction[];
  /** optional caps, each at most the agent's order policy (the lower one applies) */
  maxNotionalUsd?: number;
  maxLeverage?: number;
  coins?: string[];
}

export interface SessionCaps {
  maxNotionalUsd?: number;
  maxLeverage?: number;
  coins?: string[];
}

/** A spec for `key` expiring in `ttlSec`; omitted caps are left to the agent's order policy. */
export function newSessionSpec(key: Hex, ttlSec = DEFAULT_SESSION_SEC, nowMs = Date.now(), caps: SessionCaps = {}, actions: SessionAction[] = [...DEFAULT_SESSION_ACTIONS]): SessionSpec {
  const spec: SessionSpec = { v: 1, key: key.toLowerCase() as Hex, expiresAt: Math.floor(nowMs / 1000) + ttlSec, actions };
  if (caps.maxNotionalUsd !== undefined) spec.maxNotionalUsd = caps.maxNotionalUsd;
  if (caps.maxLeverage !== undefined) spec.maxLeverage = caps.maxLeverage;
  if (caps.coins !== undefined) spec.coins = caps.coins;
  return spec;
}

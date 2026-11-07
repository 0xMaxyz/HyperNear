// POST /relay: forwards a signed owner intent to the contract (owner_execute), paying gas and the storage deposit.
// The signature is the authentication; this layer only validates shape, rate-limits per IP, and refuses owners
// with no registered leg (register_leg itself is the exception: anyone may register, the address comes from MPC).
import type { Hex } from 'viem';
import { HyperNearClient, HyperNearError, HyperNearRelayRefusedError, signOutToHex, type OwnerIntent } from '@hypernear/client';

/** Fixed-window counter per key (IP). shortcut: in-memory, one process; move to a shared store if the relayer scales out. */
export class RateLimiter {
  readonly #hits = new Map<string, { start: number; n: number }>();
  readonly perWindow: number;
  readonly windowMs: number;
  readonly now: () => number;
  constructor(perWindow: number, windowMs = 60_000, now: () => number = Date.now) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.now = now;
  }
  allow(key: string): boolean {
    const t = this.now();
    const h = this.#hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.#hits.set(key, { start: t, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= this.perWindow;
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ADDR = /^0x[0-9a-f]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const INTENT_TYPES = new Set(['approveAgent', 'withdraw', 'usdClassTransfer', 'setPolicy', 'freeze']);

export interface RelayBody {
  owner: string;
  nonce?: number;
  intent: OwnerIntent | { type: 'registerLeg'; leg: number };
  sig?: string;
}

export function parseRelayBody(b: unknown): RelayBody {
  const o = b as Record<string, any>;
  if (!o || typeof o !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (typeof o.owner !== 'string' || !ADDR.test(o.owner)) throw new HttpError(400, 'owner must be 0x + 40 lowercase hex');
  const t = o.intent?.type;
  if (t === 'registerLeg') {
    if (!Number.isInteger(o.intent.leg) || o.intent.leg < 0) throw new HttpError(400, 'intent.leg must be a non-negative integer');
    return { owner: o.owner, intent: { type: 'registerLeg', leg: o.intent.leg } };
  }
  if (!INTENT_TYPES.has(t)) throw new HttpError(400, `unknown intent type ${String(t)}`);
  if (!Number.isSafeInteger(o.nonce) || o.nonce < 0) throw new HttpError(400, 'nonce must be a non-negative integer');
  if (typeof o.sig !== 'string' || !SIG.test(o.sig)) throw new HttpError(400, 'sig must be 65 bytes hex');
  return { owner: o.owner, nonce: o.nonce, intent: o.intent as OwnerIntent, sig: o.sig };
}

export class Relayer {
  readonly client: HyperNearClient;
  readonly limiter: RateLimiter;
  constructor(client: HyperNearClient, limiter: RateLimiter) {
    this.client = client;
    this.limiter = limiter;
  }

  async relay(ip: string, raw: unknown) {
    if (!this.limiter.allow(ip)) throw new HttpError(429, 'rate limited');
    const b = parseRelayBody(raw);
    const owner = b.owner as Hex;
    try {
      if (b.intent.type === 'registerLeg') {
        return { kind: 'registerLeg', leg: b.intent.leg, address: await this.client.registerLeg(owner, b.intent.leg) };
      }
      const { txHash, value } = await this.client.relaySubmit({ owner, nonce: b.nonce!, intent: b.intent }, b.sig as Hex);
      return { kind: 'ownerExecute', txHash, result: value, hlSignature: value ? signOutToHex(value) : null };
    } catch (e) {
      if (e instanceof HyperNearRelayRefusedError) throw new HttpError(403, e.message);
      if (e instanceof HyperNearError) throw new HttpError(422, e.message);
      throw e;
    }
  }
}

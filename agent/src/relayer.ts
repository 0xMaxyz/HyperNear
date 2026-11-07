// POST /relay: forwards a signed owner intent to the contract (owner_execute), paying gas and the storage deposit.
// The signature is the authentication; this layer only validates shape, rate-limits per IP, and refuses owners
// with no registered leg (register_leg itself is the exception: anyone may register, the address comes from MPC).
import type { Hex } from 'viem';
import { exchangeBody, HyperNearClient, HyperNearError, HyperNearRelayRefusedError, signOutToHex, type OwnerIntent, type Revoked, type SignOut } from '@hypernear/client';
import { HL_API_URLS } from '@perps-platform/core';
import type { EventBus } from './events.ts';

/** POSTs a contract-signed action to HL /exchange; returns HL's JSON (status ok|err), never throws on status err. */
export type HlPoster = (body: ReturnType<typeof exchangeBody>) => Promise<unknown>;

export function hlPoster(network: 'testnet' | 'mainnet'): HlPoster {
  return async (body) => {
    const r = await fetch(`${HL_API_URLS[network]}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'err', response: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    }
  };
}

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
  readonly post?: HlPoster;
  readonly bus?: EventBus;
  /** Runs before a freeze's revocations are posted, while the agent keys still work (strategies cancel their resting orders). */
  onBeforeRevoke?: (owner: Hex) => Promise<void>;
  /** post + bus: after a freeze, the revoking approveAgent actions go to HL at once and to /events. */
  constructor(client: HyperNearClient, limiter: RateLimiter, post?: HlPoster, bus?: EventBus) {
    this.client = client;
    this.limiter = limiter;
    this.post = post;
    this.bus = bus;
  }

  /** How long a freeze waits for onBeforeRevoke (it calls HL) before posting the revocations anyway. */
  revokeHookTimeoutMs = 8000;

  /** Posts every revocation of a freeze to HL; emits 'agents.revoked' with one entry per leg/name. */
  async postRevocations(owner: Hex, revoked: Revoked[]) {
    const hook = this.onBeforeRevoke?.(owner).catch((e) => void this.bus?.emit('agents.revoke.hook_failed', { owner, error: String(e) }));
    if (hook) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        hook.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), this.revokeHookTimeoutMs))),
      ]);
      clearTimeout(timer);
      // the freeze never waits on a hanging HL call: revoke regardless
      if (timedOut) this.bus?.emit('agents.revoke.hook_timeout', { owner, ms: this.revokeHookTimeoutMs });
    }
    const chain = (await this.client.getConfig()).hl_mainnet ? 'Mainnet' : 'Testnet';
    const legs = await Promise.all(
      revoked.map(async (r) => {
        if (!r.signature) return { leg: r.leg, name: r.name, burn: r.burn_address, ok: false, hl: 'MPC sign failed' };
        const hl = this.post ? await this.post(exchangeBody(r.signature, chain)).catch((e) => ({ status: 'err', response: String(e) })) : 'not posted';
        return { leg: r.leg, name: r.name, burn: r.burn_address, ok: (hl as { status?: string })?.status === 'ok', hl };
      })
    );
    this.bus?.emit('agents.revoked', { owner, legs });
    return legs;
  }

  /** Posts the contract-signed approveAgent to HL; emits 'agents.approved'. HL errors (e.g. an unfunded leg:
   * "Must deposit before performing actions") come back as ok: false with HL's text, never as a throw. */
  async postApproval(owner: Hex, intent: Extract<OwnerIntent, { type: 'approveAgent' }>, out: SignOut) {
    const chain = (await this.client.getConfig()).hl_mainnet ? 'Mainnet' : 'Testnet';
    const hl = this.post ? await this.post(exchangeBody(out, chain)).catch((e) => ({ status: 'err', response: String(e) })) : 'not posted';
    const r = { leg: intent.leg, agent: intent.agent.toLowerCase() as Hex, agentName: intent.agentName ?? '', ok: (hl as { status?: string })?.status === 'ok', hl };
    this.bus?.emit('agents.approved', { owner, ...r });
    return r;
  }

  async relay(ip: string, raw: unknown) {
    if (!this.limiter.allow(ip)) throw new HttpError(429, 'rate limited');
    const b = parseRelayBody(raw);
    const owner = b.owner as Hex;
    try {
      if (b.intent.type === 'registerLeg') {
        return { kind: 'registerLeg' as const, leg: b.intent.leg, address: await this.client.registerLeg(owner, b.intent.leg) };
      }
      const { txHash, value } = await this.client.relaySubmit({ owner, nonce: b.nonce!, intent: b.intent }, b.sig as Hex);
      if (Array.isArray(value)) {
        return { kind: 'freeze' as const, owner, txHash, revoked: await this.postRevocations(owner, value) };
      }
      if (b.intent.type === 'approveAgent' && value) {
        return { kind: 'approveAgent' as const, owner, txHash, hlSignature: signOutToHex(value), ...(await this.postApproval(owner, b.intent, value)) };
      }
      return { kind: 'ownerExecute' as const, txHash, result: value, hlSignature: value ? signOutToHex(value as SignOut) : null };
    } catch (e) {
      if (e instanceof HyperNearRelayRefusedError) throw new HttpError(403, e.message);
      if (e instanceof HyperNearError) throw new HttpError(422, e.message);
      throw e;
    }
  }
}

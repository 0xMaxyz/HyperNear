// One shared place that keeps a process inside Hyperliquid's per-IP limit (about 1200 request weight a minute): every
// /info read and every /exchange post to one api url goes through the same gate, however many HlClient objects exist.

export interface HlGateTuning {
  /** /info results are reused this long unless INFO_TTL_MS names the request type */
  ttlMs: number;
  /** tries per request, the first included */
  attempts: number;
  /** first backoff step; doubles per try, jittered to 50-100% */
  baseMs: number;
  maxMs: number;
  /** no new try when waiting would push the request past this */
  budgetMs: number;
  /** /info requests in flight at once */
  concurrency: number;
  now?: () => number;
  random?: () => number;
}

export const HL_GATE_DEFAULTS: HlGateTuning = { ttlMs: 3000, attempts: 4, baseMs: 500, maxMs: 4000, budgetMs: 12_000, concurrency: 4 };

/** Per /info `type`: what barely changes lives longer, per-user history longer than a balance, and an order book is never reused. */
export const INFO_TTL_MS: Record<string, number> = {
  meta: 300_000,
  spotMeta: 300_000,
  perpDexs: 300_000,
  metaAndAssetCtxs: 30_000,
  spotMetaAndAssetCtxs: 30_000,
  userFees: 60_000,
  // history rows (weight 20 each) change on a fill; the agent's own writes drop them at once, a fill from elsewhere shows within this time
  userFills: 20_000,
  userFillsByTime: 20_000,
  userFunding: 60_000,
  userNonFundingLedgerUpdates: 20_000,
  twapHistory: 20_000,
  l2Book: 0,
};

/** 'rate': HL's nginx refused it before the exchange saw it (safe to resend, even a signed order). 'transient': 5xx or a network failure. A real HL answer (HTTP 200 with status "err", a 4xx other than 429) is neither. */
function classify(e: unknown): 'rate' | 'transient' | undefined {
  const err = e as { response?: { status?: number }; message?: unknown; name?: unknown; cause?: unknown } | undefined;
  const status = err?.response?.status;
  if (status === 429) return 'rate';
  if (status !== undefined) return [500, 502, 503, 504].includes(status) ? 'transient' : undefined;
  // the SDK's HttpRequestError without a response: a network error or its own timeout; its own abort is the caller's choice
  if (err?.name === 'HttpRequestError' && !/aborted/i.test(String(err.message))) return 'transient';
  return undefined;
}

function retryAfterMs(e: unknown): number | undefined {
  const raw = (e as { response?: { headers?: { get?: (k: string) => string | null } } } | undefined)?.response?.headers?.get?.('retry-after');
  const s = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HlGate {
  readonly #t: HlGateTuning;
  readonly #cache = new Map<string, { at: number; ttl: number; v: unknown }>();
  readonly #flight = new Map<string, Promise<unknown>>();
  /** bumped by every write: an /info read that started before it must not be stored */
  #gen = 0;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(t: Partial<HlGateTuning> = {}) {
    this.#t = { ...HL_GATE_DEFAULTS, ...t };
  }

  #now() {
    return (this.#t.now ?? Date.now)();
  }

  /** At most `concurrency` /info requests at once; a freed slot passes straight to the next waiter. */
  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#t.concurrency) await new Promise<void>((r) => this.#queue.push(r));
    else this.#active++;
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }

  async #retry<T>(exec: () => Promise<T>, onlyRate: boolean, capped: boolean): Promise<T> {
    const start = this.#now();
    for (let i = 1; ; i++) {
      try {
        return await (capped ? this.#slot(exec) : exec());
      } catch (e) {
        const kind = classify(e);
        if (!kind || (onlyRate && kind !== 'rate') || i >= this.#t.attempts) throw e;
        const step = Math.min(this.#t.maxMs, this.#t.baseMs * 2 ** (i - 1));
        const jitter = step * (0.5 + 0.5 * (this.#t.random ?? Math.random)());
        const wait = Math.max(jitter, retryAfterMs(e) ?? 0);
        if (this.#now() - start + wait > this.#t.budgetMs) throw e;
        await sleep(wait);
      }
    }
  }

  #reset() {
    this.#gen++;
    this.#cache.clear();
    this.#flight.clear();
  }

  /** A read: identical requests in flight share one call, results are reused for a few seconds, 429 and 5xx are retried. Every caller gets its own copy. */
  async info<T>(payload: unknown, exec: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(payload);
    const ttl = INFO_TTL_MS[(payload as { type?: string } | null)?.type ?? ''] ?? this.#t.ttlMs;
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < hit.ttl) return structuredClone(hit.v) as T;
    let live = this.#flight.get(key) as Promise<T> | undefined;
    if (!live) {
      const gen = this.#gen;
      const p: Promise<T> = this.#retry(exec, false, true)
        .then((v) => {
          if (gen === this.#gen && ttl > 0) this.#cache.set(key, { at: this.#now(), ttl, v });
          return v;
        })
        .finally(() => {
          if (this.#flight.get(key) === p) this.#flight.delete(key);
        });
      this.#flight.set(key, p);
      live = p;
    }
    return structuredClone(await live);
  }

  /** A write (/exchange): never cached or shared. Forgets every read before and after, and is resent only after a 429 (an HTTP error before HL processed anything). */
  async write<T>(exec: () => Promise<T>): Promise<T> {
    this.#reset();
    try {
      return await this.#retry(exec, true, false);
    } finally {
      this.#reset();
    }
  }
}

// shared per api url: HlClient objects are created per call (the trading client is built per leg), but one IP has one budget
const gates = new Map<string, HlGate>();
export function hlGate(apiUrl: string, tuning?: Partial<HlGateTuning>): HlGate {
  let g = gates.get(apiUrl);
  if (!g) gates.set(apiUrl, (g = new HlGate(tuning)));
  return g;
}

/**
 * `fetch` for a raw POST of a signed action to <apiUrl>/exchange: invalidates cached reads and re-sends after an HTTP 429.
 * Any other answer (HL's own rejection comes as HTTP 200 with status "err") is returned as it is, never resent.
 */
export function hlExchangeFetch(apiUrl: string): typeof fetch {
  const gate = hlGate(apiUrl);
  return async (input, init) => {
    const seen: { last?: Response } = {};
    try {
      return await gate.write(async () => {
        const r = await fetch(input, init);
        if (r.status !== 429) return r;
        seen.last = r;
        throw Object.assign(new Error('429 Too Many Requests'), { response: r });
      });
    } catch (e) {
      if (seen.last && (e as { response?: Response }).response === seen.last) return seen.last; // out of tries: the caller sees the 429 as before
      throw e;
    }
  };
}

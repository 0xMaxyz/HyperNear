// One shared place that makes NEAR JSON-RPC survive rate limits: every view and every transaction of the process goes
// through ResilientProvider, so the contract views, the Account's access-key/block reads and the tx sends all share it.
import { JsonRpcProvider } from 'near-api-js';

export interface RpcTuning {
  /** how long a contract view is reused */
  ttlMs: number;
  /** tries per request, the first included */
  attempts: number;
  /** first backoff step; doubles per try, jittered to 50-100% */
  baseMs: number;
  maxMs: number;
  /** no new try when waiting would push the request past this */
  budgetMs: number;
  /** requests in flight at once, per RPC url */
  concurrency: number;
  now?: () => number;
  random?: () => number;
}

export const DEFAULT_TUNING: RpcTuning = { ttlMs: 3000, attempts: 5, baseMs: 500, maxMs: 4000, budgetMs: 12_000, concurrency: 4 };

const WRITES = new Set(['send_tx', 'broadcast_tx_commit', 'broadcast_tx_async']);
const NETWORK = /fetch failed|FetchError|Failed to fetch|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR/;

/** 'rate': the node refused before doing anything (always safe to resend). 'transient': a 5xx or network failure. Anything else is real (a contract panic, bad args) and is never retried. */
function classify(e: unknown): 'rate' | 'transient' | undefined {
  const err = e as { cause?: unknown; message?: unknown } | undefined;
  const status = typeof err?.cause === 'number' ? err.cause : undefined;
  const msg = String(err?.message ?? e);
  // near-api-js turns a JSON-RPC error body with no known name into this message and drops the code, so it cannot be told from a 429 body
  if (status === 429 || /^\[-?429\]/.test(msg)) return 'rate';
  if ((status !== undefined && [408, 500, 502, 503, 504].includes(status)) || msg === 'Unknown RPC error') return 'transient';
  const code = (err?.cause as { code?: unknown } | undefined)?.code;
  if (NETWORK.test(`${msg} ${code}`)) return 'transient';
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RpcGate {
  readonly #t: RpcTuning;
  readonly #cache = new Map<string, { at: number; v: unknown }>();
  readonly #flight = new Map<string, Promise<unknown>>();
  /** bumped by every write: a view that started before it must not be cached */
  #gen = 0;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(t: Partial<RpcTuning> = {}) {
    this.#t = { ...DEFAULT_TUNING, ...t };
  }

  #now() {
    return (this.#t.now ?? Date.now)();
  }

  /** Never more than `concurrency` requests at once; a freed slot passes straight to the next waiter. */
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

  async #retry<T>(exec: () => Promise<T>, isWrite: boolean): Promise<T> {
    const start = this.#now();
    for (let i = 1; ; i++) {
      try {
        return await this.#slot(exec);
      } catch (e) {
        const kind = classify(e);
        // a write is resent only after a 429: after a network error the transaction may already have been accepted
        if (!kind || (isWrite && kind !== 'rate') || i >= this.#t.attempts) throw e;
        const step = Math.min(this.#t.maxMs, this.#t.baseMs * 2 ** (i - 1));
        const wait = step * (0.5 + 0.5 * (this.#t.random ?? Math.random)());
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

  send<T>(method: string, params: object, exec: () => Promise<T>): Promise<T> {
    if (WRITES.has(method)) {
      this.#reset();
      return this.#retry(exec, true).finally(() => this.#reset());
    }
    // only a contract view is shared; an access-key or block read feeds a transaction's nonce and must stay fresh
    if (method !== 'query' || (params as { request_type?: string }).request_type !== 'call_function') return this.#retry(exec, false);
    const key = JSON.stringify(params);
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < this.#t.ttlMs) return Promise.resolve(hit.v as T);
    const live = this.#flight.get(key);
    if (live) return live as Promise<T>;
    const gen = this.#gen;
    const p: Promise<T> = this.#retry(exec, false)
      .then((v) => {
        if (gen === this.#gen) this.#cache.set(key, { at: this.#now(), v });
        return v;
      })
      .finally(() => {
        if (this.#flight.get(key) === p) this.#flight.delete(key);
      });
    this.#flight.set(key, p);
    return p;
  }
}

// shared per url: the relayer, the agent key and the TEE view each hold their own provider, but a write by one must invalidate all
const gates = new Map<string, RpcGate>();

/** near-api-js provider with in-flight de-duplication, a short view cache, jittered retry and a concurrency cap. */
export class ResilientProvider extends JsonRpcProvider {
  constructor(url: string, tuning?: Partial<RpcTuning>) {
    // retries: 1 turns off near-api-js' own retry, which re-sends 500/503 at once with no delay
    super({ url }, { retries: 1 });
    let g = gates.get(url);
    if (!g) gates.set(url, (g = new RpcGate(tuning)));
    // wrapped on the instance: JsonRpcProvider's generic signature cannot be overridden without casts anyway
    const send = this.sendJsonRpc.bind(this) as (m: string, p: object) => Promise<unknown>;
    (this as { sendJsonRpc: unknown }).sendJsonRpc = (m: string, p: object) => g.send(m, p, () => send(m, p));
  }
}

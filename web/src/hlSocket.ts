// One WebSocket to Hyperliquid per tab, shared by everything that wants live data. Hyperliquid allows 10 sockets and 10 distinct users per IP, so
// the page multiplexes: identical subscriptions are shared (ref-counted), the socket is opened when the first one is wanted and closed when the
// last one goes, every subscription is sent again after a reconnect, and a ping every 45 s keeps it from being closed as idle (HL drops a socket
// after 60 s of silence). A hidden tab lets go of the socket after a minute (browsers throttle timers there, so the ping would stop) and takes it
// back when the tab is shown. When HL answers with a limit error, or the socket keeps failing, the state is 'polling': callers keep refreshing
// the old way and this class keeps trying in the background.
export type SocketState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'polling' | 'paused';

export interface Sub {
  type: string;
  user?: string;
  coin?: string;
}

/** The part of WebSocket this class uses; tests pass a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface HlSocketOpts {
  url: string;
  make?: (url: string) => SocketLike;
  /** how long a hidden tab keeps the socket (default 60 s) */
  hiddenCloseMs?: number;
}

const OPEN = 1;
const PING_MS = 45_000;
const MAX_BACKOFF_MS = 15_000;
/** HL allows 30 new connections a minute per IP; stay well under, a tab that loops on failure must not eat the quota of the others */
const MAX_CONNECTS_PER_MIN = 20;
const POLLING_RETRY_MS = 60_000;

export const subKey = (s: Sub) => `${s.type}|${(s.user ?? '').toLowerCase()}|${s.coin ?? ''}`;

export class HlSocket {
  state: SocketState = 'idle';
  readonly url: string;
  readonly #make: (url: string) => SocketLike;
  readonly #hiddenCloseMs: number;
  readonly #subs = new Map<string, { sub: Sub; handlers: Set<(data: unknown) => void> }>();
  readonly #onState = new Set<(s: SocketState) => void>();
  #ws?: SocketLike;
  #ping?: ReturnType<typeof setInterval>;
  #retry?: ReturnType<typeof setTimeout>;
  #hiddenTimer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #lastMessage = 0;
  #connects: number[] = [];
  #hidden = false;

  constructor(opts: HlSocketOpts) {
    this.url = opts.url;
    this.#make = opts.make ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.#hiddenCloseMs = opts.hiddenCloseMs ?? 60_000;
  }

  /** Calls `handler` with the `data` of every message of this subscription. Returns the unsubscribe function. */
  subscribe(sub: Sub, handler: (data: unknown) => void): () => void {
    const key = subKey(sub);
    let entry = this.#subs.get(key);
    const isNew = !entry;
    if (!entry) this.#subs.set(key, (entry = { sub, handlers: new Set() }));
    entry.handlers.add(handler);
    if (isNew) {
      if (this.#ws?.readyState === OPEN) this.#send('subscribe', sub);
      else this.#connect();
    }
    return () => {
      const e = this.#subs.get(key);
      if (!e || !e.handlers.delete(handler) || e.handlers.size > 0) return;
      this.#subs.delete(key);
      if (this.#ws?.readyState === OPEN) this.#send('unsubscribe', sub);
      if (this.#subs.size === 0) this.#stop('idle');
    };
  }

  onState(f: (s: SocketState) => void): () => void {
    this.#onState.add(f);
    return () => this.#onState.delete(f);
  }

  /** The page calls this on visibilitychange. */
  setHidden(hidden: boolean) {
    this.#hidden = hidden;
    if (hidden) {
      if (this.#hiddenTimer || !this.#ws) return;
      this.#hiddenTimer = setTimeout(() => {
        this.#hiddenTimer = undefined;
        if (this.#hidden && this.#subs.size > 0) this.#stop('paused');
      }, this.#hiddenCloseMs);
      return;
    }
    clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = undefined;
    if (!this.#ws && this.#subs.size > 0) {
      this.#attempt = 0;
      this.#connect();
    }
  }

  get subscriptions() {
    return this.#subs.size;
  }

  #set(s: SocketState) {
    if (this.state === s) return;
    this.state = s;
    for (const f of this.#onState) f(s);
  }

  #send(method: 'subscribe' | 'unsubscribe', subscription: Sub) {
    this.#ws?.send(JSON.stringify({ method, subscription }));
  }

  #stop(next: SocketState) {
    clearInterval(this.#ping);
    clearTimeout(this.#retry);
    clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = undefined;
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      ws.close();
    }
    this.#set(next);
  }

  #connect() {
    if (this.#ws || this.#hidden || this.#subs.size === 0) return;
    clearTimeout(this.#retry);
    const now = Date.now();
    this.#connects = this.#connects.filter((t) => now - t < 60_000);
    if (this.#connects.length >= MAX_CONNECTS_PER_MIN) {
      this.#set('polling');
      this.#retry = setTimeout(() => this.#connect(), POLLING_RETRY_MS);
      return;
    }
    this.#connects.push(now);
    this.#set(this.#attempt > 4 ? 'polling' : this.#attempt > 0 ? 'reconnecting' : 'connecting');
    let ws: SocketLike;
    try {
      ws = this.#make(this.url);
    } catch {
      this.#later();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#lastMessage = Date.now();
      for (const { sub } of this.#subs.values()) this.#send('subscribe', sub);
      this.#ping = setInterval(() => {
        // HL answers every ping with a pong, so silence for two pings means a half-open socket: drop it and reconnect
        if (Date.now() - this.#lastMessage > 2.5 * PING_MS) return ws.close();
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ method: 'ping' }));
      }, PING_MS);
      // 'live' comes with the first confirmation or data (#message), not with the open
    };
    ws.onmessage = (e) => this.#message(e.data);
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      clearInterval(this.#ping);
      this.#ws = undefined;
      if (this.#subs.size === 0) return this.#set('idle');
      if (this.#hidden) return this.#set('paused');
      this.#later();
    };
  }

  #later() {
    this.#attempt++;
    // a socket that keeps failing is 'polling' to the page, which then refreshes the old way, while this keeps trying
    this.#set(this.#attempt > 4 ? 'polling' : 'reconnecting');
    this.#retry = setTimeout(() => this.#connect(), Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.#attempt - 1)));
  }

  #message(raw: unknown) {
    let msg: { channel?: string; data?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const ch = msg.channel;
    if (!ch) return;
    this.#lastMessage = Date.now();
    if (ch === 'error') {
      // a limit error means this IP has no room: stop asking for a while and let the page poll
      if (/too many|limit|exceed/i.test(String(msg.data))) {
        this.#stop('polling');
        this.#retry = setTimeout(() => this.#connect(), POLLING_RETRY_MS);
      } else if (!/already subscribed/i.test(String(msg.data))) {
        // any other refusal (a subscription HL did not accept): the data cannot be trusted to be complete, so the page keeps polling
        this.#set('polling');
      }
      return;
    }
    if (ch === 'pong') return;
    if (this.#ws) this.#set('live');
    if (ch === 'subscriptionResponse') return;
    const d = (msg.data ?? {}) as { user?: string; coin?: string };
    const entry = this.#subs.get(subKey({ type: ch, user: d.user, coin: ch === 'activeAssetCtx' ? d.coin : undefined }));
    if (entry) for (const h of entry.handlers) h(msg.data);
  }
}

const hubs = new Map<string, HlSocket>();
/** The tab's one socket per network. */
export function hubFor(network: 'testnet' | 'mainnet'): HlSocket {
  let h = hubs.get(network);
  if (!h) {
    h = new HlSocket({ url: `wss://api.hyperliquid${network === 'testnet' ? '-testnet' : ''}.xyz/ws` });
    hubs.set(network, h);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => h!.setHidden(document.hidden));
  }
  return h;
}

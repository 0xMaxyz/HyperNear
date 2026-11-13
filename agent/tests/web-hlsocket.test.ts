import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HlSocket, subKey, type SocketLike } from '../../web/src/hlSocket.ts';

class Fake implements SocketLike {
  static all: Fake[] = [];
  readyState = 0;
  sent: { method: string; subscription?: { type: string } }[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor() {
    Fake.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(channel: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ channel, data }) });
  }
}
const mk = (hiddenCloseMs?: number) => new HlSocket({ url: 'wss://x', make: () => new Fake(), hiddenCloseMs });
const U = '0xAbC0000000000000000000000000000000000001';

beforeEach(() => {
  vi.useFakeTimers();
  Fake.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HlSocket', () => {
  it('opens one socket for all subscriptions, shares identical ones, and routes by channel and user', () => {
    const h = mk();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    h.subscribe({ type: 'clearinghouseState', user: U }, a);
    h.subscribe({ type: 'clearinghouseState', user: U.toLowerCase() }, b); // same subscription, other handler
    h.subscribe({ type: 'openOrders', user: U }, c);
    expect(Fake.all).toHaveLength(1);
    expect(h.state).toBe('connecting');
    Fake.all[0]!.open();
    expect(h.state).toBe('live');
    expect(Fake.all[0]!.sent.map((s) => s.subscription?.type)).toEqual(['clearinghouseState', 'openOrders']); // the shared one is sent once
    Fake.all[0]!.push('clearinghouseState', { user: U.toLowerCase(), x: 1 });
    expect(a).toHaveBeenCalledWith({ user: U.toLowerCase(), x: 1 });
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();
    expect(h.subscriptions).toBe(2);
  });

  it('a late subscription is sent on the open socket; the last unsubscribe closes the socket', () => {
    const h = mk();
    const off1 = h.subscribe({ type: 'allMids' }, () => undefined);
    Fake.all[0]!.open();
    const off2 = h.subscribe({ type: 'userFills', user: U }, () => undefined);
    expect(Fake.all[0]!.sent.at(-1)).toMatchObject({ method: 'subscribe', subscription: { type: 'userFills' } });
    off2();
    expect(Fake.all[0]!.sent.at(-1)).toMatchObject({ method: 'unsubscribe' });
    off1();
    expect(h.state).toBe('idle');
    expect(Fake.all[0]!.readyState).toBe(3);
  });

  it('pings every 45 s', () => {
    const h = mk();
    h.subscribe({ type: 'allMids' }, () => undefined);
    Fake.all[0]!.open();
    vi.advanceTimersByTime(46_000);
    expect(Fake.all[0]!.sent.some((s) => s.method === 'ping')).toBe(true);
  });

  it('reconnects with backoff after a close and sends every subscription again', () => {
    const h = mk();
    h.subscribe({ type: 'clearinghouseState', user: U }, () => undefined);
    h.subscribe({ type: 'userFills', user: U }, () => undefined);
    Fake.all[0]!.open();
    Fake.all[0]!.close();
    expect(h.state).toBe('reconnecting');
    vi.advanceTimersByTime(600);
    expect(Fake.all).toHaveLength(2);
    Fake.all[1]!.open();
    expect(h.state).toBe('live');
    expect(Fake.all[1]!.sent.map((s) => s.subscription?.type)).toEqual(['clearinghouseState', 'userFills']);
  });

  it('a socket that keeps failing is reported as polling, and a good connection resets it', () => {
    const h = mk();
    h.subscribe({ type: 'allMids' }, () => undefined);
    for (let i = 0; i < 6; i++) {
      Fake.all.at(-1)!.close();
      vi.advanceTimersByTime(16_000);
    }
    expect(h.state).toBe('polling');
    Fake.all.at(-1)!.open();
    expect(h.state).toBe('live');
  });

  it('a limit error from Hyperliquid stops the socket for a minute and reports polling', () => {
    const h = mk();
    h.subscribe({ type: 'allMids' }, () => undefined);
    Fake.all[0]!.open();
    Fake.all[0]!.push('error', 'Too many subscriptions');
    expect(h.state).toBe('polling');
    expect(Fake.all).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    expect(Fake.all).toHaveLength(2);
  });

  it('a hidden tab gives up the socket after the grace period and takes it back when shown', () => {
    const h = mk(1000);
    h.subscribe({ type: 'allMids' }, () => undefined);
    Fake.all[0]!.open();
    h.setHidden(true);
    vi.advanceTimersByTime(500);
    expect(h.state).toBe('live');
    vi.advanceTimersByTime(600);
    expect(h.state).toBe('paused');
    h.setHidden(false);
    expect(Fake.all).toHaveLength(2);
    Fake.all[1]!.open();
    expect(h.state).toBe('live');
  });

  it('ignores junk messages and pongs', () => {
    const h = mk();
    const f = vi.fn();
    h.subscribe({ type: 'allMids' }, f);
    Fake.all[0]!.open();
    Fake.all[0]!.onmessage?.({ data: 'not json' });
    Fake.all[0]!.push('pong', {});
    expect(f).not.toHaveBeenCalled();
    expect(subKey({ type: 'activeAssetCtx', coin: 'BTC' })).toBe('activeAssetCtx||BTC');
  });
});

/**
 * Epic 1.4 gate ("websocket-client.phase-1.test.ts" per
 * docs/testing/phase-gate-testing.md), task 1.4.1 slice.
 *
 * Adopting the SDK's WS subscription transport and validating its reconnect
 * story, with wrapper-level handling for the gaps the SDK leaves to the
 * consumer. Everything here runs against a *local* mock Hyperliquid WS server
 * (the `ws` package), never live network — the mock speaks the real
 * subscription wire protocol (`{method:"subscribe",subscription}` →
 * `{channel:"subscriptionResponse",data}` echo, `{channel:<name>,data}` pushes,
 * `{method:"ping"}` → `{channel:"pong"}`), so the real
 * `@nktkas/hyperliquid` `WebSocketTransport`/`SubscriptionClient` drive it.
 *
 * Coverage:
 *  - Adopt the SDK WS transport: subscribe to `allMids` and receive a push.
 *  - Reconnect + backoff + automatic resubscribe: kill the connection, assert
 *    the transport reconnects, re-sends the subscribe, and the listener keeps
 *    receiving — with no duplicate delivery across the gap.
 *  - Heartbeat/staleness detection surfaces a signal: the socket stays open but
 *    frames stop; the wrapper flips to `stale` and recovers to `open` on the
 *    next frame.
 *  - Transport pluggable: a custom `transportFactory` (the seam Phase 2 Epic
 *    2.4.3's egress binding uses) is used for every subscribe and drives the
 *    connection-status signal.
 */
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { HlSubscriptionClient } from '../../src/hl';
import type {
  HlSubscriptionTransport,
  HlWsConnectionStatus,
  HlWsNotification,
  HlWsOrderUpdatesEvent,
  HlWsSubscribeOptions,
  HlWsSubscription,
  HlWsTradesEvent,
  HlWsUserFillsEvent,
} from '../../src/hl';

// ── Mock Hyperliquid WS server ─────────────────────────────────────────────

interface MockServer {
  url: string;
  /** Total `subscribe` frames received across all connections (resubscribe counter). */
  subscribeCount(): number;
  /** Every `subscribe` frame's `subscription` payload, in receipt order (across all connections). */
  subscribeLog(): unknown[];
  /** Push a channel frame to every currently-connected client. */
  push(channel: string, data: unknown): void;
  /** Drop every live connection without shutting the server down (simulates a mid-stream cut). */
  killConnections(): void;
  connectionCount(): number;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const clients = new Set<WsSocket>();
  const subscriptions: unknown[] = [];

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      let msg: { method?: string; subscription?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method === 'ping') {
        socket.send(JSON.stringify({ channel: 'pong' }));
        return;
      }
      if (msg.method === 'subscribe') {
        subscriptions.push(msg.subscription);
        socket.send(
          JSON.stringify({
            channel: 'subscriptionResponse',
            data: { method: 'subscribe', subscription: msg.subscription },
          })
        );
        return;
      }
      if (msg.method === 'unsubscribe') {
        socket.send(
          JSON.stringify({
            channel: 'subscriptionResponse',
            data: { method: 'unsubscribe', subscription: msg.subscription },
          })
        );
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    subscribeCount: () => subscriptions.length,
    subscribeLog: () => [...subscriptions],
    push: (channel, data) => {
      const frame = JSON.stringify({ channel, data });
      for (const c of clients) c.send(frame);
    },
    killConnections: () => {
      for (const c of clients) c.terminate();
      clients.clear();
    },
    connectionCount: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.terminate();
        clients.clear();
        wss.close(() => resolve());
      }),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe('Epic 1.4.1 — SDK WS transport + wrapped reconnect story', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('adopts the SDK WS transport: subscribes and receives channel pushes', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      // Ping seldom so heartbeat frames don't interfere with the assertions.
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const received: Record<string, string>[] = [];
    await client.subscribeAllMids((data) => received.push(data.mids));

    server.push('allMids', { mids: { ETH: '2000.0', BTC: '50000.0' } });
    await waitFor(() => received.length >= 1);

    expect(received[0]).toEqual({ ETH: '2000.0', BTC: '50000.0' });
    expect(client.connectionStatus).toBe('open');
  });

  it('reconnects with backoff, resubscribes automatically, and delivers no duplicate events', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const statuses: HlWsConnectionStatus[] = [];
    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
      reconnect: { reconnectionDelayMs: 20 },
    });
    cleanups.push(() => client.close());
    client.onConnectionStatusChange((s) => statuses.push(s));

    const received: Record<string, string>[] = [];
    await client.subscribeAllMids((data) => received.push(data.mids));
    expect(server.subscribeCount()).toBe(1);

    // First frame lands on the original connection.
    server.push('allMids', { mids: { ETH: '2000.0' } });
    await waitFor(() => received.length === 1);

    // Cut the socket mid-stream; the SDK transport should reconnect and re-send
    // the subscribe frame without any action from the consumer.
    server.killConnections();
    await waitFor(() => statuses.includes('reconnecting'));
    await waitFor(() => server.subscribeCount() === 2);
    await waitFor(() => client.connectionStatus === 'open');

    // Post-reconnect frame is delivered exactly once — the resubscribe reused
    // the same listener registration rather than stacking a second one.
    server.push('allMids', { mids: { ETH: '2100.0' } });
    await waitFor(() => received.length === 2);
    // Give any accidental duplicate a chance to arrive before asserting.
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toEqual([{ ETH: '2000.0' }, { ETH: '2100.0' }]);
    expect(statuses).toContain('reconnecting');
    expect(statuses).toContain('open');
  });

  it('surfaces a staleness signal when the socket stays open but frames stop', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const statuses: HlWsConnectionStatus[] = [];
    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      // Ping window far beyond the test so the connection is never torn down;
      // isolates staleness from reconnect.
      keepAlive: { intervalMs: 60_000, timeoutMs: 30_000 },
      stalenessTimeoutMs: 120,
    });
    cleanups.push(() => client.close());
    client.onConnectionStatusChange((s) => statuses.push(s));

    const received: Record<string, string>[] = [];
    await client.subscribeAllMids((data) => received.push(data.mids));

    server.push('allMids', { mids: { ETH: '2000.0' } });
    await waitFor(() => received.length === 1);
    expect(client.connectionStatus).toBe('open');

    // No frames for longer than the staleness window: the socket is still up
    // (no reconnect), but the wrapper reports the stall.
    await waitFor(() => client.connectionStatus === 'stale');
    expect(server.connectionCount()).toBe(1);
    expect(statuses).toContain('stale');

    // A fresh frame clears the stale signal.
    server.push('allMids', { mids: { ETH: '2001.0' } });
    await waitFor(() => client.connectionStatus === 'open');
    expect(received).toEqual([{ ETH: '2000.0' }, { ETH: '2001.0' }]);
  });

  it('routes every subscription through an injected transport (egress seam) and derives status from its socket', async () => {
    // A hand-rolled transport standing in for what Phase 2 Epic 2.4.3's
    // hl-egress supplies: it records what the wrapper subscribes to and exposes
    // a socket EventTarget the test drives manually.
    const socket = new EventTarget();
    const subscribeCalls: Array<{ channel: string; payload: unknown }> = [];
    let closed = false;

    const fakeTransport: HlSubscriptionTransport = {
      socket,
      subscribe<T>(
        channel: string,
        payload: unknown,
        _listener: (event: { detail: T }) => void,
        _options?: HlWsSubscribeOptions
      ): Promise<HlWsSubscription> {
        subscribeCalls.push({ channel, payload });
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
      ready: () => Promise.resolve(),
      close: () => {
        closed = true;
      },
    };

    const statuses: HlWsConnectionStatus[] = [];
    const client = new HlSubscriptionClient({
      network: 'testnet',
      stalenessTimeoutMs: 60,
      transportFactory: () => fakeTransport,
    });
    cleanups.push(() => client.close());
    client.onConnectionStatusChange((s) => statuses.push(s));

    await client.subscribeAllMids(() => {});
    await client.subscribeL2Book({ coin: 'ETH' }, () => {});
    await client.subscribeCandle({ coin: 'BTC', interval: '1m' }, () => {});

    expect(subscribeCalls.map((c) => c.channel)).toEqual(['allMids', 'l2Book', 'candle']);
    expect(subscribeCalls[0].payload).toMatchObject({ type: 'allMids' });
    expect(subscribeCalls[1].payload).toMatchObject({ type: 'l2Book', coin: 'ETH' });
    expect(subscribeCalls[2].payload).toMatchObject({ type: 'candle', coin: 'BTC', interval: '1m' });

    // The wrapper derives connection status from the injected socket's events.
    socket.dispatchEvent(new Event('open'));
    expect(client.connectionStatus).toBe('open');

    socket.dispatchEvent(new Event('close'));
    expect(client.connectionStatus).toBe('reconnecting');

    socket.dispatchEvent(new Event('open'));
    await waitFor(() => client.connectionStatus === 'stale');
    expect(statuses).toEqual(['open', 'reconnecting', 'open', 'stale']);

    // A message on the injected socket clears staleness.
    socket.dispatchEvent(new MessageEvent('message', { data: '{}' }));
    expect(client.connectionStatus).toBe('open');

    client.close();
    expect(closed).toBe(true);
    expect(client.connectionStatus).toBe('closed');
  });
});

describe('Epic 1.4.2 — user / trades / notification channels', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  const USER = '0x1234567890123456789012345678901234567890';

  it('subscribes to userFills and receives typed fill events', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const received: HlWsUserFillsEvent[] = [];
    await client.subscribeUserFills({ user: USER }, (data) => received.push(data));

    server.push('userFills', {
      user: USER,
      isSnapshot: true,
      fills: [
        {
          coin: 'ETH',
          px: '2000.0',
          sz: '1.0',
          side: 'B',
          time: 1_700_000_000_000,
          startPosition: '0.0',
          dir: 'Open Long',
          closedPnl: '0.0',
          hash: '0xabc',
          oid: 1,
          crossed: true,
          fee: '0.5',
          tid: 1,
          feeToken: 'USDC',
          twapId: null,
        },
      ],
    });
    await waitFor(() => received.length >= 1);

    expect(received[0].user).toBe(USER);
    expect(received[0].isSnapshot).toBe(true);
    expect(received[0].fills[0]).toMatchObject({ coin: 'ETH', px: '2000.0', side: 'B' });
  });

  it('subscribes to orderUpdates and receives typed order-status events', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const received: HlWsOrderUpdatesEvent[] = [];
    await client.subscribeOrderUpdates({ user: USER }, (data) => received.push(data));

    server.push('orderUpdates', [
      {
        order: {
          coin: 'BTC',
          side: 'B',
          limitPx: '50000.0',
          sz: '0.1',
          oid: 42,
          timestamp: 1_700_000_000_000,
          origSz: '0.1',
        },
        status: 'open',
        statusTimestamp: 1_700_000_000_100,
      },
    ]);
    await waitFor(() => received.length >= 1);

    expect(received[0]).toEqual([
      {
        order: {
          coin: 'BTC',
          side: 'B',
          limitPx: '50000.0',
          sz: '0.1',
          oid: 42,
          timestamp: 1_700_000_000_000,
          origSz: '0.1',
        },
        status: 'open',
        statusTimestamp: 1_700_000_000_100,
      },
    ]);
  });

  it('subscribes to trades and receives typed trade events for the requested coin', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const received: HlWsTradesEvent[] = [];
    await client.subscribeTrades({ coin: 'ETH' }, (data) => received.push(data));

    server.push('trades', [
      {
        coin: 'ETH',
        side: 'B',
        px: '2000.0',
        sz: '1.0',
        time: 1_700_000_000_000,
        hash: '0xdeadbeef',
        tid: 99,
        users: [USER, '0x0000000000000000000000000000000000000000'],
      },
    ]);
    await waitFor(() => received.length >= 1);

    expect(received[0]).toHaveLength(1);
    expect(received[0][0]).toMatchObject({ coin: 'ETH', px: '2000.0', tid: 99 });
  });

  it('subscribes to notification and receives typed notification events', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const received: HlWsNotification[] = [];
    await client.subscribeNotification({ user: USER }, (data) => received.push(data));

    server.push('notification', { notification: 'Your order was filled.' });
    await waitFor(() => received.length >= 1);

    expect(received[0]).toEqual({ notification: 'Your order was filled.' });
  });

  it('leaves existing l2Book/allMids consumers unaffected', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
    });
    cleanups.push(() => client.close());

    const mids: Record<string, string>[] = [];
    const books: unknown[] = [];
    await client.subscribeAllMids((data) => mids.push(data.mids));
    await client.subscribeL2Book({ coin: 'ETH' }, (data) => books.push(data));

    server.push('allMids', { mids: { ETH: '2000.0' } });
    server.push('l2Book', { coin: 'ETH', time: 1, levels: [[], []] });
    await waitFor(() => mids.length >= 1 && books.length >= 1);

    expect(mids[0]).toEqual({ ETH: '2000.0' });
    expect(books[0]).toEqual({ coin: 'ETH', time: 1, levels: [[], []] });
  });
});

describe('Epic 1.4.3 — reconnection + resubscription integration test', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  const USER = '0x1234567890123456789012345678901234567890';

  it('re-establishes every prior subscription across every channel after a mid-stream kill, with no duplicate or dropped events across the gap', async () => {
    const server = await startMockServer();
    cleanups.push(() => server.close());

    const statuses: HlWsConnectionStatus[] = [];
    const client = new HlSubscriptionClient({
      network: 'mainnet',
      url: server.url,
      keepAlive: { intervalMs: 60_000, timeoutMs: 5_000 },
      reconnect: { reconnectionDelayMs: 20 },
    });
    cleanups.push(() => client.close());
    client.onConnectionStatusChange((s) => statuses.push(s));

    const mids: Record<string, string>[] = [];
    const books: unknown[] = [];
    const fills: HlWsUserFillsEvent[] = [];
    const trades: HlWsTradesEvent[] = [];
    const notifications: HlWsNotification[] = [];
    const orderUpdates: HlWsOrderUpdatesEvent[] = [];

    // Six concurrent subscriptions spanning every channel this epic added,
    // established on the same (original) connection.
    await client.subscribeAllMids((data) => mids.push(data.mids));
    await client.subscribeL2Book({ coin: 'ETH' }, (data) => books.push(data));
    await client.subscribeUserFills({ user: USER }, (data) => fills.push(data));
    await client.subscribeTrades({ coin: 'BTC' }, (data) => trades.push(data));
    await client.subscribeNotification({ user: USER }, (data) => notifications.push(data));
    await client.subscribeOrderUpdates({ user: USER }, (data) => orderUpdates.push(data));
    expect(server.subscribeCount()).toBe(6);

    // One event per channel before the gap.
    server.push('allMids', { mids: { ETH: '2000.0' } });
    server.push('l2Book', { coin: 'ETH', time: 1, levels: [[], []] });
    server.push('userFills', { user: USER, isSnapshot: true, fills: [] });
    server.push('trades', [
      { coin: 'BTC', side: 'B', px: '50000.0', sz: '1.0', time: 1, hash: '0x1', tid: 1, users: [USER] },
    ]);
    server.push('notification', { notification: 'first' });
    server.push('orderUpdates', []);
    await waitFor(
      () =>
        mids.length === 1 &&
        books.length === 1 &&
        fills.length === 1 &&
        trades.length === 1 &&
        notifications.length === 1 &&
        orderUpdates.length === 1
    );

    // Kill every live connection mid-stream, across the gap where no events
    // can be delivered at all.
    server.killConnections();
    await waitFor(() => statuses.includes('reconnecting'));
    await waitFor(() => server.subscribeCount() === 12);
    await waitFor(() => client.connectionStatus === 'open');

    // Every one of the six original subscriptions was re-sent exactly once —
    // none dropped, none duplicated.
    const typeCounts = server.subscribeLog().reduce<Record<string, number>>((acc, sub) => {
      const type = (sub as { type: string }).type;
      acc[type] = (acc[type] ?? 0) + 1;
      return acc;
    }, {});
    expect(typeCounts).toEqual({
      allMids: 2,
      l2Book: 2,
      userFills: 2,
      trades: 2,
      notification: 2,
      orderUpdates: 2,
    });

    // One fresh event per channel after reconnect — each listener registration
    // was reused rather than stacked, so every channel resumes exactly once.
    server.push('allMids', { mids: { ETH: '2100.0' } });
    server.push('l2Book', { coin: 'ETH', time: 2, levels: [[], []] });
    server.push('userFills', { user: USER, isSnapshot: false, fills: [] });
    server.push('trades', [
      { coin: 'BTC', side: 'S', px: '50100.0', sz: '2.0', time: 2, hash: '0x2', tid: 2, users: [USER] },
    ]);
    server.push('notification', { notification: 'second' });
    server.push('orderUpdates', []);
    await waitFor(
      () =>
        mids.length === 2 &&
        books.length === 2 &&
        fills.length === 2 &&
        trades.length === 2 &&
        notifications.length === 2 &&
        orderUpdates.length === 2
    );
    // Give any accidental duplicate delivery a chance to arrive before asserting.
    await new Promise((r) => setTimeout(r, 100));

    expect(mids).toEqual([{ ETH: '2000.0' }, { ETH: '2100.0' }]);
    expect(books).toEqual([
      { coin: 'ETH', time: 1, levels: [[], []] },
      { coin: 'ETH', time: 2, levels: [[], []] },
    ]);
    expect(fills.map((f) => f.isSnapshot)).toEqual([true, false]);
    expect(trades.map((t) => t[0].tid)).toEqual([1, 2]);
    expect(notifications).toEqual([{ notification: 'first' }, { notification: 'second' }]);
    expect(orderUpdates).toEqual([[], []]);
  });
});

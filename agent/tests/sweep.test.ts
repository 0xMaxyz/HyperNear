import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { HyperNearClient, type NearBackend, type SignOut } from '@hypernear/client';
import { clearFrozen, livePorts, sweepFrozen, sweptEvent, type SweepPorts } from '../src/sweep.ts';

const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;
const addr = (i: number) => `0x${String(i).repeat(40)}` as Hex;

const signOut = (n: number): SignOut => ({ payload: 'aa', big_r: `03${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id: 0, nonce: 1794000000000 + n, action: { type: 'cancel', cancels: [] } });

/** NEAR backend: legs 0..2 registered (addr 1..3), cancel_orders signs, or fails for one leg. */
function backend(o: { frozen?: boolean; failLeg?: number } = {}) {
  const calls: { leg: number; n: number }[] = [];
  const b: NearBackend = {
    async view<T>(_c: string, method: string, args: Record<string, unknown>) {
      if (method === 'get_owner') return { nonce: 0, frozen: o.frozen ?? true } as T;
      if (method === 'get_leg') return ((args.leg as number) < 3 ? addr((args.leg as number) + 1) : null) as T;
      throw new Error(`view ${method}`);
    },
    async call<T>(_c: string, method: string, args: Record<string, unknown>) {
      if (method !== 'cancel_orders') throw new Error(`call ${method}`);
      if (args.leg === o.failLeg) throw new Error('cancel_orders failed: Smart contract panicked: leg not registered');
      calls.push({ leg: args.leg as number, n: (args.cancels as unknown[]).length });
      return { txHash: `tx${calls.length}`, value: signOut(calls.length) as T };
    },
  };
  return { b, calls };
}
const book = (perByLeg: Record<string, { coin: string; oid: number }[]>) => ({
  meta: async () => ({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
  openOrders: async ({ user }: { user: Hex }) => perByLeg[user] ?? [],
});
const orders = (n: number, coin = 'BTC') => Array.from({ length: n }, (_, i) => ({ coin, oid: 100 + i }));

/** Records the bodies posted to HL; `answer(n)` is HL's reply to the n-th post. */
function stubHl(answer: (n: number) => unknown) {
  const posts: any[] = [];
  vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify(answer(posts.length)));
  });
  return posts;
}
const ok = (n: number) => ({ status: 'ok', response: { type: 'cancel', data: { statuses: Array(n).fill('success') } } });
afterEach(() => {
  vi.unstubAllGlobals();
});

const live = (be: ReturnType<typeof backend>, perByLeg: Parameters<typeof book>[0]) =>
  livePorts({ client: new HyperNearClient({ contractId: 'leash.testnet', backend: be.b }), hl: book(perByLeg) as never, network: 'testnet' });

describe('sweepFrozen (mocked ports)', () => {
  it("reads each leg's book, asks for cancels, posts them, and counts what HL cancelled", async () => {
    const posted: unknown[] = [];
    const p: SweepPorts = {
      legs: async () => [{ leg: 0, address: addr(1) }, { leg: 1, address: addr(2) }],
      openOrders: async (a) => (a === addr(1) ? { cancels: [{ a: 3, o: 1 }, { a: 3, o: 2 }], skipped: 1 } : { cancels: [], skipped: 0 }),
      cancelFrozen: async ({ cancels, onBatch }) => void (await onBatch({ cancels, txHash: 'txA', out: signOut(1) })),
      post: async (out) => (posted.push(out), ok(2) as never),
    };
    expect(await sweepFrozen(OWNER, p)).toEqual([
      { leg: 0, address: addr(1), found: 3, skipped: 1, cancelled: 2, txHashes: ['txA'], hl: ['ok'] },
      { leg: 1, address: addr(2), found: 0, skipped: 0, cancelled: 0, txHashes: [], hl: [] },
    ]);
    expect(posted).toHaveLength(1);
  });

  it('an error on one leg is recorded and the other legs are still swept', async () => {
    const calls: number[] = [];
    const p: SweepPorts = {
      legs: async () => [0, 1, 2].map((leg) => ({ leg, address: addr(leg + 1) })),
      openOrders: async () => ({ cancels: [{ a: 3, o: 1 }], skipped: 0 }),
      cancelFrozen: async ({ leg, cancels, onBatch }) => {
        calls.push(leg);
        if (leg === 1) throw new Error('NEAR RPC timeout');
        await onBatch({ cancels, txHash: `tx${leg}`, out: signOut(leg) });
      },
      post: async () => ok(1) as never,
    };
    const r = await sweepFrozen(OWNER, p);
    expect(calls).toEqual([0, 1, 2]);
    expect(r.map((l) => [l.leg, l.cancelled, l.error])).toEqual([[0, 1, undefined], [1, 0, 'NEAR RPC timeout'], [2, 1, undefined]]);
  });

  it('a leg whose open-orders read fails does not stop the sweep', async () => {
    const p: SweepPorts = {
      legs: async () => [{ leg: 0, address: addr(1) }, { leg: 1, address: addr(2) }],
      openOrders: async (a) => {
        if (a === addr(1)) throw new Error('HL info 502');
        return { cancels: [{ a: 3, o: 1 }], skipped: 0 };
      },
      cancelFrozen: async ({ cancels, onBatch }) => void (await onBatch({ cancels, txHash: 'tx', out: signOut(1) })),
      post: async () => ok(1) as never,
    };
    const r = await sweepFrozen(OWNER, p);
    expect(r[0]).toMatchObject({ error: 'HL info 502', cancelled: 0 });
    expect(r[1]).toMatchObject({ cancelled: 1 });
  });
});

describe('sweepFrozen with the real client and live ports (NEAR and HL stubbed)', () => {
  it('more than 16 open orders: three contract calls, three posts, 35 cancelled, empty legs cost no NEAR call', async () => {
    const be = backend();
    const sizes = [16, 16, 3];
    stubHl((n) => ok(sizes[n - 1]!));
    const r = await sweepFrozen(OWNER, live(be, { [addr(1)]: orders(35) }));
    expect(be.calls).toEqual([{ leg: 0, n: 16 }, { leg: 0, n: 16 }, { leg: 0, n: 3 }]);
    expect(r[0]).toMatchObject({ leg: 0, found: 35, cancelled: 35, hl: ['ok', 'ok', 'ok'] });
    expect(r[0]!.txHashes).toHaveLength(3);
    expect(r.slice(1).map((l) => l.found)).toEqual([0, 0]);
  });

  it('posts the L1 body without user-action fields, and skips spot orders', async () => {
    const be = backend();
    const posts = stubHl(() => ok(1));
    const r = await sweepFrozen(OWNER, live(be, { [addr(1)]: [...orders(1), { coin: '@107', oid: 9 }] }));
    expect(r[0]).toMatchObject({ found: 2, skipped: 1, cancelled: 1 });
    expect(posts[0]).toMatchObject({ nonce: 1794000000001, vaultAddress: null, signature: { v: 27 } });
    expect(JSON.stringify(posts[0])).not.toMatch(/signatureChainId|hyperliquidChain/);
  });

  it('a contract error on leg 1 does not stop legs 0 and 2; an HL error on one batch does not stop the next', async () => {
    const be = backend({ failLeg: 1 });
    stubHl((n) => (n === 1 ? { status: 'err', response: 'rate limited' } : ok(1)));
    const r = await sweepFrozen(OWNER, live(be, { [addr(1)]: orders(17), [addr(2)]: orders(1), [addr(3)]: orders(1) }));
    expect(r[0]).toMatchObject({ found: 17, hl: ['err: rate limited', 'ok'], cancelled: 1 }); // batch 1 failed at HL, batch 2 still went
    expect(r[1]).toMatchObject({ error: expect.stringContaining('leg not registered'), cancelled: 0 });
    expect(r[2]).toMatchObject({ cancelled: 1, hl: ['ok'] });
  });
});

describe('clearFrozen', () => {
  it('refuses an owner that is not frozen (that needs the owner-signed intent) and an unknown owner', async () => {
    const client = (be: ReturnType<typeof backend>) => new HyperNearClient({ contractId: 'leash.testnet', backend: be.b });
    await expect(clearFrozen(OWNER, { client: client(backend({ frozen: false })), hl: book({}) as never, network: 'testnet' })).rejects.toThrow(/not frozen/);
    const none = backend();
    none.b.view = (async () => null) as never;
    await expect(clearFrozen(OWNER, { client: client(none), hl: book({}) as never, network: 'testnet' })).rejects.toThrow(/unknown/);
  });
});

describe('orders.swept event payload', () => {
  it('names the owner, the trigger, a per-leg result and the total', () => {
    const legs = [{ leg: 0, address: addr(1), found: 2, skipped: 0, cancelled: 2, txHashes: ['t'], hl: ['ok'] }];
    expect(sweptEvent(OWNER, legs, 1234)).toEqual({ owner: OWNER, trigger: 'freeze', legs, cancelled: 2, ms: 1234 });
    expect(sweptEvent(OWNER, [], 5, 'boom')).toMatchObject({ error: 'boom', cancelled: 0 });
  });
});

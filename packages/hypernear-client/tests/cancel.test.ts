import { describe, expect, it, vi } from 'vitest';
import { HL_API, l1ExchangeBody, HyperNearClient, HyperNearError, MAX_CANCELS_PER_CALL, postL1, type SignOut } from '../src';
import { CONFIG, mockBackend, OWNER } from './helpers';

const out = (nonce = 1794134049350, recovery_id = 1): SignOut => ({
  payload: 'aa'.repeat(32), big_r: `03${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id, nonce,
  action: { type: 'cancel', cancels: [{ a: 3, o: 64820881296 }] },
});
const orders = (n: number) => Array.from({ length: n }, (_, i) => ({ a: 3, o: 1000 + i }));

describe('l1ExchangeBody (a contract-signed L1 cancel)', () => {
  it('is {action, nonce, signature, vaultAddress: null} with no user-action fields', () => {
    const b = l1ExchangeBody(out());
    expect(b).toEqual({
      action: { type: 'cancel', cancels: [{ a: 3, o: 64820881296 }] },
      nonce: 1794134049350,
      signature: { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 28 },
      vaultAddress: null,
    });
    expect(JSON.stringify(b)).not.toMatch(/signatureChainId|hyperliquidChain/);
  });
  it('v is 27 + recovery_id', () => {
    expect(l1ExchangeBody(out(1, 0)).signature.v).toBe(27);
  });
  it('refuses a SignOut that is not an L1 action', () => {
    expect(() => l1ExchangeBody({ ...out(), nonce: undefined })).toThrow(HyperNearError);
    expect(() => l1ExchangeBody({ ...out(), action: null })).toThrow(HyperNearError);
  });
});

describe('postL1', () => {
  it('POSTs the body to the network\'s /exchange and returns HL\'s answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', response: { data: { statuses: ['success'] } } })));
    const r = await postL1(out(), 'testnet', fetchImpl as never);
    expect(r).toEqual({ status: 'ok', response: { data: { statuses: ['success'] } } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HL_API.testnet}/exchange`);
    expect(JSON.parse(init.body as string)).toEqual(l1ExchangeBody(out()));
    expect(HL_API.mainnet).toBe('https://api.hyperliquid.xyz');
  });
  it('turns a non-JSON answer into status err instead of throwing', async () => {
    const r = await postL1(out(), 'testnet', (async () => new Response('<html>', { status: 502 })) as never);
    expect(r).toMatchObject({ status: 'err', response: expect.stringContaining('HTTP 502') });
  });
});

describe('HyperNearClient.cancelFrozen', () => {
  const setup = (fail?: (n: number) => string | undefined) => {
    let n = 0;
    const m = mockBackend({ views: { get_config: () => CONFIG }, sign: () => out(1794134049350 + n), fail: () => fail?.(++n) });
    return { ...m, client: new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend }) };
  };

  it('one cancel_orders call for up to 16 cancels, 300 TGas, owner lowercased', async () => {
    const t = setup();
    const r = await t.client.cancelFrozen({ owner: OWNER.toUpperCase().replace('0X', '0x') as never, leg: 2, cancels: orders(MAX_CANCELS_PER_CALL) });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: 'cancel_orders', args: { owner: OWNER, leg: 2 }, opts: { gasTgas: 300 } });
    expect(t.calls[0]!.args.cancels).toHaveLength(16);
    expect(r).toHaveLength(1);
  });

  it('more than 16 are split into several calls, in order, each result returned', async () => {
    const t = setup();
    const seen: number[] = [];
    const r = await t.client.cancelFrozen({ owner: OWNER, leg: 0, cancels: orders(35), onBatch: (b) => void seen.push(b.cancels.length) });
    expect(t.calls.map((c) => c.args.cancels.length)).toEqual([16, 16, 3]);
    expect(t.calls[1]!.args.cancels[0].o).toBe(1016);
    expect(r.map((b) => b.cancels.length)).toEqual([16, 16, 3]);
    expect(r.map((b) => b.txHash)).toEqual(['tx1', 'tx2', 'tx3']);
    expect(seen).toEqual([16, 16, 3]);
  });

  it('no cancels, no calls', async () => {
    const t = setup();
    expect(await t.client.cancelFrozen({ owner: OWNER, leg: 0, cancels: [] })).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('a failing batch rejects, but what was already signed was handed to onBatch first', async () => {
    const t = setup((n) => (n === 2 ? 'owner is not frozen: use the owner-signed cancelOrders intent' : undefined));
    const seen: number[] = [];
    await expect(t.client.cancelFrozen({ owner: OWNER, leg: 0, cancels: orders(20), onBatch: (b) => void seen.push(b.cancels.length) })).rejects.toThrow(/not frozen/);
    expect(seen).toEqual([16]);
  });
});

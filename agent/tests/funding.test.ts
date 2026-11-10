import { describe, expect, it } from 'vitest';
import { fundingService, HYPERCORE_USDC, validRefund } from '../src/funding';

const TOKENS = [
  { assetId: 'nep141:eth-arb', symbol: 'ETH', blockchain: 'arb', decimals: 18, price: 2000 },
  { assetId: 'nep141:usdc-arb', symbol: 'USDC', blockchain: 'arb', decimals: 6, price: 1 },
  { assetId: 'nep141:usdc-near', symbol: 'USDC', blockchain: 'near', decimals: 6, price: 1 },
  { assetId: 'nep141:doge', symbol: 'DOGE', blockchain: 'eth', decimals: 8, price: 0.1 },
];
const EOA = '0x1111111111111111111111111111111111111111';
const LEG = '0x2222222222222222222222222222222222222222';

/** A 1Click stand-in: records every call and answers like the real API did on 2026-11-10. */
function stub(opts: { tokens?: unknown; quote?: unknown; quoteStatus?: number; down?: boolean } = {}) {
  const calls: { path: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('https://1c.test', '');
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (opts.down) throw new Error('connection refused');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v0/tokens') return json(200, opts.tokens ?? TOKENS);
    if (path === '/v0/quote') {
      return json(opts.quoteStatus ?? 200, opts.quote ?? { correlationId: 'c1', quote: { amountOut: '982000000', minAmountOut: '972000000', withdrawFee: '31530000', timeEstimate: 35, depositAddress: 'deposit-address-1', deadline: '2026-11-10T20:00:00Z' } });
    }
    if (path.startsWith('/v0/status')) return json(200, { status: 'SUCCESS', updatedAt: 'now' });
    return json(404, {});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const svc = (network: 'testnet' | 'mainnet', s = stub(), extra = {}) => ({ s, f: fundingService({ network, api: 'https://1c.test', fetchFn: s.fetchFn, ...extra }) });
const req = { token: 'nep141:usdc-arb', amount: '10', recipient: LEG, refundTo: EOA, activation: 'paid' as const };

describe('funding', () => {
  it('offers only the allow-listed tokens, stables first, and asks 1Click for the list once', async () => {
    const { s, f } = svc('testnet');
    const info = await f.info();
    expect(info.tokens.map((t) => t.label)).toEqual(['USDC on NEAR', 'USDC on Arbitrum', 'ETH on Arbitrum']);
    await f.info();
    expect(s.calls.filter((c) => c.path === '/v0/tokens')).toHaveLength(1);
    expect(info).toMatchObject({ network: 'testnet', realDeposits: false, tokenList: 'live' });
  });

  it('falls back to the two checked assets when 1Click cannot be reached', async () => {
    const { f } = svc('mainnet', stub({ down: true }));
    const info = await f.info();
    expect(info.tokenList).toBe('fallback');
    expect(info.tokens.map((t) => t.label)).toEqual(['USDC on NEAR', 'USDC on Arbitrum']);
  });

  it('testnet: a quote is always a dry preview, even when asked for a real one, and shows no deposit address', async () => {
    const { s, f } = svc('testnet');
    const q = await f.quote({ ...req, dry: false, activation: 'owed-on-credit' });
    const body = s.calls.find((c) => c.path === '/v0/quote')!.body;
    expect(body).toMatchObject({ dry: true, originAsset: 'nep141:usdc-arb', destinationAsset: HYPERCORE_USDC.id, recipient: LEG, refundTo: EOA, amount: '10000000', swapType: 'EXACT_INPUT', recipientType: 'DESTINATION_CHAIN' });
    expect(q).toMatchObject({ dry: true, depositAddress: null, amountOut: 9.82, activationFeeUsd: 1, etaSec: 35 });
    expect(q.expectedCredit).toBeCloseTo(8.82, 6); // the new leg's 1 USDC activation fee comes off the credit
    expect(q.withdrawFeeUsd).toBeCloseTo(0.3153, 6);
  });

  it('mainnet: a real quote only on an explicit dry:false, and then it carries the deposit address', async () => {
    const real = svc('mainnet');
    const q = await real.f.quote({ ...req, dry: false });
    expect(real.s.calls.find((c) => c.path === '/v0/quote')!.body.dry).toBe(false);
    expect(q).toMatchObject({ dry: false, depositAddress: 'deposit-address-1', deadline: '2026-11-10T20:00:00Z' });
    const preview = svc('mainnet');
    expect((await preview.f.quote(req)).depositAddress).toBeNull();
    expect(preview.s.calls.find((c) => c.path === '/v0/quote')!.body.dry).toBe(true);
  });

  it('converts a non-USDC token at 1Click price for the limits and the units', async () => {
    const { s, f } = svc('testnet');
    const q = await f.quote({ ...req, token: 'nep141:eth-arb', amount: '0.005' });
    expect(s.calls.find((c) => c.path === '/v0/quote')!.body.amount).toBe('5000000000000000');
    expect(q.amountInUsd).toBeCloseTo(10, 6);
  });

  it('refuses what it should, before calling 1Click', async () => {
    const { s, f } = svc('mainnet');
    const refused = async (patch: Record<string, unknown>, status: number, message: RegExp) => {
      await expect(f.quote({ ...req, ...patch } as typeof req)).rejects.toMatchObject({ status, message: expect.stringMatching(message) });
    };
    await refused({ token: 'nep141:doge' }, 400, /not one this agent funds from/);
    await refused({ amount: '2' }, 400, /minimum/);
    await refused({ amount: '51' }, 400, /maximum/);
    await refused({ amount: '-5' }, 400, /positive decimal/);
    await refused({ amount: '1e3' }, 400, /positive decimal/);
    await refused({ refundTo: 'not-an-address' }, 400, /refundTo must be your own Arbitrum address/);
    await refused({ refundTo: '' }, 400, /refundTo/);
    await refused({ recipient: 'leg0' }, 400, /leg address/);
    expect(s.calls.filter((c) => c.path === '/v0/quote')).toHaveLength(0);
  });

  it('refuses a deposit that the activation fee would eat entirely', async () => {
    const { f } = svc('testnet', stub({ quote: { quote: { amountOut: '90000000' } } })); // 0.9 USDC arrives
    await expect(f.quote({ ...req, amount: '3', activation: 'owed-on-credit' })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/activation fee/) });
  });

  it('reports a 1Click error and an unreachable 1Click as errors the page can show', async () => {
    await expect(svc('testnet', stub({ quoteStatus: 400, quote: { message: 'Amount is too low for the destination chain' } })).f.quote(req)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/too low/) });
    const down = fundingService({ network: 'testnet', api: 'https://1c.test', fetchFn: (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch });
    await expect(down.quote({ ...req, token: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near' })).rejects.toMatchObject({ status: 502 }); // falls back to the checked tokens, then the quote itself fails
  });

  it('status passes a deposit address through and rejects anything else', async () => {
    const { f } = svc('mainnet');
    expect(await f.status('deposit-address-1')).toMatchObject({ status: 'SUCCESS' });
    await expect(f.status('../etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(f.status('')).rejects.toMatchObject({ status: 400 });
  });

  it('knows what a refund address looks like on each chain', () => {
    expect(validRefund('arb', EOA)).toBe(true);
    expect(validRefund('arb', 'alice.near')).toBe(false);
    expect(validRefund('near', 'alice.near')).toBe(true);
    expect(validRefund('near', 'Alice.near')).toBe(false);
    expect(validRefund('near', 'a'.repeat(64))).toBe(true);
    expect(validRefund('sol', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe(true);
    expect(validRefund('sol', EOA)).toBe(false);
  });
});

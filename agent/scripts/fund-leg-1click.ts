// Fund a leg's Hyperliquid account with USDC through NEAR Intents 1Click (USDC -> HyperCore USDC, recipient = the leg).
//   node agent/scripts/fund-leg-1click.ts --to <leg 0x…> --amount 10 --from near|arb [--refund-to <addr>] [--execute]
// Default is a DRY quote (dry: true): prints amount out, fees and ETA; nothing can be sent.
// --execute asks for a real quote, prints the deposit address, then polls /v0/status until done. It never sends funds:
// the user sends `amount` of the origin USDC to the deposit address from their own wallet.
// Lands on the leg's HyperCore SPOT balance (hip1 USDC); move it to perp with an owner usdClassTransfer (toPerp).
// Optional ONECLICK_JWT (bearer) for authenticated quotes.
const API = process.env.ONECLICK_API ?? 'https://1click.chaindefuser.com';

/** 1Click asset ids (GET /v0/tokens, checked 2026-11-07). */
export const ASSETS = {
  near: { id: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, label: 'USDC on NEAR' },
  arb: { id: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, label: 'USDC on Arbitrum' },
  /** HyperCore spot USDC (HL token 0); the `erc20` hypercore asset is HyperEVM USDC, not what a leg trades with */
  hypercoreUsdc: { id: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8 },
} as const;

export interface FundArgs {
  to: string;
  amount: string;
  from: 'near' | 'arb';
  refundTo?: string;
  execute?: boolean;
}

function units(amount: string, decimals: number): string {
  const [i, f = ''] = amount.split('.');
  if (!/^\d+$/.test(i!) || !/^\d*$/.test(f) || f.length > decimals) throw new Error(`bad amount ${amount}`);
  return (BigInt(i!) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals))).toString();
}

const fmt = (raw: string | undefined, decimals: number) => (raw === undefined ? '-' : (Number(raw) / 10 ** decimals).toFixed(6));

async function call(path: string, init?: RequestInit): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const r = await fetch(`${API}${path}`, { ...init, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`1Click ${path} HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

export async function quote(a: FundArgs) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.to)) throw new Error(`--to must be the leg's 0x address: ${a.to}`);
  const origin = ASSETS[a.from];
  // dry quotes still need a well-formed refund address; real ones must be the user's own
  const refundTo = a.refundTo ?? (a.execute ? undefined : a.from === 'near' ? 'leash.near' : a.to);
  if (!refundTo) throw new Error('--refund-to is required with --execute (your own address on the origin chain)');
  const req = {
    dry: !a.execute,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100, // bps
    originAsset: origin.id,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: ASSETS.hypercoreUsdc.id,
    amount: units(a.amount, origin.decimals),
    refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: a.to,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const res = await call('/v0/quote', { method: 'POST', body: JSON.stringify(req) });
  const q = res.quote ?? {};
  const out = {
    mode: a.execute ? 'EXECUTE' : 'DRY',
    from: origin.label,
    amountIn: fmt(q.amountIn, origin.decimals),
    amountOut: fmt(q.amountOut, ASSETS.hypercoreUsdc.decimals),
    minAmountOut: fmt(q.minAmountOut, ASSETS.hypercoreUsdc.decimals),
    amountOutUsd: q.amountOutUsd,
    withdrawFee: fmt(q.withdrawFee, ASSETS.hypercoreUsdc.decimals),
    refundFee: fmt(q.refundFee, origin.decimals),
    appFeesBps: (res.quoteRequest?.appFees ?? []).map((f: { fee: number }) => f.fee),
    etaSec: q.timeEstimate,
    depositAddress: q.depositAddress ?? null,
    deadline: q.deadline ?? req.deadline,
    correlationId: res.correlationId,
  };
  return { out, raw: res };
}

export async function pollStatus(depositAddress: string, log = console.log, timeoutMs = 60 * 60_000) {
  const end = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const s = await call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
    if (s.status !== last) log(`[${new Date().toISOString().slice(11, 19)}] status ${s.status}`);
    last = s.status;
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status)) return s;
    if (Date.now() > end) throw new Error('timed out polling 1Click status');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function args(argv: string[]): FundArgs {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = (get('from') ?? 'near') as FundArgs['from'];
  if (from !== 'near' && from !== 'arb') throw new Error('--from near|arb');
  return { to: get('to') ?? '', amount: get('amount') ?? '10', from, refundTo: get('refund-to'), execute: argv.includes('--execute') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2));
  const { out } = await quote(a);
  console.log(JSON.stringify(out, null, 2));
  if (a.execute) {
    if (!out.depositAddress) throw new Error('no deposit address in the quote');
    console.log(`\nSEND ${out.amountIn} ${out.from} to ${out.depositAddress} from your wallet (this script sends nothing). Polling…`);
    const s = await pollStatus(out.depositAddress);
    console.log(JSON.stringify(s, null, 2));
  }
}

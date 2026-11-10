// Strategy library: ready-made specs for the grid and TWAP/DCA runners, sized from the live price. Nothing here needs a model:
// a template becomes a spec, the owner edits it if they like, checkSpec (builder.ts) validates it like any other spec, and the
// owner's signature over its hash is still the only way it starts.
import type { Hex } from 'viem';
import type { OrderPolicy } from '../config.ts';
import { checkSpec, type DrafterDeps, type Draft } from './builder.ts';
import { HL_MIN_NOTIONAL_USD, specHash, type StrategySpec } from './spec.ts';

/** Hyperliquid size decimals of the coins a policy normally allows; an unknown coin gets coarse sizes, which only costs a little extra notional. */
const SZ_DECIMALS: Record<string, number> = { BTC: 5, ETH: 4 };
/** Every order is built to this many USD at its lowest price, so rounding can never drop it under the exchange minimum. */
const ORDER_USD = HL_MIN_NOTIONAL_USD + 2;

export interface TemplateArgs {
  coin: string;
  leg: number;
  mid: number;
  policy: OrderPolicy;
}

export interface Template {
  id: string;
  title: string;
  blurb: string;
  risk: string;
  type: 'grid' | 'twap';
  make: (a: TemplateArgs) => StrategySpec;
}

/** Round up to the coin's size decimals; a decimal string, never exponent form. */
function ceilSize(usd: number, px: number, coin: string): string {
  const dec = SZ_DECIMALS[coin] ?? 2;
  const f = 10 ** dec;
  return String(Number((Math.ceil((usd / px) * f) / f).toFixed(dec)));
}
/** Four significant digits: BTC 75702.3 -> 75700, ETH 3504.7 -> 3505. */
const px4 = (x: number) => Number(x.toPrecision(4));

function limits(a: TemplateArgs, worst: number) {
  const maxNotional = Math.ceil(worst * 1.25); // headroom, so the 80% warning stays for specs the owner widens
  return { maxNotional, maxLeverage: Math.min(3, a.policy.maxLeverage), maxDailyLoss: Math.max(5, Math.round(maxNotional * 0.15)), topUpCapPerDay: 0 };
}

function grid(id: string, lowerPct: number, upperPct: number, levels: number) {
  return (a: TemplateArgs): StrategySpec => {
    const lower = px4(a.mid * lowerPct);
    const upper = px4(a.mid * upperPct);
    const sizePerLevel = ceilSize(ORDER_USD, lower, a.coin);
    return { id: `${id}-${a.coin.toLowerCase()}`, type: 'grid', leg: a.leg, coin: a.coin, params: { lower, upper, levels, sizePerLevel }, limits: limits(a, levels * Number(sizePerLevel) * upper), onStop: 'flatten' };
  };
}

function dca(id: string, slices: number, intervalSec: number) {
  return (a: TemplateArgs): StrategySpec => {
    const limitPx = px4(a.mid * 1.02);
    const sizePerSlice = ceilSize(ORDER_USD, limitPx, a.coin);
    return { id: `${id}-${a.coin.toLowerCase()}`, type: 'twap', leg: a.leg, coin: a.coin, params: { side: 'buy', sizePerSlice, slices, intervalSec, limitPx }, limits: limits(a, slices * Number(sizePerSlice) * limitPx), onStop: 'cancel' };
  };
}

export const TEMPLATES: Template[] = [
  {
    id: 'grid-classic',
    title: 'Classic grid',
    blurb: 'Eight buy levels from 6% below to 2% above the price. Each filled buy is sold one level higher. Earns while the price moves sideways.',
    risk: 'Keeps buying in a falling market and can end up holding a losing position. Stopping closes what it holds.',
    type: 'grid',
    make: grid('grid-classic', 0.94, 1.02, 8),
  },
  {
    id: 'grid-tight',
    title: 'Tight grid',
    blurb: 'Twelve levels within 2% below to 1% above the price, about 0.25% apart. Trades often, so it is the quickest way to see orders fill on testnet.',
    risk: 'Small steps leave little profit per round trip once fees are paid. Testnet is thin, so fills may be slow.',
    type: 'grid',
    make: grid('grid-tight', 0.98, 1.01, 12),
  },
  {
    id: 'grid-dip',
    title: 'Dip ladder',
    blurb: 'Five buy levels between 10% and 1% below the price, to buy a drop in stages and sell each piece on a small bounce.',
    risk: 'Does nothing until the price falls, and a drop that keeps going leaves you holding it.',
    type: 'grid',
    make: grid('grid-dip', 0.9, 0.99, 5),
  },
  {
    id: 'dca-steady',
    title: 'Steady DCA',
    blurb: 'Buys the same small amount every five minutes, twelve times, and skips a slice if the price is more than 2% above where it started.',
    risk: 'Averages your entry price but does not protect against a falling market. Stopping keeps what was bought.',
    type: 'twap',
    make: dca('dca-steady', 12, 300),
  },
  {
    id: 'twap-smoke',
    title: 'Smoke test (90 seconds)',
    blurb: 'Three small buys, thirty seconds apart. Finishes in about a minute and a half, to check that orders reach the exchange and fill.',
    risk: 'Real orders on the account you pick, though tiny. Stopping keeps what was bought.',
    type: 'twap',
    make: dca('twap-smoke', 3, 30),
  },
];

export type LibraryDeps = Pick<DrafterDeps, 'context' | 'current' | 'mids' | 'keyReady'>;

export interface LibraryItem {
  id: string;
  title: string;
  blurb: string;
  risk: string;
  type: Template['type'];
  spec: StrategySpec;
  specHash: string;
}

export interface LibraryListing {
  coin: string;
  coins: string[];
  mid: number;
  leg: number;
  freeLegs: number[];
  items: LibraryItem[];
}

export function strategyLibrary(d: LibraryDeps) {
  return {
    /** Every template instantiated for one coin and leg at the current price. */
    async list(owner: Hex, opts: { coin?: string; leg?: number } = {}): Promise<LibraryListing> {
      const ctx = await d.context(owner);
      const coins = ctx.orderPolicy.allowedCoins;
      const coin = opts.coin ?? coins[0];
      if (!coin || !coins.includes(coin)) throw new Error(`coin must be one of ${coins.join(', ')}`);
      const mid = Number((await d.mids())[coin]);
      if (!Number.isFinite(mid) || mid <= 0) throw new Error(`no price for ${coin} right now`);
      const freeLegs = ctx.registeredLegs.filter((l) => !ctx.reservedLegs.includes(l) && !ctx.busyLegs.includes(l));
      const leg = opts.leg !== undefined && Number.isInteger(opts.leg) && opts.leg >= 0 ? opts.leg : (freeLegs[0] ?? Math.max(3, ...ctx.reservedLegs.map((l) => l + 1)));
      const items = TEMPLATES.map((t) => {
        const spec = t.make({ coin, leg, mid, policy: ctx.orderPolicy });
        return { id: t.id, title: t.title, blurb: t.blurb, risk: t.risk, type: t.type, spec, specHash: specHash(spec) };
      });
      return { coin, coins, mid, leg, freeLegs, items };
    },
    /** Validate a template, an edited template or pasted JSON; the same answer the model's drafts get. */
    check: (owner: Hex, spec: unknown): Promise<Draft> => checkSpec(d, owner, spec),
  };
}

export type StrategyLibrary = ReturnType<typeof strategyLibrary>;

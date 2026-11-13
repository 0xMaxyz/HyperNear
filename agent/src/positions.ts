// Positions as the owner thinks of them (a hedge of two legs, a one-sided trade, a strategy leg), their PnL, and the labelled trade history.
// Everything here is derived from Hyperliquid's own records (fills, funding, positions); the cloid on each order says what it was for (cloid.ts),
// so nothing is stored. PnL per position cycle = realized (closedPnl) + unrealized (HL's mark-based figure) - fees + funding - setup costs.
// Hyperliquid reports `closedPnl` before fees, so fees are subtracted once, here. Whatever is estimated is named as such in the output.
import type { HlClient, HlUserFill, HlUserFunding, HlLedgerUpdate } from '@perps-platform/core';
import type { Hex } from 'viem';
import { parseCloid, type CloidKind } from './cloid.ts';
import { activatedByCredit, type Activation } from './activation.ts';
import type { OwnerSnapshot } from './legs.ts';

/** HL base taker rate (fallback when userFees is not read, e.g. --dry-run). */
export const DEFAULT_TAKER_RATE = 0.00045;
const HOUR_MS = 3_600_000;

export interface LegHistory {
  leg: number;
  address: Hex;
  fills: HlUserFill[];
  funding: HlUserFunding[];
  ledger: HlLedgerUpdate[];
  takerRate: number;
  activation: Activation;
  /** the one-off activation fee this leg's own balance paid (see setupFeePaid); 0 if the sender or nobody has paid it yet */
  setupFeeUsd: number;
}

/**
 * What activating this account cost the ACCOUNT itself, from its ledger (activation.ts has the rules):
 *  - first row is a fee-carrying HyperCore credit: the sender paid. On testnet the fee came out of the amount that arrived (send 25, leg holds 24),
 *    so the leg bore it; on mainnet the owner reports the sender pays on top, so the leg bore nothing (unverified, re-measure on a first deposit);
 *  - otherwise the account pays on its first outgoing transfer: the fee on that row, if any.
 * Withdrawals carry Hyperliquid's ordinary 1 USDC withdrawal fee, shown in the history; they are not counted here.
 */
export function setupFeePaid(ledger: HlLedgerUpdate[], address: string, network: 'testnet' | 'mainnet'): number {
  const credit = activatedByCredit(address, ledger);
  if (credit) return network === 'testnet' ? credit.fee : 0;
  const a = address.toLowerCase();
  const out = [...ledger]
    .sort((x, y) => x.time - y.time)
    .find((r) => {
      const d = r.delta as Record<string, unknown>;
      return d.type !== 'withdraw' && typeof d.user === 'string' && d.user.toLowerCase() === a && typeof d.destination === 'string' && d.destination.toLowerCase() !== a && Number(d.fee ?? 0) > 0;
    });
  return out ? Number((out.delta as { fee?: string }).fee) : 0;
}

/** Hourly funding rate per coin, from the asset contexts (signed: positive means longs pay shorts). */
export type FundingRates = Record<string, number>;

/** One component of a position's trading fees: what the fills were doing (open/add, reduce/close, builder) and whether they took or made liquidity. */
export interface FeeLine {
  role: 'open' | 'reduce' | 'builder';
  /** taker = the order crossed the book; absent for the builder fee */
  liquidity?: 'taker' | 'maker';
  label: string;
  fills: number;
  notional: number;
  amount: number;
  /** amount / notional, in percent (the effective rate, so tier discounts show) */
  ratePct: number;
}
type FeePart = { fills: number; notional: number; amount: number };

const LABELS: Record<string, string> = {
  'open:taker': 'Opening and adding, taker',
  'open:maker': 'Opening and adding, maker',
  'reduce:taker': 'Reducing and closing, taker',
  'reduce:maker': 'Reducing and closing, maker',
  builder: 'Builder fee',
};
export function feeLinesOf(parts: Record<string, FeePart>): FeeLine[] {
  return Object.keys(LABELS)
    .filter((k) => parts[k])
    .map((k) => {
      const p = parts[k]!;
      const [role, liquidity] = k.split(':') as [FeeLine['role'], FeeLine['liquidity']];
      return { role, ...(liquidity && { liquidity }), label: LABELS[k]!, fills: p.fills, notional: p.notional, amount: p.amount, ratePct: p.notional > 0 ? (100 * p.amount) / p.notional : 0 };
    });
}
/** Adds `lines` of several legs into one list (same component, summed). */
export function mergeFeeLines(all: FeeLine[][]): FeeLine[] {
  const parts: Record<string, FeePart> = {};
  for (const l of all.flat()) {
    const k = l.role === 'builder' ? 'builder' : `${l.role}:${l.liquidity}`;
    const p = (parts[k] ??= { fills: 0, notional: 0, amount: 0 });
    p.fills += l.fills;
    p.notional += l.notional;
    p.amount += l.amount;
  }
  return feeLinesOf(parts);
}

export interface Cycle {
  coin: string;
  openedAt: number;
  closedAt?: number;
  side: 'long' | 'short';
  realized: number;
  fees: number;
  /** `fees` split by component; the parts add up to `fees` */
  parts: Record<string, FeePart>;
  /** the fill that opened it: tells what the position was opened for */
  openKind?: CloidKind;
  openGroup?: string;
}

const num = (v: string | undefined) => Number(v ?? 0);

/** Time the current position in `coin` opened: the last fill that started from a flat position (0 if none is known). */
export function openTime(fills: HlUserFill[], coin: string): number {
  const opens = fills.filter((f) => f.coin === coin && Number(f.startPosition) === 0).map((f) => f.time);
  return opens.length ? Math.max(...opens) : 0;
}

/**
 * Splits one coin's fills on one leg into position cycles: a cycle starts from a flat position and ends when it is flat again.
 * A fill that flips through zero is split in two by size, its fee shared in proportion (closedPnl belongs to the closing part).
 */
export function buildCycles(fills: HlUserFill[], coin: string): Cycle[] {
  const out: Cycle[] = [];
  let cur: Cycle | undefined;
  for (const f of fills.filter((x) => x.coin === coin).sort((a, b) => a.time - b.time || a.tid - b.tid)) {
    const sz = num(f.sz);
    const signed = f.side === 'B' ? sz : -sz;
    const before = num(f.startPosition);
    const after = before + signed;
    // shortcut: builderFee is added to fee as a separate part; our agent sets no builder code so it is always 0 (unverified whether HL's `fee` already includes it)
    const book = (c: Cycle, role: 'open' | 'reduce', share: number) => {
      const notional = num(f.px) * sz * share;
      const add = (key: string, amount: number) => {
        const p = (c.parts[key] ??= { fills: 0, notional: 0, amount: 0 });
        p.fills += 1;
        p.notional += notional;
        p.amount += amount;
        c.fees += amount;
      };
      add(`${role}:${f.crossed ? 'taker' : 'maker'}`, num(f.fee) * share);
      if (num(f.builderFee) !== 0) add('builder', num(f.builderFee) * share);
    };
    const open = () => {
      const c = parseCloid(f.cloid);
      cur = { coin, openedAt: f.time, side: signed > 0 ? 'long' : 'short', realized: 0, fees: 0, parts: {}, openKind: c?.kind, openGroup: c?.group };
      out.push(cur);
      return cur;
    };
    if (Math.abs(before) < 1e-12 || !cur) {
      const c = open();
      book(c, 'open', 1);
      c.realized += num(f.closedPnl);
    } else if (Math.sign(after) === Math.sign(before) || Math.abs(after) < 1e-12) {
      book(cur, Math.abs(after) > Math.abs(before) ? 'open' : 'reduce', 1);
      cur.realized += num(f.closedPnl);
    } else {
      const closing = Math.abs(before) / sz;
      book(cur, 'reduce', closing);
      cur.realized += num(f.closedPnl);
      cur.closedAt = f.time;
      const c = open();
      book(c, 'open', 1 - closing);
    }
    if (cur && Math.abs(after) < 1e-12) {
      cur.closedAt = f.time;
      cur = undefined;
    }
  }
  return out;
}

export interface LegPosition {
  leg: number;
  address: Hex;
  coin: string;
  side: 'long' | 'short';
  size: number;
  entryPx: number;
  markPx: number;
  liquidationPx: number | null;
  leverage: { type: 'cross' | 'isolated'; value: number };
  marginUsed: number;
  openedAt: number | null;
  /** cloid group of the order that opened it: legs opened together share it */
  openGroup?: string;
  /** profit or loss still open, as HL computes it from the mark */
  unrealized: number;
  /** closed by partial reductions of this position so far */
  realized: number;
  fees: number;
  /** `fees` by component (they add up to it) */
  feeLines: FeeLine[];
  /** received (+) or paid (-) since the position opened */
  funding: number;
  activationFee: number;
  /** realized + unrealized - fees + funding - activationFee */
  pnl: number;
  /** estimate for the next funding payment from the current hourly rate (received +, paid -) */
  nextFundingEstimate: number;
  fundingRateHourly: number;
}

export interface Totals {
  realized: number;
  unrealized: number;
  fees: number;
  /** `fees` by component, summed over the legs */
  feeLines: FeeLine[];
  funding: number;
  activationFee: number;
  pnl: number;
  /** ESTIMATED taker fees to close everything at the mark */
  closeFeesEst: number;
  /** the rate that estimate uses, in percent (the leg's own taker rate from userFees) */
  closeRatePct: number;
  /** ESTIMATED: pnl - closeFeesEst */
  netIfClosed: number;
  nextFundingEstimate: number;
}

export interface Composite {
  id: string;
  coin: string;
  /** hedge: legs 0 and 1 opposite; one-sided: a single leg; strategy: a strategy leg (3 and up) */
  kind: 'hedge' | 'one-sided' | 'strategy';
  legs: LegPosition[];
  /** for a hedge: which leg is the long and which the short */
  hedge?: { longLeg: number; shortLeg: number };
  /** signed: long minus short, in base units */
  netSize: number;
  openedAt: number | null;
  totals: Totals;
  /** top of the next UTC hour: when Hyperliquid next settles funding */
  nextFundingAt: number;
}

/** Legs from here on belong to strategies, not to the owner's own trading. */
export const STRATEGY_LEG_FROM = 3;
export const nextFundingAt = (now: number) => Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Open positions of the snapshot with their cycle costs. Pure: the data comes in. */
export function openComposites(s: OwnerSnapshot, data: LegHistory[], rates: FundingRates = {}, now = Date.now()): Composite[] {
  const legPositions: LegPosition[] = [];
  for (const l of s.legs) {
    const d = data.find((x) => x.leg === l.leg);
    for (const { position: p } of l.clearinghouse.assetPositions) {
      const szi = Number(p.szi);
      if (szi === 0) continue;
      const cycles = d ? buildCycles(d.fills, p.coin) : [];
      const cycle = [...cycles].reverse().find((c) => c.closedAt === undefined);
      const since = cycle?.openedAt ?? null;
      const funding = sum((d?.funding ?? []).filter((f) => f.delta.coin === p.coin && since !== null && f.time >= since).map((f) => num(f.delta.usdc)));
      // the leg's setup fee belongs to the first position it ever held
      const first = d && cycles.length > 0 && cycles[0] === cycle;
      const mark = Number(s.market.mids[p.coin] ?? p.entryPx);
      const rate = rates[p.coin] ?? 0;
      const unrealized = Number(p.unrealizedPnl);
      const realized = cycle?.realized ?? 0;
      const fees = cycle?.fees ?? 0;
      const activationFee = first && d ? d.setupFeeUsd : 0;
      legPositions.push({
        leg: l.leg,
        address: l.address,
        coin: p.coin,
        side: szi > 0 ? 'long' : 'short',
        size: Math.abs(szi),
        entryPx: Number(p.entryPx),
        markPx: mark,
        liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
        leverage: p.leverage,
        marginUsed: Number(p.marginUsed),
        openedAt: since,
        ...(cycle?.openGroup ? { openGroup: cycle.openGroup } : {}),
        unrealized,
        realized,
        fees,
        feeLines: feeLinesOf(cycle?.parts ?? {}),
        funding,
        activationFee,
        pnl: realized + unrealized - fees + funding - activationFee,
        // a long pays when the rate is positive: signed size x mark x rate, sign flipped to "received"
        nextFundingEstimate: -szi * mark * rate,
        fundingRateHourly: rate,
      });
    }
  }
  // a hedge is a long and a short in the same coin on two different legs (any two; strategy legs 3+ never pair). Legs opened together
  // (same cloid group) pair first, then the lowest legs, so several positions in several coins each find their other half.
  const used = new Set<LegPosition>();
  const groups: { kind: Composite['kind']; legs: LegPosition[] }[] = [];
  const own = legPositions.filter((p) => p.leg < STRATEGY_LEG_FROM).sort((a, b) => a.leg - b.leg);
  for (const coin of new Set(own.map((p) => p.coin))) {
    const longs = own.filter((p) => p.coin === coin && p.side === 'long');
    const shorts = own.filter((p) => p.coin === coin && p.side === 'short');
    const pair = (l: LegPosition, s: LegPosition) => {
      groups.push({ kind: 'hedge', legs: [l, s].sort((a, b) => a.leg - b.leg) });
      used.add(l).add(s);
    };
    for (const l of longs) {
      const s = l.openGroup ? shorts.find((x) => !used.has(x) && x.openGroup === l.openGroup) : undefined;
      if (s) pair(l, s);
    }
    for (const l of longs) {
      const s = !used.has(l) ? shorts.find((x) => !used.has(x)) : undefined;
      if (s) pair(l, s);
    }
  }
  for (const p of legPositions) if (!used.has(p)) groups.push({ kind: p.leg >= STRATEGY_LEG_FROM ? 'strategy' : 'one-sided', legs: [p] });
  groups.sort((a, b) => a.legs[0]!.leg - b.legs[0]!.leg);
  return groups.map(({ kind, legs }) => {
    const coin = legs[0]!.coin;
    const closeFeesEst = sum(legs.map((p) => p.size * p.markPx * (data.find((d) => d.leg === p.leg)?.takerRate ?? DEFAULT_TAKER_RATE)));
    const totals: Totals = {
      realized: sum(legs.map((p) => p.realized)),
      unrealized: sum(legs.map((p) => p.unrealized)),
      fees: sum(legs.map((p) => p.fees)),
      feeLines: mergeFeeLines(legs.map((p) => p.feeLines)),
      funding: sum(legs.map((p) => p.funding)),
      activationFee: sum(legs.map((p) => p.activationFee)),
      pnl: sum(legs.map((p) => p.pnl)),
      closeFeesEst,
      closeRatePct: (100 * closeFeesEst) / Math.max(1e-12, sum(legs.map((p) => p.size * p.markPx))),
      netIfClosed: sum(legs.map((p) => p.pnl)) - closeFeesEst,
      nextFundingEstimate: sum(legs.map((p) => p.nextFundingEstimate)),
    };
    const opened = legs.map((p) => p.openedAt).filter((t): t is number => t !== null);
    return {
      id: `${coin}:${legs.map((p) => p.leg).join('+')}:${opened.length ? Math.min(...opened) : 0}`,
      coin,
      kind,
      legs,
      ...(kind === 'hedge' ? { hedge: { longLeg: legs.find((p) => p.side === 'long')!.leg, shortLeg: legs.find((p) => p.side === 'short')!.leg } } : {}),
      netSize: sum(legs.map((p) => (p.side === 'long' ? p.size : -p.size))),
      openedAt: opened.length ? Math.min(...opened) : null,
      totals,
      nextFundingAt: nextFundingAt(now),
    };
  });
}

export type HistoryKind = 'hedge-open' | 'hedge-close' | 'open' | 'reduce' | 'protect' | 'strategy' | 'twap' | 'external' | 'funding' | 'transfer';

export interface HistoryRow {
  time: number;
  kind: HistoryKind;
  /** the sentence the page shows */
  label: string;
  coin?: string;
  legs: number[];
  side?: 'buy' | 'sell';
  size?: number;
  px?: number;
  fee?: number;
  /** realized PnL of this row before fees (closedPnl) */
  closedPnl?: number;
  /** funding rows: received (+) / paid (-); transfer rows: signed USDC in (+) / out (-) */
  amount?: number;
  group?: string;
}

const dirLabel = (dir: string) => dir.replace(/^Open /, 'Opened ').replace(/^Close /, 'Closed ').toLowerCase();

/** Fills of one order (same leg and oid, or one TWAP) merge into one row; hedge fills of one action merge across both legs. */
export function historyRows(data: LegHistory[], opts: { limit?: number } = {}): HistoryRow[] {
  type Acc = { f: HlUserFill; time: number; legs: Set<number>; size: number; notional: number; fee: number; pnl: number };
  const merged = new Map<string, Acc>();
  for (const d of data) {
    for (const f of d.fills) {
      const c = parseCloid(f.cloid);
      const hedge = c && (c.kind === 'hedgeOpen' || c.kind === 'hedgeClose');
      const key = hedge ? `h:${c!.group}` : f.twapId !== null ? `t:${d.leg}:${f.twapId}` : `o:${d.leg}:${f.oid}`;
      const a = merged.get(key) ?? { f, time: f.time, legs: new Set<number>(), size: 0, notional: 0, fee: 0, pnl: 0 };
      a.legs.add(d.leg);
      a.size += num(f.sz);
      a.notional += num(f.sz) * num(f.px);
      a.fee += num(f.fee) + num(f.builderFee);
      a.pnl += num(f.closedPnl);
      a.time = Math.min(a.time, f.time);
      merged.set(key, a);
    }
  }
  const rows: HistoryRow[] = [...merged.values()].map(({ f, time, legs, size, notional, fee, pnl }) => {
    const c = parseCloid(f.cloid);
    const base = { time, coin: f.coin, legs: [...legs].sort(), side: f.side === 'B' ? ('buy' as const) : ('sell' as const), size, px: size ? notional / size : num(f.px), fee, closedPnl: pnl, group: c?.group };
    const where = legs.size > 1 ? 'both legs' : `leg ${[...legs][0]}`;
    if (c?.kind === 'hedgeOpen') return { ...base, kind: 'hedge-open', label: `Hedge opened: ${f.coin} on ${where}` };
    if (c?.kind === 'hedgeClose') return { ...base, kind: 'hedge-close', label: `Hedge closed: ${f.coin} on ${where}` };
    if (f.liquidation) return { ...base, kind: 'external', label: `Liquidated on leg ${[...legs][0]}` };
    if (f.twapId !== null) return { ...base, kind: 'twap', label: `TWAP ${dirLabel(f.dir)} on ${where}` };
    if (c?.kind === 'protect') return { ...base, kind: 'protect', label: `Protective order fired: ${dirLabel(f.dir)} on ${where}` };
    if (c?.kind === 'strategy') return { ...base, kind: 'strategy', label: `Strategy: ${dirLabel(f.dir)} on ${where}` };
    if (c?.kind === 'open') return { ...base, kind: 'open', label: `One-sided: ${dirLabel(f.dir)} on ${where}` };
    if (c?.kind === 'reduce') return { ...base, kind: 'reduce', label: `One-sided: ${dirLabel(f.dir)} on ${where}` };
    return { ...base, kind: 'external', label: `Outside HyperNear: ${dirLabel(f.dir)} on ${where}` };
  });

  // funding: one row per hour and coin, both legs summed
  const funding = new Map<string, HistoryRow>();
  for (const d of data) {
    for (const x of d.funding) {
      const hour = Math.floor(x.time / HOUR_MS) * HOUR_MS;
      const key = `${hour}:${x.delta.coin}`;
      const r = funding.get(key) ?? { time: hour, kind: 'funding' as const, label: `Funding on ${x.delta.coin}`, coin: x.delta.coin, legs: [], amount: 0 };
      r.amount = (r.amount ?? 0) + num(x.delta.usdc);
      if (!r.legs.includes(d.leg)) r.legs.push(d.leg);
      funding.set(key, r);
    }
  }
  const transfers: HistoryRow[] = data.flatMap((d) =>
    d.ledger.flatMap((u): HistoryRow[] => {
      const t = u.delta as Record<string, unknown>;
      const usdc = num((t.usdc ?? t.usdcValue ?? t.amount) as string | undefined);
      if (t.type === 'deposit') return [{ time: u.time, kind: 'transfer', label: `Deposit to leg ${d.leg}`, legs: [d.leg], amount: usdc }];
      if (t.type === 'withdraw') return [{ time: u.time, kind: 'transfer', label: `Withdrawal from leg ${d.leg}`, legs: [d.leg], amount: -usdc }];
      if (t.type === 'send' || t.type === 'internalTransfer') {
        const incoming = typeof t.destination === 'string' && t.destination.toLowerCase() === d.address.toLowerCase();
        return [{ time: u.time, kind: 'transfer', label: incoming ? `Received on leg ${d.leg}` : `Sent from leg ${d.leg}`, legs: [d.leg], amount: incoming ? usdc : -usdc }];
      }
      return [];
    }),
  );
  return [...rows, ...funding.values(), ...transfers].sort((a, b) => b.time - a.time).slice(0, opts.limit ?? 300);
}

/** Pages of 500 until HL has nothing newer; HL returns them oldest first. */
async function allFunding(hl: Pick<HlClient, 'userFunding'>, user: Hex, startTime: number): Promise<HlUserFunding[]> {
  const out: HlUserFunding[] = [];
  for (let from = startTime, page = 0; page < 20; page++) {
    const rows = await hl.userFunding({ user, startTime: from });
    out.push(...rows);
    if (rows.length < 500) break;
    from = rows[rows.length - 1]!.time + 1;
  }
  return out;
}

/** Reads fills (the latest 2000: shortcut, widen with userFillsByTime if a leg trades more), funding, ledger and fee rate of every registered leg. */
export async function readLegHistory(hl: HlClient, s: OwnerSnapshot, network: 'testnet' | 'mainnet' = 'testnet'): Promise<LegHistory[]> {
  return Promise.all(
    s.legs.map(async (l) => {
      const [fills, fees, ledger] = await Promise.all([hl.userFills({ user: l.address }), hl.userFees({ user: l.address }), hl.userNonFundingLedgerUpdates({ user: l.address, startTime: 0 }).catch(() => [])]);
      const funding = await allFunding(hl, l.address, fills.length ? Math.min(...fills.map((f) => f.time)) : Date.now() - 30 * 86_400_000);
      return { leg: l.leg, address: l.address, fills, funding, ledger, takerRate: Number(fees.userCrossRate), activation: l.activation, setupFeeUsd: setupFeePaid(ledger, l.address, network) };
    }),
  );
}

/** Hourly funding rate of each coin in the snapshot's market, from HL's asset contexts. */
export async function readFundingRates(hl: HlClient, s: OwnerSnapshot): Promise<FundingRates> {
  const [meta, ctxs] = (await hl.metaAndAssetCtxs()) as unknown as [{ universe: { name: string }[] }, { funding: string }[]];
  const out: FundingRates = {};
  meta.universe.forEach((u, i) => {
    if (s.market.mids[u.name] !== undefined && ctxs[i]) out[u.name] = Number(ctxs[i]!.funding);
  });
  return out;
}

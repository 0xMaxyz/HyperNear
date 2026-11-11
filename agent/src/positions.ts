// Positions as the owner thinks of them (a hedge of two legs, a one-sided trade, a strategy leg), their PnL, and the labelled trade history.
// Everything here is derived from Hyperliquid's own records (fills, funding, positions); the cloid on each order says what it was for (cloid.ts),
// so nothing is stored. PnL per position cycle = realized (closedPnl) + unrealized (HL's mark-based figure) - fees + funding - setup costs.
// Hyperliquid reports `closedPnl` before fees, so fees are subtracted once, here. Whatever is estimated is named as such in the output.
import type { HlClient, HlUserFill, HlUserFunding, HlLedgerUpdate } from '@perps-platform/core';
import type { Hex } from 'viem';
import { parseCloid, type CloidKind } from './cloid.ts';
import type { Activation } from './activation.ts';
import type { OwnerSnapshot } from './legs.ts';

/** HL base taker rate (fallback when userFees is not read, e.g. --dry-run). */
export const DEFAULT_TAKER_RATE = 0.00045;
/** Hyperliquid's one-off fee to activate a new account (activation.ts). Counted once per leg, in that leg's first position. */
export const ACTIVATION_FEE_USD = 1;
const HOUR_MS = 3_600_000;

export interface LegHistory {
  leg: number;
  address: Hex;
  fills: HlUserFill[];
  funding: HlUserFunding[];
  ledger: HlLedgerUpdate[];
  takerRate: number;
  activation: Activation;
}

/** Hourly funding rate per coin, from the asset contexts (signed: positive means longs pay shorts). */
export type FundingRates = Record<string, number>;

export interface Cycle {
  coin: string;
  openedAt: number;
  closedAt?: number;
  side: 'long' | 'short';
  realized: number;
  fees: number;
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
    const fee = num(f.fee) + num(f.builderFee);
    const open = () => {
      const c = parseCloid(f.cloid);
      cur = { coin, openedAt: f.time, side: signed > 0 ? 'long' : 'short', realized: 0, fees: 0, openKind: c?.kind, openGroup: c?.group };
      out.push(cur);
      return cur;
    };
    if (Math.abs(before) < 1e-12 || !cur) {
      const c = open();
      c.fees += fee;
      c.realized += num(f.closedPnl);
    } else if (Math.sign(after) === Math.sign(before) || Math.abs(after) < 1e-12) {
      cur.fees += fee;
      cur.realized += num(f.closedPnl);
    } else {
      const closing = Math.abs(before) / sz;
      cur.fees += fee * closing;
      cur.realized += num(f.closedPnl);
      cur.closedAt = f.time;
      const c = open();
      c.fees += fee * (1 - closing);
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
  /** profit or loss still open, as HL computes it from the mark */
  unrealized: number;
  /** closed by partial reductions of this position so far */
  realized: number;
  fees: number;
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
  funding: number;
  activationFee: number;
  pnl: number;
  /** ESTIMATED taker fees to close everything at the mark */
  closeFeesEst: number;
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
  /** signed: long minus short, in base units */
  netSize: number;
  openedAt: number | null;
  totals: Totals;
  /** top of the next UTC hour: when Hyperliquid next settles funding */
  nextFundingAt: number;
}

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
      const first = d && cycles.length > 0 && cycles[0] === cycle && d.activation !== 'owed-on-credit';
      const mark = Number(s.market.mids[p.coin] ?? p.entryPx);
      const rate = rates[p.coin] ?? 0;
      const unrealized = Number(p.unrealizedPnl);
      const realized = cycle?.realized ?? 0;
      const fees = cycle?.fees ?? 0;
      const activationFee = first ? ACTIVATION_FEE_USD : 0;
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
        unrealized,
        realized,
        fees,
        funding,
        activationFee,
        pnl: realized + unrealized - fees + funding - activationFee,
        // a long pays when the rate is positive: signed size x mark x rate, sign flipped to "received"
        nextFundingEstimate: -szi * mark * rate,
        fundingRateHourly: rate,
      });
    }
  }
  const take = (leg: number, coin: string) => legPositions.find((p) => p.leg === leg && p.coin === coin);
  const used = new Set<LegPosition>();
  const groups: { kind: Composite['kind']; legs: LegPosition[] }[] = [];
  for (const p of legPositions.filter((x) => x.leg === 0)) {
    const other = take(1, p.coin);
    if (other && other.side !== p.side) {
      groups.push({ kind: 'hedge', legs: [p, other] });
      used.add(p).add(other);
    }
  }
  for (const p of legPositions) if (!used.has(p)) groups.push({ kind: p.leg >= 3 ? 'strategy' : 'one-sided', legs: [p] });
  return groups.map(({ kind, legs }) => {
    const coin = legs[0]!.coin;
    const closeFeesEst = sum(legs.map((p) => p.size * p.markPx * (data.find((d) => d.leg === p.leg)?.takerRate ?? DEFAULT_TAKER_RATE)));
    const totals: Totals = {
      realized: sum(legs.map((p) => p.realized)),
      unrealized: sum(legs.map((p) => p.unrealized)),
      fees: sum(legs.map((p) => p.fees)),
      funding: sum(legs.map((p) => p.funding)),
      activationFee: sum(legs.map((p) => p.activationFee)),
      pnl: sum(legs.map((p) => p.pnl)),
      closeFeesEst,
      netIfClosed: sum(legs.map((p) => p.pnl)) - closeFeesEst,
      nextFundingEstimate: sum(legs.map((p) => p.nextFundingEstimate)),
    };
    const opened = legs.map((p) => p.openedAt).filter((t): t is number => t !== null);
    return {
      id: `${coin}:${legs.map((p) => p.leg).join('+')}:${opened.length ? Math.min(...opened) : 0}`,
      coin,
      kind,
      legs,
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
export async function readLegHistory(hl: HlClient, s: OwnerSnapshot): Promise<LegHistory[]> {
  return Promise.all(
    s.legs.map(async (l) => {
      const [fills, fees, ledger] = await Promise.all([hl.userFills({ user: l.address }), hl.userFees({ user: l.address }), hl.userNonFundingLedgerUpdates({ user: l.address, startTime: 0 }).catch(() => [])]);
      const funding = await allFunding(hl, l.address, fills.length ? Math.min(...fills.map((f) => f.time)) : Date.now() - 30 * 86_400_000);
      return { leg: l.leg, address: l.address, fills, funding, ledger, takerRate: Number(fees.userCrossRate), activation: l.activation };
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

// What the pages send and read for trading: signed order / cancel specs, positions with their PnL, open orders, history.
// The shapes mirror agent/src/order.ts and agent/src/positions.ts. The owner signs specHash(spec) of the exact JSON sent beside the command.
import type { Hex } from 'viem';
import { newCommand, specHashOfJson, type Command, type CommandAction } from './hypernear';
import { getJson, post } from './api';

export const ORDER_TYPES = ['market', 'limit', 'stopMarket', 'stopLimit', 'takeMarket', 'takeLimit', 'bracket', 'twap', 'trailing'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export interface OrderSpec {
  leg: number;
  coin: string;
  side: 'buy' | 'sell';
  type: OrderType;
  size?: string;
  reduceOnly?: boolean;
  leverage?: number;
  isCross?: boolean;
  limitPx?: string;
  triggerPx?: string;
  tif?: 'Gtc' | 'Ioc' | 'Alo';
  tpPx?: string;
  slPx?: string;
  minutes?: number;
  randomize?: boolean;
  trailPct?: string;
  trailPx?: string;
  activationPx?: string;
}
export interface CancelSpec {
  leg: number;
  coin: string;
  oid?: number;
  twapId?: number;
  all?: boolean;
}
export interface HedgeSpec {
  leg1Leverage?: number;
  leg1IsCross?: boolean;
}

/** A new hedged position: leg 0 takes `side`, leg 1 the opposite side at `ratio` x the size, both at market (agent/src/hedgePair.ts). */
export interface HedgePairSpec {
  coin: string;
  side: 'long' | 'short';
  size: string;
  ratio: string;
  leverageA: number;
  leverageB?: number;
  isCrossA?: boolean;
  isCrossB?: boolean;
  maxSpreadBps?: number;
}
export interface PairLegOutcome {
  leg: number;
  isBuy: boolean;
  requested: string;
  filled: number;
  avgPx: number | null;
  error?: string;
}
export interface HedgePairResult {
  status: 'filled' | 'trimmed' | 'unwound' | 'unbalanced' | 'failed';
  legs: [PairLegOutcome, PairLegOutcome];
  unwind: PairLegOutcome[];
  spreadBps: number | null;
  open: [number, number];
  notes: string[];
  simulated?: boolean;
}

/** The sentence for a finished pair, or an Error saying what went wrong (nothing opened, one leg closed again, or an unbalanced hedge). */
export function pairMessage(out: HedgePairResult): string {
  const px = (x: number | null) => (x === null ? '—' : `$${x.toFixed(2)}`);
  const [a, b] = out.legs;
  const lines = `leg 0 ${a.isBuy ? 'bought' : 'sold'} ${a.filled} at ${px(a.avgPx)}, leg 1 ${b.isBuy ? 'bought' : 'sold'} ${b.filled} at ${px(b.avgPx)}`;
  if (out.status === 'failed') throw new Error(`Nothing was opened. ${out.notes.join(' ')}`);
  if (out.status === 'unwound' || out.status === 'unbalanced') {
    throw new Error(`${out.status === 'unwound' ? 'Only one leg filled, so it was closed again.' : 'The hedge is not balanced: look at Positions now.'} ${lines}. ${out.notes.join(' ')}`);
  }
  return `Hedge opened: ${lines}${out.spreadBps !== null ? `, entry spread ${out.spreadBps} bps` : ''}${out.status === 'trimmed' && out.notes.length ? '. ' + out.notes.join(' ') : ''}`;
}

export type Sign = (c: Command) => Promise<Hex>;

/** Signs a command bound to `spec` and posts both; the agent hashes what it receives and refuses anything else. */
export async function sendSpec(sign: Sign, owner: Hex, action: CommandAction, path: string, spec: unknown, coin = '', ratio = '0') {
  const command = newCommand(owner, action, coin, ratio, 30, Date.now(), specHashOfJson(spec));
  return post(path, { command, sig: await sign(command), spec });
}
export const placeOrder = (sign: Sign, owner: Hex, spec: OrderSpec) => sendSpec(sign, owner, 'placeOrder', '/order/place', spec);
export const placeHedge = (sign: Sign, owner: Hex, spec: HedgePairSpec) => sendSpec(sign, owner, 'placeHedge', '/hedge/pair', spec) as Promise<HedgePairResult & Record<string, unknown>>;
export const cancelOrder = (sign: Sign, owner: Hex, spec: CancelSpec) => sendSpec(sign, owner, 'cancelOrder', '/order/cancel', spec);
/** Moves one resting limit order to a new price (same size, side and cloid; the exchange assigns a new oid). */
export interface ModifySpec {
  leg: number;
  coin: string;
  oid: number;
  limitPx: string;
}
export const modifyOrder = (sign: Sign, owner: Hex, spec: ModifySpec) => sendSpec(sign, owner, 'modifyOrder', '/order/modify', spec);

export interface FeeLine {
  role: 'open' | 'reduce' | 'builder';
  liquidity?: 'taker' | 'maker';
  label: string;
  fills: number;
  notional: number;
  amount: number;
  ratePct: number;
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
  unrealized: number;
  realized: number;
  fees: number;
  feeLines: FeeLine[];
  funding: number;
  activationFee: number;
  pnl: number;
  nextFundingEstimate: number;
  fundingRateHourly: number;
}
export interface Totals {
  realized: number;
  unrealized: number;
  fees: number;
  feeLines: FeeLine[];
  funding: number;
  activationFee: number;
  pnl: number;
  closeFeesEst: number;
  closeRatePct: number;
  netIfClosed: number;
  nextFundingEstimate: number;
}
export interface Composite {
  id: string;
  coin: string;
  kind: 'hedge' | 'one-sided' | 'strategy';
  legs: LegPosition[];
  netSize: number;
  openedAt: number | null;
  totals: Totals;
  nextFundingAt: number;
}
export interface HistoryRow {
  time: number;
  kind: 'hedge-open' | 'hedge-close' | 'open' | 'reduce' | 'protect' | 'strategy' | 'twap' | 'external' | 'funding' | 'transfer';
  label: string;
  coin?: string;
  legs: number[];
  side?: 'buy' | 'sell';
  size?: number;
  px?: number;
  fee?: number;
  closedPnl?: number;
  amount?: number;
  group?: string;
}
export interface OpenOrder {
  leg: number;
  coin: string;
  oid: number;
  side: 'buy' | 'sell';
  size: string;
  limitPx: string;
  orderType: string;
  isTrigger: boolean;
  triggerPx: string;
  triggerCondition: string;
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  placedAt: number;
  label: string;
}
export interface RunningTwap {
  leg: number;
  twapId: number;
  coin: string;
  side: 'buy' | 'sell';
  size: string;
  executedSize: string;
  minutes: number;
  startedAt: number;
}

export const getPositions = (owner: Hex) => getJson<{ positions: Composite[]; at: number }>(`/positions/${owner}`);
export const getHistory = (owner: Hex) => getJson<{ rows: HistoryRow[]; at: number }>(`/history/${owner}`);
export const getOrders = (owner: Hex) => getJson<{ orders: OpenOrder[]; twaps: RunningTwap[] }>(`/orders/${owner}`);

/** The same HL price rule as the agent: at most 5 significant figures and 6 - szDecimals decimals. */
export function roundPx(px: number, szDecimals: number): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  return String(Number(Number(px.toPrecision(5)).toFixed(maxDec)));
}
export function floorSize(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return (Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals);
}

/** Closes (or shrinks) a position with a reduce-only market order on the other side. */
export function reduceSpec(p: Pick<LegPosition, 'leg' | 'coin' | 'side' | 'size'>, fraction: number, szDecimals: number): OrderSpec {
  const whole = fraction >= 1;
  return { leg: p.leg, coin: p.coin, side: p.side === 'long' ? 'sell' : 'buy', type: 'market', size: whole ? floorSize(p.size, szDecimals) : floorSize(p.size * fraction, szDecimals), reduceOnly: true };
}

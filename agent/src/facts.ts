// Bucketed facts for the decision layer (decide.ts proposeAction) from an owner snapshot.
// Bucket strings are copied verbatim from validation/fixtures/decide/states.json: Jev was validated on those values.
import type { Hex } from 'viem';
import type { DecideContext, Facts } from './decide.ts';
import type { OwnerSnapshot } from './legs.ts';
import { position } from './market.ts';

export interface DecisionInput {
  owner: Hex;
  coin: string;
  state: { facts: Facts };
  ctx: DecideContext;
}

export const marginBucket = (ratio: number) =>
  ratio > 6 ? 'far: over 6x maintenance margin'
  : ratio >= 3 ? 'comfortable: 3x to 6x maintenance margin'
  : ratio >= 1.5 ? 'close: 1.5x to 3x maintenance margin'
  : 'very close: under 1.5x maintenance margin';

export function marginRatio(ch: OwnerSnapshot['legs'][number]['clearinghouse']) {
  const maint = Number(ch.crossMaintenanceMarginUsed);
  return maint > 0 ? Number(ch.marginSummary.accountValue) / maint : Number.POSITIVE_INFINITY;
}

/** The first allowed coin hedged across legs 0 and 1 (leg0 long, leg1 short), or null. */
export function hedgedCoin(s: OwnerSnapshot, coins: string[]): string | null {
  const l0 = s.legs.find((l) => l.leg === 0);
  const l1 = s.legs.find((l) => l.leg === 1);
  if (!l0 || !l1) return null;
  // decide.ts reasons about "the long leg" and "the short leg": only the leg0-long / leg1-short layout is proposed for
  return coins.find((c) => Number(position(l0.clearinghouse, c)?.szi ?? 0) > 0 && Number(position(l1.clearinghouse, c)?.szi ?? 0) < 0) ?? null;
}

/**
 * Facts + risk context for proposeAction, or null when the owner has no open hedge.
 * openedAt: when the hedge leg opened (ms; pnl.ts openTime), 0 if unknown.
 */
export function decisionInput(s: OwnerSnapshot, coins: string[], o: { annualVol: number; openedAt?: number; now?: number }): DecisionInput | null {
  const coin = hedgedCoin(s, coins);
  if (!coin) return null;
  const l0 = s.legs.find((l) => l.leg === 0)!;
  const l1 = s.legs.find((l) => l.leg === 1)!;
  const p0 = position(l0.clearinghouse, coin)!;
  const p1 = position(l1.clearinghouse, coin)!;
  const mid = Number(s.market.mids[coin] ?? p0.entryPx);
  const L = Number(p0.szi) * mid;
  const S = Math.abs(Number(p1.szi)) * mid;
  const cover = S / L;
  const pnl = Number(p0.unrealizedPnl) + Number(p1.unrealizedPnl);
  const pnlFrac = pnl / (L + S);
  // cumFunding.sinceOpen is what the short leg paid since it opened (negative = received)
  const fundingFrac = Number(p1.cumFunding?.sinceOpen ?? 0) / S;
  const reserve = s.legs.find((l) => l.leg === 2);
  const reserveUsd = reserve ? Number(reserve.clearinghouse.withdrawable) + reserve.spotUsdc : 0;
  const ageMs = o.openedAt ? (o.now ?? Date.now()) - o.openedAt : 0;
  const u0 = Number(p0.unrealizedPnl);
  const u1 = Number(p1.unrealizedPnl);

  const facts: Facts = {
    hedgeCoverage:
      cover < 0.1 ? 'none' : cover < 0.75 ? 'partial: about half of the long is hedged' : cover <= 1.1 ? 'full: legs are about equal' : 'over-hedged: short is larger than long',
    longLegLiquidationDistance: marginBucket(marginRatio(l0.clearinghouse)),
    shortLegLiquidationDistance: marginBucket(marginRatio(l1.clearinghouse)),
    combinedPnl: Math.abs(pnlFrac) < 0.002 ? 'about flat' : `${Math.abs(pnlFrac) < 0.02 ? 'small' : 'large'} ${pnl > 0 ? 'profit' : 'loss'}`,
    fundingOnHedge: Math.abs(fundingFrac) < 0.0001 ? 'neutral' : fundingFrac < 0 ? 'earning' : fundingFrac > 0.001 ? 'paying a lot' : 'paying a little',
    // shortcut: volatility from the configured annual vol (the guard's input), not measured; upgrade with a candle read
    volatility: o.annualVol < 0.4 ? 'calm' : o.annualVol < 0.8 ? 'normal' : o.annualVol < 1.2 ? 'elevated' : 'extreme',
    // shortcut: the snapshot holds one mid, no history; upgrade with HL candleSnapshot
    trend: 'ranging',
    hedgeAge: ageMs >= 86_400_000 ? 'days' : ageMs >= 3_600_000 || !o.openedAt ? 'hours' : 'minutes',
    reserveMargin: reserveUsd <= 0 ? 'none available' : reserveUsd < 0.1 * L ? 'thin' : 'ample',
  };
  const profitLeg = u0 > 0 && u0 >= u1 ? 'long' : u1 > 0 ? 'short' : null;
  return { owner: s.owner, coin, state: { facts }, ctx: { longNotional: L, shortNotional: S, profitLeg } };
}

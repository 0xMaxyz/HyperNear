import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ACTIONS = {
  hold: 'keep both legs as they are',
  close_both: 'close both legs now and take the combined result',
  reduce_hedge: 'shrink the short leg so the hedge covers less of the long leg',
  add_hedge: 'grow the short leg so the hedge covers more of the long leg',
  take_profit: 'close the leg that is in profit and keep the other open',
} as const;
export type Action = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as Action[];

export interface DecideState {
  id: string;
  facts: Record<string, string>;
}

export function loadStates(): DecideState[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/decide/states.json', import.meta.url)), 'utf8'));
}

/** Seeded Fisher-Yates so shuffled option orders are reproducible. */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}


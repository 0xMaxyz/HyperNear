// Deterministic generator for states.json: 50 hedge states, bucketed facts only (no raw numbers).
// Run: node validation/fixtures/decide/generate.mjs
import { writeFileSync } from 'node:fs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACTS = {
  hedgeCoverage: ['none', 'partial: about half of the long is hedged', 'full: legs are about equal', 'over-hedged: short is larger than long'],
  longLegLiquidationDistance: ['very close: under 1.5x maintenance margin', 'close: 1.5x to 3x maintenance margin', 'comfortable: 3x to 6x maintenance margin', 'far: over 6x maintenance margin'],
  shortLegLiquidationDistance: ['very close: under 1.5x maintenance margin', 'close: 1.5x to 3x maintenance margin', 'comfortable: 3x to 6x maintenance margin', 'far: over 6x maintenance margin'],
  combinedPnl: ['large loss', 'small loss', 'about flat', 'small profit', 'large profit'],
  fundingOnHedge: ['paying a lot', 'paying a little', 'neutral', 'earning'],
  volatility: ['calm', 'normal', 'elevated', 'extreme'],
  trend: ['price rising', 'price falling', 'ranging'],
  hedgeAge: ['minutes', 'hours', 'days'],
  reserveMargin: ['none available', 'thin', 'ample'],
};

const rand = rng(20261107);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const states = [];
const seen = new Set();
while (states.length < 50) {
  const facts = Object.fromEntries(Object.entries(FACTS).map(([k, v]) => [k, pick(v)]));
  const key = JSON.stringify(facts);
  if (seen.has(key)) continue;
  seen.add(key);
  states.push({ id: `s${String(states.length + 1).padStart(2, '0')}`, facts });
}
writeFileSync(new URL('./states.json', import.meta.url), JSON.stringify(states, null, 2) + '\n');
console.log(`wrote ${states.length} states`);

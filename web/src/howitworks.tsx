// "How it works" for every strategy template and protective order: what it does, when it pays, what can go wrong, the steps, a picture and a worked
// example computed from the live price. Plain words; the numbers match what the agent builds (agent/src/strategy/library.ts) and what protect.tsx signs.
import { useEffect, useRef, type ReactNode } from 'react';
import { Figure } from './illustrations';
import { usd } from './panels';

interface Guide {
  title: string;
  what: string;
  when: string;
  risk: string;
  steps: string[];
  figure: ReactNode;
  example: (coin: string, mid: number) => string;
}

const axes = <path d="M20 150V12M20 150h330" strokeWidth={1} opacity={0.5} />;
const label = (x: number, y: number, t: string) => <text x={x} y={y}>{t}</text>;
const Txt = ({ children }: { children: ReactNode }) => <g className="ill-text" stroke="none" fill="currentColor">{children}</g>;
const pct = (mid: number, p: number) => usd(mid * (1 + p), mid < 1000 ? 2 : 0);

const gridFigure = (levels: number, title: string) => (
  <Figure title={title} desc="Price over time (solid line) crossing evenly spaced buy levels (dashed) below and sell levels above. Each filled buy is sold one level higher.">
    {axes}
    {Array.from({ length: levels }, (_, i) => <path key={i} d={`M20 ${28 + (i * 112) / (levels - 1)}h330`} strokeWidth={1} strokeDasharray="6 5" opacity={0.7} />)}
    <polyline points="20,70 70,100 120,126 170,92 220,58 270,84 330,110" />
    <Txt>{label(24, 22, 'sell levels')}{label(24, 164, 'buy levels')}{label(250, 22, 'price')}</Txt>
  </Figure>
);

const stepsFigure = (n: number, title: string) => (
  <Figure title={title} desc="A staircase of equal purchases over time. Each step is one small buy; the price paid on average is spread over the whole period.">
    {axes}
    <polyline points={Array.from({ length: n }, (_, i) => `${20 + (i * 300) / n},${140 - (i * 100) / n} ${20 + ((i + 1) * 300) / n},${140 - (i * 100) / n}`).join(' ')} />
    <Txt>{label(24, 22, 'amount bought')}{label(260, 164, 'time')}</Txt>
  </Figure>
);

const lineFigure = (kind: 'stop' | 'take' | 'bracket' | 'trail' | 'trailAct') => {
  const price = '20,96 80,80 140,98 200,60 260,84 330,40';
  return (
    <Figure title="How the order sits next to the price" desc={{ stop: 'A stop-loss line below the price (dashed). If the price falls to it, the position is closed.', take: 'A take-profit line above the price (dashed). If the price rises to it, the position is closed.', bracket: 'A take-profit line above and a stop-loss line below. Whichever is touched first closes the position and the other is cancelled.', trail: 'The stop (dashed) follows the highest price at a fixed distance and never moves down. When the price falls back to it, the position is closed.', trailAct: 'Nothing trails until the price reaches the activation line (dotted). From there the stop follows the highest price at a fixed distance.' }[kind]}>
      {axes}
      <polyline points={price} />
      {kind === 'stop' && <path d="M20 128h310" strokeDasharray="7 5" />}
      {kind === 'take' && <path d="M20 30h310" strokeDasharray="7 5" />}
      {kind === 'bracket' && <><path d="M20 30h310" strokeDasharray="7 5" /><path d="M20 128h310" strokeDasharray="7 5" /></>}
      {(kind === 'trail' || kind === 'trailAct') && <polyline points="20,118 80,102 140,118 200,82 260,82 330,62" strokeDasharray="7 5" />}
      {kind === 'trailAct' && <path d="M20 70h310" strokeWidth={1} strokeDasharray="1 5" />}
      <Txt>
        {kind === 'stop' && label(24, 122, 'stop-loss')}
        {kind === 'take' && label(24, 24, 'take-profit')}
        {kind === 'bracket' && <>{label(24, 24, 'take-profit')}{label(24, 122, 'stop-loss')}</>}
        {(kind === 'trail' || kind === 'trailAct') && label(24, 132, 'trailing stop')}
        {kind === 'trailAct' && label(24, 64, 'activation')}
        {label(250, 164, 'time')}
      </Txt>
    </Figure>
  );
};

const GUIDES: Record<string, Guide> = {
  'grid-classic': {
    title: 'Classic grid',
    what: 'Places eight buy orders below the price and sells each one a level higher once it fills. It earns the gap between levels every time the price swings up and down.',
    when: 'A market that moves sideways and keeps coming back to the same range.',
    risk: 'A steady fall keeps filling buys and leaves you holding a loss. A steady rise leaves the grid fully sold and earning nothing. Stopping closes what it holds.',
    steps: ['The agent places the buy levels from 6% below to 2% above the price.', 'When a buy fills, it places a sell one level up.', 'When that sell fills, the buy goes back in and the round starts again.', 'Limits you set (daily loss, position size) pause it before it hurts.'],
    figure: gridFigure(8, 'Classic grid'),
    example: (c, m) => `With ${c} at ${usd(m, 0)}: the lowest buy sits near ${pct(m, -0.06)} and the top level near ${pct(m, 0.02)}. A buy at ${pct(m, -0.03)} that sells one level higher (about 1.1% up) earns that gap, minus two small fees.`,
  },
  'grid-tight': {
    title: 'Tight grid',
    what: 'Twelve levels packed within 2% below to 1% above the price, about 0.25% apart. It trades often, so you see orders fill quickly.',
    when: 'A quiet market, or testing: the quickest way to watch fills on testnet.',
    risk: 'Each round trip earns little once fees are paid, and a quick one-way move leaves the grid on the wrong side.',
    steps: ['Twelve levels are placed close together around the price.', 'Every small wobble fills a level and places its opposite one step away.', 'You watch the fills arrive in the log within minutes.'],
    figure: gridFigure(12, 'Tight grid'),
    example: (c, m) => `With ${c} at ${usd(m, 0)}: levels run from ${pct(m, -0.02)} to ${pct(m, 0.01)}, one every ${usd(m * 0.0025, 0)}. A round trip earns about 0.25%, and the two fees cost roughly 0.09% of that.`,
  },
  'grid-dip': {
    title: 'Dip ladder',
    what: 'Five buy levels between 10% and 1% below the price. It buys a drop in stages and sells each piece on a small bounce.',
    when: 'You expect dips to be bought, and you would rather wait for them than buy now.',
    risk: 'Does nothing until the price falls. A drop that keeps going leaves you holding every level you bought.',
    steps: ['Buy orders wait at 1%, 3%, 5%, 7% and 10% below.', 'A fill is sold again one level higher.', 'If the price never dips, nothing happens and nothing is spent.'],
    figure: gridFigure(5, 'Dip ladder'),
    example: (c, m) => `With ${c} at ${usd(m, 0)}: buys wait at ${pct(m, -0.01)}, ${pct(m, -0.03)}, ${pct(m, -0.05)}, ${pct(m, -0.07)} and ${pct(m, -0.1)}. If it falls to ${pct(m, -0.05)} you hold three pieces, bought on the way down.`,
  },
  'dca-steady': {
    title: 'Steady DCA',
    what: 'Buys the same small amount every five minutes, twelve times, and skips a slice if the price is more than 2% above where it started.',
    when: 'You want to build a position without choosing the moment.',
    risk: 'Averages the entry price but does not protect against a falling market. Stopping keeps what was bought.',
    steps: ['The agent records the start price.', 'Every five minutes it buys one slice at market.', 'A slice is skipped if the price ran more than 2% above the start.', 'After twelve slices it finishes and the position stays.'],
    figure: stepsFigure(12, 'Steady DCA'),
    example: (c, m) => `With ${c} at ${usd(m, 0)}: twelve buys over one hour. If the price drifts from ${usd(m, 0)} to ${pct(m, -0.02)} and back, your average sits near the middle, and no slice is bought above ${pct(m, 0.02)}.`,
  },
  'twap-smoke': {
    title: 'Smoke test',
    what: 'Three small buys, thirty seconds apart. It finishes in about a minute and a half.',
    when: 'You want to check that orders reach the exchange and fill, before trusting anything bigger.',
    risk: 'These are real orders on the leg you pick, though tiny. Stopping keeps what was bought.',
    steps: ['The first buy goes out at once.', 'Two more follow, thirty seconds apart.', 'The log shows each fill with its price.'],
    figure: stepsFigure(3, 'Smoke test'),
    example: (c, m) => `With ${c} at ${usd(m, 0)}: three buys of about $12 each, so about $36 in total. You end up long a tiny ${c} position you can close from Overview.`,
  },
  'protect-stop': {
    title: 'Stop-loss',
    what: 'A resting order that closes your whole position if the price falls (for a long) or rises (for a short) to a level you pick. Hyperliquid watches the price, not this service.',
    when: 'You hold a position and want a hard limit on what it can lose.',
    risk: 'In a fast move the fill can be worse than the trigger. A freeze cancels the order, so a frozen account has no stop.',
    steps: ['You pick how far from the price the stop sits.', 'You sign one order.', 'Hyperliquid holds it and closes the position at market when the price touches the level.'],
    figure: lineFigure('stop'),
    example: (c, m) => `A 0.01 ${c} long at ${usd(m, 0)} with a 5% stop at ${pct(m, -0.05)}: if it triggers you lose about ${usd(m * 0.05 * 0.01, 2)} plus fees, instead of whatever the fall would have cost.`,
  },
  'protect-take': {
    title: 'Take-profit',
    what: 'A resting order that closes your whole position when the price reaches a target in your favour.',
    when: 'You want to bank a gain without watching the screen.',
    risk: 'You give up what happens after the target. A freeze cancels the order.',
    steps: ['You pick how far above the price (for a long) the target sits.', 'You sign one order.', 'Hyperliquid closes the position at market when the price reaches it.'],
    figure: lineFigure('take'),
    example: (c, m) => `A 0.01 ${c} long at ${usd(m, 0)} with a 10% target at ${pct(m, 0.1)}: you bank about ${usd(m * 0.1 * 0.01, 2)} minus fees.`,
  },
  'protect-bracket': {
    title: 'Take-profit and stop-loss',
    what: 'Both at once, attached to the position. Whichever is touched first closes it, and the other is cancelled. They follow the position if you reduce it.',
    when: 'You want a floor and a ceiling on the trade the moment you open it.',
    risk: 'Same as the two alone: gaps can fill past the trigger, and a freeze cancels both.',
    steps: ['You pick a target and a stop.', 'You sign one order.', 'Hyperliquid keeps both on the position and resizes them when the position changes.'],
    figure: lineFigure('bracket'),
    example: (c, m) => `A long at ${usd(m, 0)} with a target at ${pct(m, 0.1)} and a stop at ${pct(m, -0.05)}: the most you can win is 10% and the most you can lose is 5%, so it is a 2 to 1 trade.`,
  },
  'protect-trail': {
    title: 'Trailing stop',
    what: 'A stop that follows the best price. For a long it rises with the price at a fixed distance and never falls, so it locks in gains as they grow.',
    when: 'You are in profit, or expect a trend, and want to ride it without picking the top.',
    risk: 'A normal pullback of the distance you chose closes the trade. Too tight and noise stops you out. Mainnet support is unverified; it works on testnet.',
    steps: ['You pick the distance, as a percentage.', 'You sign one order.', 'Hyperliquid raises the stop with every new high and closes the position when the price falls back to it.'],
    figure: lineFigure('trail'),
    example: (c, m) => `A long at ${usd(m, 0)} with a 5% trail: the stop starts at ${pct(m, -0.05)}. If the price climbs to ${pct(m, 0.2)} the stop sits at ${usd(m * 1.2 * 0.95, 0)}, locking in about ${usd(m * (1.2 * 0.95 - 1) * 0.01, 2)} on 0.01 ${c}.`,
  },
  'protect-trail-activation': {
    title: 'Trailing stop with activation',
    what: 'The same trailing stop, but it sleeps until the price reaches an activation level. Before that nothing can close the position.',
    when: 'You want room to breathe early in the trade, and protection once it is clearly working.',
    risk: 'Until it activates you have no stop at all. Pair it with a plain stop-loss if that matters.',
    steps: ['You pick the trail distance and the activation level.', 'You sign one order.', 'Hyperliquid waits for the activation price, then trails from the best price since.'],
    figure: lineFigure('trailAct'),
    example: (c, m) => `A long at ${usd(m, 0)}, activation at ${pct(m, 0.04)}, trail 3%: nothing happens until ${c} touches ${pct(m, 0.04)}; then the stop starts near ${usd(m * 1.04 * 0.97, 0)} and rises with the price.`,
  },
};

export const hasGuide = (id: string) => id in GUIDES;

/** The modal for one template id; `onClose` fires on Escape, the backdrop and the Close button. */
export function HowItWorks({ id, coin, mid, onClose }: { id: string; coin: string; mid: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const g = GUIDES[id];
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  if (!g) return null;
  return (
    <dialog ref={ref} className="account hiw" aria-labelledby="hiw-h" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <h2 id="hiw-h">{g.title}: how it works</h2>
      <h3>What it does</h3>
      <p>{g.what}</p>
      <h3>When it works</h3>
      <p>{g.when}</p>
      <h3>What can go wrong</h3>
      <p>{g.risk}</p>
      <h3>Step by step</h3>
      <ol>{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      {g.figure}
      <h3>An example</h3>
      <p>{g.example(coin, mid)}</p>
      <div className="actions"><button className="primary" autoFocus onClick={() => ref.current?.close()}>Close</button></div>
    </dialog>
  );
}

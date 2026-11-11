import type { ReactNode } from 'react';

/** Inline SVGs: they take the page's ink and surface colours, and tell series apart by dash and fill, never colour alone. */
export function Figure({ title, desc, children, h = 170, w = 360 }: { title: string; desc: string; children: ReactNode; h?: number; w?: number }) {
  const id = title.replace(/\W+/g, '-').toLowerCase();
  return (
    <figure className="ill">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${id}-t ${id}-d`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <defs>
          <marker id={`${id}-a`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 1l8 4-8 4z" fill="currentColor" stroke="none" />
          </marker>
        </defs>
        {children}
      </svg>
      <figcaption className="muted small">{desc}</figcaption>
    </figure>
  );
}

export function HedgeIllustration() {
  return (
    <Figure title="A hedge nets the two legs out" desc="Profit and loss over time. Leg 0 (long, solid line) gains when the price rises; leg 1 (short, dashed line) loses the same amount. Their sum (dotted) stays flat, drifting down by costs.">
      <path d="M20 150V12M20 150h330" strokeWidth={1} opacity={0.5} />
      <path d="M20 82h330" strokeWidth={1} strokeDasharray="1 5" opacity={0.6} />
      <polyline points="20,110 80,90 140,60 200,80 260,40 330,55" />
      <polyline points="20,54 80,74 140,104 200,84 260,124 330,109" strokeDasharray="7 5" />
      <polyline points="20,82 330,96" strokeWidth={3} strokeDasharray="1 5" />
      <g className="ill-text" stroke="none" fill="currentColor">
        <text x="262" y="30">leg 0 long</text>
        <text x="262" y="142">leg 1 short</text>
        <text x="232" y="112" opacity={0.85}>net: flat, minus costs</text>
        <text x="24" y="164">time</text>
        <text x="26" y="20">profit / loss</text>
      </g>
    </Figure>
  );
}

export function ArchitectureIllustration() {
  const box = (x: number, y: number, w: number, h: number, a: string, b?: string) => (
    <g key={a}>
      <rect x={x} y={y} width={w} height={h} rx={6} fill="var(--surface)" />
      <g className="ill-text" stroke="none" fill="currentColor" textAnchor="middle">
        <text x={x + w / 2} y={y + (b ? h / 2 - 3 : h / 2 + 4)}>{a}</text>
        {b && <text x={x + w / 2} y={y + h / 2 + 11} opacity={0.75}>{b}</text>}
      </g>
    </g>
  );
  const m = 'url(#how-the-pieces-fit-together-a)';
  return (
    <Figure title="How the pieces fit together" desc="You sign with your wallet. A public NEAR contract checks the rules and asks NEAR's key network to sign for your Hyperliquid legs. The agent can only ask the contract for capped moves between your own legs." h={190} w={424}>
      {box(6, 58, 70, 44, 'You', 'wallet')}
      {box(100, 58, 100, 44, 'NEAR contract', 'the rules')}
      {box(228, 58, 80, 44, 'NEAR keys', 'MPC')}
      {box(334, 58, 84, 44, 'Legs', 'Hyperliquid')}
      <path d="M76 80h22" markerEnd={m} />
      <path d="M200 80h26" markerEnd={m} />
      <path d="M308 80h24" markerEnd={m} />
      {box(85, 134, 130, 40, 'Agent', 'capped, no withdraw')}
      <path d="M150 134V104" markerEnd={m} strokeDasharray="5 4" />
      <g className="ill-text" stroke="none" fill="currentColor"><text x="158" y="124">asks</text></g>
    </Figure>
  );
}

export function GridIllustration() {
  const levels = [30, 55, 80, 105, 130];
  return (
    <Figure title="A grid buys dips and sells bounces" desc="A price line crosses evenly spaced levels. The grid places a buy at each level below the price (hollow circles) and a sell one level up from each fill (filled circles), earning the gap each time the price swings back.">
      {levels.map((y) => <path key={y} d={`M20 ${y}h330`} strokeWidth={1} strokeDasharray="3 5" opacity={0.6} />)}
      <polyline points="20,60 60,100 100,125 140,95 180,70 220,110 260,135 300,100 340,75" strokeWidth={2.5} />
      <g fill="var(--surface)"><circle cx="100" cy="125" r="6" /><circle cx="260" cy="135" r="6" /></g>
      <g fill="currentColor"><circle cx="180" cy="70" r="6" /><circle cx="340" cy="75" r="6" /></g>
      <g className="ill-text" stroke="none" fill="currentColor">
        <text x="70" y="148">buy</text>
        <text x="232" y="154">buy</text>
        <text x="158" y="58">sell</text>
        <text x="312" y="62">sell</text>
      </g>
    </Figure>
  );
}

export function DcaIllustration() {
  return (
    <Figure title="DCA spreads one purchase over time" desc="The price wanders; the strategy buys the same size at every interval (the equal bars), so the average cost lands near the average price instead of depending on one moment.">
      <polyline points="20,50 80,72 140,40 200,82 260,60 330,92" strokeWidth={2.5} />
      {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={36 + i * 52} y={118} width={22} height={28} rx={3} fill="var(--surface)" />)}
      <path d="M20 148h330" strokeWidth={1} opacity={0.5} />
      <g className="ill-text" stroke="none" fill="currentColor">
        <text x="24" y="20">price</text>
        <text x="30" y="112">same size every interval</text>
      </g>
    </Figure>
  );
}

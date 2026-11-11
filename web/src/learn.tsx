import type { ReactNode } from 'react';
import { ArchitectureIllustration, DcaIllustration, GridIllustration, HedgeIllustration } from './illustrations';

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

const CAN = [
  'Place and cancel orders on your legs, inside the coins, leverage and size limits you set.',
  'Move USDC between your own legs, up to your daily cap and cooldown.',
  'Open a hedge on your say-so, and keep it from drifting toward liquidation (the guard).',
  'Run a grid or DCA strategy you started, and stop at any time.',
  'Freeze everything in one signature.',
];
const CANNOT = [
  'Send your funds anywhere except your own legs or back to you.',
  'Withdraw for you. Only you can, and only to your own address.',
  'Promise a profit. Hedges cost fees and funding; strategies can lose.',
  'Trade outside the limits of your policy and each strategy.',
  'Start or resume a strategy without your signature.',
  "Rely on the exchange's own safety net: its dead-man switch needs $1M of trading volume, so after an agent crash resting orders stay until the agent restarts.",
];

const GLOSSARY: [string, string][] = [
  ['Leg', 'One Hyperliquid account whose key the NEAR contract holds. Leg 0 and 1 are the hedge pair, leg 2 is the guard reserve, leg 3 is for strategies.'],
  ['Owner', 'Your wallet address. It signs every setup step and command. Linking other wallets does not change it.'],
  ['Agent key', 'A Hyperliquid API wallet per leg that can trade but not withdraw. The service holds it; you approve it once per leg.'],
  ['Guard', 'The watcher that moves margin from the reserve to a leg near liquidation.'],
  ['Freeze', 'One signature that halts the contract and replaces every trading key with a dead address.'],
  ['Trading balance', 'The perp account value of a leg. Funds on spot cannot trade until you move them to the trading balance.'],
  ['Funding', 'A periodic payment between longs and shorts on perpetual futures. In a hedge the two legs mostly offset each other; size that is not matched costs or earns the difference.'],
  ['Liquidation', 'Hyperliquid closing a position because its margin ran out.'],
  ['Activation fee', 'Hyperliquid charges 1 USDC to start using a new account.'],
  ['Spec hash', 'A fingerprint of a strategy. You sign it, so the agent can only run exactly what you saw.'],
];

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'What HyperNear is',
    body: (
      <>
        <p>
          A normal Hyperliquid account is one private key: whoever holds it can move everything. HyperNear gives you accounts whose keys are held by NEAR's key network. A public NEAR contract decides what may be signed, so the rules are checked by
          code anyone can read, not by a company.
        </p>
        <ArchitectureIllustration />
        <ul>
          <li>Withdrawals go only to your own address.</li>
          <li>The agent that works for you gets a daily allowance and a cooldown that you set, and cannot withdraw.</li>
          <li>One signature freezes everything.</li>
        </ul>
        <p className="muted">The contract limits where funds can go, not whether a trade makes money.</p>
      </>
    ),
  },
  {
    id: 'hedging',
    title: 'What is hedging, and why two legs',
    body: (
      <>
        <p>
          Hedging means holding two positions that move in opposite directions, so a price swing in either direction hurts one and helps the other. HyperNear opens a long on leg 0 and a short on leg 1, sized by the ratio you pick: at
          ratio 1 the two match, at 0.5 half of the long is covered.
        </p>
        <HedgeIllustration />
        <p>
          What it costs: trading fees on both sides, and funding (the periodic payment between longs and shorts) on any size that is not matched. Portfolio shows what the pair would net if closed now, after those costs.
        </p>
        <p>
          Why two accounts instead of one? Each Hyperliquid account has its own margin. A sharp move can push one leg toward liquidation even while the pair is balanced, because the other leg's profit sits in a different account. That is what the
          guard watches.
        </p>
      </>
    ),
  },
  {
    id: 'guard',
    title: 'The guard and the reserve leg',
    body: (
      <>
        <p>
          The agent keeps watching how far each leg is from liquidation. It steps in when margin falls to twice the maintenance level, or when liquidation is closer than a plausible price move during the time a rebalance takes.
        </p>
        <p>
          It then moves USDC from a healthier leg, normally the reserve (leg 2), to the one in trouble. Each move goes through the contract and counts against your daily cap and cooldown, so it can never drain your accounts.
        </p>
      </>
    ),
  },
  {
    id: 'signing',
    title: 'What you sign, and what runs by itself',
    body: (
      <>
        <p><strong>You sign:</strong> preparing and approving agent keys, your policy (agent, daily cap, cooldown), opening or closing a hedge (each command expires after 30 seconds), starting, pausing and stopping strategies, freezing.</p>
        <p><strong>Runs by itself, inside those limits:</strong> the guard's margin moves, strategy orders and the checks on every order (coin, size, leverage) before it is sent.</p>
        <p className="muted">Signing with a passkey or an email wallet is not yet verified end to end. A browser wallet such as MetaMask is the tested path.</p>
      </>
    ),
  },
  {
    id: 'strategies',
    title: 'Strategies: what they are, what they do',
    body: (
      <>
        <p>
          A strategy is a small, fixed set of trading rules that runs on a leg of its own with its own budget. You pick one, change its numbers, read the plain-language summary and sign. The agent then checks every order against your limits,
          and you can pause or stop it at any time.
        </p>
        <h3>Grid</h3>
        <GridIllustration />
        <p>
          Splits a price range into levels and buys at the levels below the price. Each time a buy fills, it sells one level up. It earns the gap while the price moves sideways, and loses when the price keeps falling, because it keeps buying.
        </p>
        <h3>DCA / TWAP</h3>
        <DcaIllustration />
        <p>Buys (or sells) the same amount at fixed intervals, with a price ceiling for each slice. It trades timing risk for a steadier average price.</p>
        <p className="muted">Every strategy shows its worst-case exposure, a loss limit and what happens on stop (cancel the orders, or also close the position) before you start it.</p>
      </>
    ),
  },
  {
    id: 'limits',
    title: 'What it can and cannot do',
    body: (
      <div className="two">
        <div>
          <h3>Can</h3>
          <ul>{CAN.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
        <div>
          <h3>Cannot</h3>
          <ul>{CANNOT.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </div>
    ),
  },
  {
    id: 'testnet',
    title: 'Testnet versus real money',
    body: (
      <>
        <p>This build runs on Hyperliquid testnet and NEAR testnet: test funds, no real money. Testnet markets are thin, so orders may fill slowly or not at all; judge a strategy by whether its orders are placed, filled and cancelled correctly, not by its profit.</p>
        <p>Deposits through the swap network work on mainnet only. On testnet the Fund tab shows a price preview and instructions for test funds.</p>
        <p>Funding a fresh account costs 1 USDC of Hyperliquid activation fee, and every order must be at least $10.</p>
      </>
    ),
  },
  {
    id: 'glossary',
    title: 'Glossary',
    body: (
      <dl className="kv gloss">
        {GLOSSARY.map(([k, v]) => (
          <div key={k} className="gloss-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    ),
  },
];

export function Learn({ slug }: { slug?: string }) {
  return (
    <section className="card learn" aria-labelledby="learn-h">
      <h2 id="learn-h">How it works</h2>
      <p className="muted">Short answers to what HyperNear does and what it cannot do. Open a section.</p>
      {SECTIONS.map((s, i) => (
        <details key={s.id} id={`learn-${s.id}`} open={slug ? slug === s.id : i === 0}>
          <summary>{s.title}</summary>
          <div className="learn-body">{s.body}</div>
        </details>
      ))}
    </section>
  );
}

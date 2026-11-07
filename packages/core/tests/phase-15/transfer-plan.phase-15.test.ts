import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_ROUTE_ETA,
  HYPEREVM_NETWORKS,
  WITHDRAWAL_ROUTE_ETA,
  depositRoutesFor,
  fundingBalanceKey,
  fundingRoute,
  fundingRoutes,
  refusingBlockers,
  resolveTransferPlan,
  withdrawalRoutes,
  type FundingRouteId,
  type HlNetwork,
  type Place,
  type ResolveTransferInput,
  type TransferDirection,
  type TransferPlan,
  type TransferRouteId,
} from '../../src';

// Phase 15 — the transfer-route resolver.
//
// The defect it exists for: which rail a transfer takes was decided in three
// different places that could not agree — `useDeposit`'s mount-time preference
// picked by property, the withdraw tab stacked two forms with no statement that
// they were alternatives, and neither could say why a rail was missing. The
// resolver is one ordering, pure, and pinned by a table rather than by driving a
// screen.
//
// The rule the whole file is built around is step 4 of that ordering: a session
// with no external wallet is never handed a route only an external wallet can
// broadcast ([#813]).

const NETWORKS: HlNetwork[] = ['mainnet', 'testnet'];

const WIRED_FLAGS = [
  'anyChainEnabled',
  'hyperEvmEnabled',
  'hyperEvmGaslessEnabled',
  'cctpEnabled',
  'cctpSponsoredEnabled',
  'cctpWithdrawEnabled',
] as const;

type WiredFlag = (typeof WIRED_FLAGS)[number];
type Wired = Partial<Record<WiredFlag, boolean>>;

/** Every subset of the host-capability flags — 2^6, so no combination is a
 * combination nobody tried. */
const ALL_WIRED: Wired[] = Array.from({ length: 1 << WIRED_FLAGS.length }, (_, mask) => {
  const wired: Wired = {};
  WIRED_FLAGS.forEach((flag, bit) => {
    if (mask & (1 << bit)) wired[flag] = true;
  });
  return wired;
});

const AMOUNTS = ['0.5', '3', '50'];

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const PAYOUT_ADDRESS = '0x2222222222222222222222222222222222222222' as const;

const arbitrumChain = (network: HlNetwork): number => fundingRoute(network, 'direct').chain!.id;
const hyperEvmChain = (network: HlNetwork): number => HYPEREVM_NETWORKS[network].chainId;

function place(kind: Place['kind'], chains: readonly number[], over: Partial<Place> = {}): Place {
  return {
    id: `${kind}-${chains.join('-') || 'any'}`,
    kind,
    label: kind,
    glyph: '•',
    chipBg: 'var(--chip-bg)',
    chipColor: 'var(--chip-fg)',
    chains,
    status: 'ready',
    ...over,
  };
}

const VENUE = place('venue', []);

function resolve(over: Partial<ResolveTransferInput> & { direction: TransferDirection }): TransferPlan {
  const deposit = over.direction === 'deposit';
  return resolveTransferPlan({
    network: 'mainnet',
    amount: '50',
    source: deposit ? place('external-wallet', []) : VENUE,
    destination: deposit ? VENUE : place('address', [], { address: PAYOUT_ADDRESS }),
    externalWallet: null,
    ...over,
  });
}

/** The head plan and every alternative — the whole set a user could reach. */
function everyRoute(plan: TransferPlan): readonly TransferPlan[] {
  return [plan, ...plan.alternatives];
}

/**
 * A `routeBalances` map written in the vocabulary a test reads in — route ids —
 * and keyed the way the resolver reads it, by FUNDING ASSET.
 *
 * Ids that share an asset share a key, which is the whole point and is not
 * symmetric across networks: on mainnet `direct` and both CCTP rows are the
 * same Circle dollar on 42161, while on testnet `direct` is the `USDC2` mock
 * and the CCTP rows are Circle's — same chain, two dollars
 * (`.claude/skills/testnet-usdc-lanes`). Naming a colliding pair with different
 * figures is therefore a test that means nothing; the last write wins and the
 * assertion below it is about neither.
 */
function balances(
  network: HlNetwork,
  by: Partial<Record<FundingRouteId, string | null>>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(by) as [FundingRouteId, string | null][]) {
    const key = fundingBalanceKey(fundingRoute(network, id));
    if (key === null) throw new Error(`route has no funding asset: ${id}`);
    out[key] = value;
  }
  return out;
}

describe('transfer-route resolver — the passkey-only rule', () => {
  it('never offers a session without a wallet a route only a wallet can broadcast', () => {
    // [#813]. The master EOA is gasless by construction, so a route with
    // `requiresExternalWallet` is a dead end for the account type this product
    // is built around: the user is shown a deposit, picks it, and is told to
    // connect a wallet they do not have and cannot get here.
    //
    // Asserted over EVERY network, EVERY host-flag combination and every
    // amount, not one example, because the flags are exactly what a deployment
    // varies and the failure only appears on the combinations nobody tried.
    for (const network of NETWORKS) {
      for (const wired of ALL_WIRED) {
        for (const amount of AMOUNTS) {
          for (const direction of ['deposit', 'withdraw'] as TransferDirection[]) {
            const plan = resolve({ direction, network, wired, amount, externalWallet: null });
            for (const candidate of everyRoute(plan)) {
              expect(
                candidate.requiresExternalWallet,
                `${direction}/${network}/${amount}/${JSON.stringify(wired)} → ${String(candidate.routeId)}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  it('does offer those routes once a wallet is connected — the filter is not a permanent hide', () => {
    // The other half of the same rule: if the drop were unconditional the
    // assertion above would pass on a resolver that never returns those rails
    // at all, which would be a different bug wearing the same green tick.
    const network = 'testnet';
    const source = place('external-wallet', [hyperEvmChain(network)], { address: WALLET });
    const withWallet = resolve({
      direction: 'deposit',
      network,
      source,
      wired: { hyperEvmEnabled: true },
      amount: '3',
      externalWallet: WALLET,
    });
    expect(withWallet.routeId).toBe('hyperEvm');
    expect(withWallet.requiresExternalWallet).toBe(true);

    const withoutWallet = resolve({
      direction: 'deposit',
      network,
      source,
      wired: { hyperEvmEnabled: true },
      amount: '3',
      externalWallet: null,
    });
    expect(withoutWallet.routeId).toBeNull();
    expect(withoutWallet.blockers.map((b) => b.code)).toContain('needs-external-wallet');
  });
});

interface ResolutionCase {
  readonly name: string;
  readonly direction: TransferDirection;
  readonly network: HlNetwork;
  /** Which chains the user's own end of the transfer can serve. */
  readonly chains: 'arbitrum' | 'hyperEvm' | 'unconstrained';
  readonly wired: Wired;
  readonly wallet: boolean;
  readonly amount: string;
  readonly expected: TransferRouteId | null;
}

const RESOLUTIONS: ResolutionCase[] = [
  {
    // Matches today's `useDeposit` mount-time preference, which picks by
    // PROPERTY (available, self-served) and not by name. `direct` is the only
    // rail a passkey session can complete on an unwired mainnet host.
    name: 'a deposit from Arbitrum opens on Bridge2 on mainnet',
    direction: 'deposit',
    network: 'mainnet',
    chains: 'arbitrum',
    wired: {},
    wallet: false,
    amount: '50',
    expected: 'direct',
  },
  {
    name: 'a deposit from Arbitrum opens on Bridge2 on testnet too',
    direction: 'deposit',
    network: 'testnet',
    chains: 'arbitrum',
    wired: {},
    wallet: false,
    amount: '50',
    expected: 'direct',
  },
  {
    // Bridge2 stays ahead of the sponsored CCTP lane even when the host has
    // wired it: both are gasless, Bridge2 states a fee of ZERO against a lane
    // that cannot state one at all, and it lands in seconds and in PERPS — one
    // hop, tradable on arrival.
    name: 'a wired sponsored CCTP lane does not displace Bridge2 above its floor',
    direction: 'deposit',
    network: 'testnet',
    chains: 'arbitrum',
    wired: { cctpSponsoredEnabled: true },
    wallet: false,
    amount: '50',
    expected: 'direct',
  },
  {
    // [#794]'s tester, exactly: below Bridge2's 5-USDC PROTOCOL floor the money
    // is unrecoverable, and the sponsored lane's floor is 2. Fewest blockers is
    // the first sort key precisely so this flips.
    name: 'below the bridge floor the sponsored lane wins on blockers, not on cost',
    direction: 'deposit',
    network: 'testnet',
    chains: 'arbitrum',
    wired: { cctpSponsoredEnabled: true },
    wallet: false,
    amount: '3',
    expected: 'cctpSponsored',
  },
  {
    name: 'a gasless HyperEVM deposit is reachable with no wallet at all',
    direction: 'deposit',
    network: 'testnet',
    chains: 'hyperEvm',
    wired: { hyperEvmEnabled: true, hyperEvmGaslessEnabled: true },
    wallet: false,
    amount: '0.5',
    expected: 'hyperEvmGasless',
  },
  {
    // Same two rails, a wallet present, everything else tied — registry order
    // is the last tiebreak and it is deterministic, not incidental.
    name: 'a tie between two HyperEVM rails falls to registry order',
    direction: 'deposit',
    network: 'testnet',
    chains: 'hyperEvm',
    wired: { hyperEvmEnabled: true, hyperEvmGaslessEnabled: true },
    wallet: true,
    amount: '0.5',
    expected: 'hyperEvm',
  },
  {
    // [#811]. The registry's `planned` on mainnet is a ceiling no host flag can
    // raise, so mainnet exits through Bridge2 with the switch ON.
    name: 'a withdrawal to Arbitrum leaves through Bridge2 on mainnet even with the flag on',
    direction: 'withdraw',
    network: 'mainnet',
    chains: 'arbitrum',
    wired: { cctpWithdrawEnabled: true },
    wallet: false,
    amount: '50',
    expected: 'arbitrum',
  },
  {
    // Same chain, same single ceremony, Circle's real dollar, a fifth of the
    // fee — cost at this amount is what picks it.
    name: 'a withdrawal to Arbitrum prefers the CCTP rail on testnet',
    direction: 'withdraw',
    network: 'testnet',
    chains: 'arbitrum',
    wired: { cctpWithdrawEnabled: true },
    wallet: false,
    amount: '50',
    expected: 'cctpArbitrum',
  },
  {
    name: 'an unwired CCTP rail falls back to Bridge2 rather than disappearing',
    direction: 'withdraw',
    network: 'testnet',
    chains: 'arbitrum',
    wired: {},
    wallet: false,
    amount: '50',
    expected: 'arbitrum',
  },
  {
    // The chain filter keeps a payout off a chain the destination cannot
    // receive on. Serving the chain is necessary and NOT sufficient: the only
    // rail that lands on HyperEVM pays its own signer, so a third party's
    // HyperEVM address has no rail at all and the user is told so. It used to
    // resolve here and pay the user's own balance instead.
    name: 'a third party on HyperEVM has no rail, rather than one that pays someone else',
    direction: 'withdraw',
    network: 'testnet',
    chains: 'hyperEvm',
    wired: { cctpWithdrawEnabled: true },
    wallet: false,
    amount: '50',
    expected: null,
  },
  {
    // Unconstrained destination — which is what the production place
    // derivation actually builds, since an unstated chain must not drop a rail.
    // The cheapest rail that can PAY THIS DESTINATION wins; `hyperEvm` is
    // cheaper still (0.001 vs 0.2 vs 1) and is excluded for paying only its
    // signer, which is the whole of that filter's purpose.
    name: 'the cheapest rail that can pay this destination wins, not the cheapest rail',
    direction: 'withdraw',
    network: 'testnet',
    chains: 'unconstrained',
    wired: { cctpWithdrawEnabled: true },
    wallet: false,
    amount: '50',
    expected: 'cctpArbitrum',
  },
];

describe('transfer-route resolver — resolution table', () => {
  for (const entry of RESOLUTIONS) {
    it(entry.name, () => {
      const chains =
        entry.chains === 'arbitrum'
          ? [arbitrumChain(entry.network)]
          : entry.chains === 'hyperEvm'
            ? [hyperEvmChain(entry.network)]
            : [];
      const deposit = entry.direction === 'deposit';
      const plan = resolve({
        direction: entry.direction,
        network: entry.network,
        amount: entry.amount,
        wired: entry.wired,
        externalWallet: entry.wallet ? WALLET : null,
        ...(deposit
          ? { source: place('external-wallet', chains, { address: WALLET }) }
          : { destination: place('address', chains, { address: PAYOUT_ADDRESS }) }),
      });
      expect(plan.routeId).toBe(entry.expected);
      // The losers are still returned, never silently dropped: the sheet's
      // whole reason to exist is that the alternatives are visible.
      expect(plan.alternatives.some((alt) => alt.routeId === plan.routeId)).toBe(false);
    });
  }
});

describe('transfer-route resolver — what it says when it cannot route', () => {
  it('names what is MISSING rather than saying "unavailable"', () => {
    // An empty candidate set is the moment a user most needs a sentence. The
    // registry already carries one per route (`plannedReference`), and losing
    // it here is what produced "not available on this deployment" with no way
    // to find out what would make it available.
    const network = 'testnet';
    const plan = resolve({
      direction: 'deposit',
      network,
      source: place('external-wallet', [hyperEvmChain(network)]),
      wired: {},
      externalWallet: null,
      amount: '3',
    });
    expect(plan.routeId).toBeNull();
    const noRoute = plan.blockers.find((b) => b.code === 'no-route');
    expect(noRoute).toBeDefined();
    expect(noRoute!.messageKey).toBe('transfer.blocker.noRoute');
    // The reference belongs to the candidate the user could actually act on —
    // the gasless lane, which needs a relay this deployment has not configured,
    // not the one that needs a wallet a passkey session will never have.
    expect(noRoute!.params?.plannedReference).toBe(
      fundingRoute(network, 'hyperEvmGasless').plannedReference,
    );
    expect(plan.blockers.map((b) => b.code)).toContain('route-not-wired');
  });
});

describe('transfer-route resolver — an unread number never refuses a user', () => {
  it('does not turn an unreadable withdrawal ceiling into insufficient-balance', () => {
    // ADR 7.8.7 / [#794] / [#788]: "we could not look" and "it is not there"
    // were one code on the withdrawal rail once, and the second one's copy is
    // what makes a user move their money twice.
    const plan = resolve({
      direction: 'withdraw',
      network: 'testnet',
      amount: '50',
      wired: {},
      destination: place('address', [arbitrumChain('testnet')], { address: PAYOUT_ADDRESS }),
      withdraw3Ceiling: {
        withdrawableUsdc: null,
        source: 'unreadable',
        mode: null,
        heldElsewhere: null,
        perpWithdrawableUsdc: null,
      },
    });
    expect(plan.routeId).toBe('arbitrum');
    expect(plan.blockers.map((b) => b.code)).toContain('ceiling-unknown');
    expect(plan.blockers.map((b) => b.code)).not.toContain('insufficient-balance');
    // And the advisory blocker does not refuse: the amount field stays live.
    expect(refusingBlockers(plan)).toHaveLength(0);
  });

  it('does not turn an unreadable deposit balance into insufficient-balance', () => {
    const network = 'mainnet';
    const plan = resolve({
      direction: 'deposit',
      network,
      amount: '50',
      wired: {},
      source: place('external-wallet', [arbitrumChain(network)], { address: WALLET }),
      routeBalances: balances(network, { direct: null }),
    });
    expect(plan.routeId).toBe('direct');
    expect(plan.blockers.map((b) => b.code)).toContain('ceiling-unknown');
    expect(plan.blockers.map((b) => b.code)).not.toContain('insufficient-balance');
    expect(refusingBlockers(plan)).toHaveLength(0);
  });

  it('still refuses when the balance was READ and is genuinely short', () => {
    // The rule is "an unread balance never refuses", not "no balance ever
    // refuses" — a real zero and a failed read are different sentences.
    const network = 'mainnet';
    const plan = resolve({
      direction: 'deposit',
      network,
      amount: '50',
      wired: {},
      source: place('external-wallet', [arbitrumChain(network)], { address: WALLET }),
      routeBalances: balances(network, { direct: '10' }),
    });
    expect(plan.blockers.map((b) => b.code)).toContain('insufficient-balance');
    expect(refusingBlockers(plan).length).toBeGreaterThan(0);
  });
});

describe('transfer-route resolver — where the money lands', () => {
  const network = 'testnet';
  const spotSource = () => place('external-wallet', [hyperEvmChain(network)]);
  const spotWired = { hyperEvmGaslessEnabled: true } as const;

  it('lands a spot-settling deposit as tradable under a unified account', () => {
    // `.claude/skills/hyperliquid-account-modes`: under `unifiedAccount` the
    // spot balance IS the perp collateral, nothing is missing, and
    // `usdClassTransfer` is refused BY NAME. Reporting that credit as one hop
    // short of tradable tells a fully funded user their money is stuck and
    // sends them at an action Hyperliquid rejects.
    const route = fundingRoute(network, 'hyperEvmGasless');
    expect(route.settlesInto).toBe('spot');
    const plan = resolve({
      direction: 'deposit',
      network,
      amount: '3',
      wired: spotWired,
      source: spotSource(),
      mode: 'unifiedAccount',
    });
    expect(plan.routeId).toBe('hyperEvmGasless');
    expect(plan.landsIn).toBe('tradable');
  });

  it('lands the same deposit as a hop on a split account, and on an unread mode', () => {
    for (const mode of ['disabled', 'default', null] as const) {
      const plan = resolve({
        direction: 'deposit',
        network,
        amount: '3',
        wired: spotWired,
        source: spotSource(),
        mode,
      });
      // 'tradable' and 'spot-auto-hop' render the SAME user-facing sub-line, so
      // an unread mode breaks no promise — which is exactly why there is no
      // third `spot-pending-hop` value to get wrong.
      expect(plan.landsIn).toBe('spot-auto-hop');
    }
  });

  it('lands a withdrawal in a wallet or at an exchange, by what the place IS', () => {
    const chains = [arbitrumChain(network)];
    const toWallet = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      destination: place('self', chains, { address: PAYOUT_ADDRESS }),
    });
    expect(toWallet.landsIn).toBe('wallet');
    const toExchange = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      destination: place('exchange', chains, { address: PAYOUT_ADDRESS }),
    });
    // An exchange deposit address is not a wallet the user controls, and a row
    // that says "arrives in your wallet" about one is wrong in the way that
    // matters.
    expect(toExchange.landsIn).toBe('exchange');
  });
});

describe('transfer-route resolver — the eta band', () => {
  it('gives every rail in both registries a band, derived from the registries', () => {
    // Derived, never a hand-written list: a new rail must FAIL here until
    // somebody decides what to say about its timing, rather than silently
    // inheriting a neighbour's band or an empty one.
    for (const network of NETWORKS) {
      for (const route of fundingRoutes(network)) {
        expect(DEPOSIT_ROUTE_ETA[route.id], route.id).toBeDefined();
        expect(['seconds', 'minutes', 'unknown']).toContain(DEPOSIT_ROUTE_ETA[route.id].band);
      }
      for (const route of withdrawalRoutes(network)) {
        expect(WITHDRAWAL_ROUTE_ETA[route.id], route.id).toBeDefined();
        expect(['seconds', 'minutes', 'unknown']).toContain(WITHDRAWAL_ROUTE_ETA[route.id].band);
      }
    }
  });

  it('states a band and never a number — no rail has a measured settlement time', () => {
    // The only timing constants in the tree are watchdog windows whose own
    // docblocks say they are not deadlines for the money
    // (`CCTP_DELIVERY_TIMEOUT_MS`, and the two 60s/90s confirm windows).
    // Turning one into "~15 minutes" on screen converts how long we are willing
    // to WATCH into a promise about someone else's chain.
    const bands = [
      ...Object.values(DEPOSIT_ROUTE_ETA),
      ...Object.values(WITHDRAWAL_ROUTE_ETA),
    ];
    for (const eta of bands) {
      expect(Object.keys(eta)).toEqual(['band']);
      expect(typeof eta.band).toBe('string');
    }
  });
});

describe('transfer-route resolver — fees and what arrives', () => {
  it('deducts or adds the fee per rail, and never invents one for a deposit', () => {
    const network = 'testnet';
    const chains = [arbitrumChain(network)];
    const cctp = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      wired: { cctpWithdrawEnabled: true },
      destination: place('address', chains, { address: PAYOUT_ADDRESS }),
    });
    expect(cctp.routeId).toBe('cctpArbitrum');
    expect(cctp.feeDirection).toBe('deducted');
    expect(cctp.receiveAmount).toBe('49.8');

    // `self`, not a saved address: this rail pays only its own signer, so a
    // third party's address cannot reach it at all. The fee shape under test is
    // unchanged — only the destination that can legitimately get here.
    const hyperEvm = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      destination: place('self', [hyperEvmChain(network)]),
    });
    expect(hyperEvm.routeId).toBe('hyperEvm');
    // [#902]: this rail charges ON TOP, so the payout is the whole amount and
    // the debit is amount + fee. Quoting it as deducted understates what lands.
    expect(hyperEvm.feeDirection).toBe('on-top');
    expect(hyperEvm.receiveAmount).toBe('50');

    // A CCTP deposit states no fee, and `null` renders as "—" rather than "no
    // fee": that lane pays Circle's flat forwarder charge PLUS a burn fee that
    // moves with the finality threshold (`cctp-sponsored-deposit.ts`), so a '0'
    // here would be a claim nobody can support and the flat half alone would
    // understate it. The rail's own quote is the authority.
    const cctpDeposit = resolve({
      direction: 'deposit',
      network,
      amount: '3',
      wired: { cctpSponsoredEnabled: true },
      source: place('external-wallet', chains, { address: WALLET }),
    });
    expect(cctpDeposit.routeId).toBe('cctpSponsored');
    expect(cctpDeposit.feeUsdc).toBeNull();
    expect(cctpDeposit.feeKind).toBe('unquoted');
    expect(cctpDeposit.receiveAmount).toBeNull();
  });

  it('credits a Bridge2 deposit whole — the one deposit rail that is free by construction', () => {
    // Spike 7.4.1, pinned against Bridge2.sol and the live on-chain reads in
    // docs/roadmap/spikes/recordings/7.4.1-testnet-run.json: the account signs
    // an EIP-2612 permit, the RELAY submits `batchedDepositWithPermit` and pays
    // the gas, the bridge pulls the permitted USDC via `transferFrom`, and the
    // L1 credits the account it came from. Nothing takes a cut and the user
    // broadcasts nothing, so the full permitted amount lands.
    //
    // This is the answer to the redesign's headline question on the DEFAULT
    // route, which is why it is worth a fee fact rather than a "—": the slot
    // showed a dash on the rail most users take.
    for (const network of NETWORKS) {
      const deposit = resolve({
        direction: 'deposit',
        network,
        amount: '50',
        source: place('external-wallet', [arbitrumChain(network)], { address: WALLET }),
      });
      expect(deposit.routeId).toBe('direct');
      expect(deposit.feeKind).toBe('none');
      expect(deposit.feeUsdc).toBe('0');
      // Not "a number near the amount" — the amount, which is what the user
      // checks their Hyperliquid balance against afterwards.
      expect(deposit.receiveAmount).toBe(deposit.amount);
    }
  });

  it('gives every deposit rail a fee kind, derived from the registry', () => {
    // Derived, never a hand-written list — the same contract the eta-band test
    // above holds. A new rail must FAIL here until somebody decides what it
    // costs, rather than silently inheriting a neighbour's answer or defaulting
    // to a zero that renders as "no fee" on a rail that charges.
    for (const network of NETWORKS) {
      for (const route of fundingRoutes(network)) {
        expect(route.feeKind, route.id).toBeDefined();
        expect(['none', 'flat', 'unquoted'], route.id).toContain(route.feeKind);
        // A figure belongs to exactly one kind. `'flat'` without one is not a
        // quote, and `'none'`/`'unquoted'` carrying one is a number with no
        // meaning attached.
        if (route.feeKind === 'flat') expect(route.feeUsdc, route.id).toBeDefined();
        else expect(route.feeUsdc, route.id).toBeUndefined();
      }
    }
  });

  it('states each rail`s plan from that rail`s own registry row and nothing else', () => {
    // The kind → plan mapping, checked against every route the resolver can
    // actually hand a user rather than against the two this file names by hand.
    for (const network of NETWORKS) {
      const plan = resolve({
        direction: 'deposit',
        network,
        amount: '50',
        wired: {
          hyperEvmEnabled: true,
          hyperEvmGaslessEnabled: true,
          cctpEnabled: true,
          cctpSponsoredEnabled: true,
        },
        externalWallet: WALLET,
        source: place('external-wallet', [], { address: WALLET }),
      });
      const reached = everyRoute(plan).filter((item) => item.routeId !== null);
      expect(reached.length).toBeGreaterThan(1);
      for (const item of reached) {
        const route = fundingRoute(network, item.routeId as FundingRouteId);
        if (route.feeKind === 'none') {
          expect(item.feeKind, route.id).toBe('none');
          expect(item.feeUsdc, route.id).toBe('0');
          expect(item.receiveAmount, route.id).toBe(item.amount);
        } else if (route.feeKind === 'flat') {
          expect(item.feeKind, route.id).toBe('flat');
          expect(item.feeUsdc, route.id).toBe(route.feeUsdc);
        } else {
          expect(item.feeKind, route.id).toBe('unquoted');
          // UNKNOWN, never free — and a receive figure computed from an unknown
          // fee is a guess with a number on it.
          expect(item.feeUsdc, route.id).toBeNull();
          expect(item.receiveAmount, route.id).toBeNull();
        }
      }
    }
  });
});

describe('transfer-route resolver — the destination gate', () => {
  it('blocks on the same verdict the withdrawal gate reaches, never a paraphrase', () => {
    const network = 'testnet';
    const plan = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      destination: place('address', [arbitrumChain(network)], { address: PAYOUT_ADDRESS }),
      allowlist: [],
      signerAccount: WALLET,
    });
    const blocked = plan.blockers.find((b) => b.code === 'destination-blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.params?.reason).toBe('not-allowlisted');
  });

  it('does not block on an allowlist that was never read', () => {
    // `checkWithdrawalDestination` returns `unverified` for an unread
    // allowlist, and unverified is not a refusal (ADR 7.8.13) — the server's
    // gate is and stays the authority.
    const network = 'testnet';
    const plan = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      destination: place('address', [arbitrumChain(network)], { address: PAYOUT_ADDRESS }),
    });
    expect(plan.blockers.map((b) => b.code)).not.toContain('destination-blocked');
  });
});

describe('depositRoutesFor', () => {
  it('promotes a planned route the host has wired — the direction withdrawals do not go', () => {
    // The asymmetry this function's docblock exists for: a deposit route has
    // one unknown and it is the host's, so the host may raise it. A withdrawal
    // route has a second unknown no boolean can settle — whether the rail has
    // ever been measured on this network — so there the registry's status is a
    // ceiling. Same file, opposite directions, on purpose.
    for (const network of NETWORKS) {
      const off = depositRoutesFor(network).find((r) => r.id === 'cctpSponsored')!;
      expect(off.status).toBe('planned');
      const on = depositRoutesFor(network, { cctpSponsoredEnabled: true }).find(
        (r) => r.id === 'cctpSponsored',
      )!;
      expect(on.status).toBe('available');
    }
  });

  it('withholds an unlisted rail from the picker while the registry keeps the row', () => {
    for (const network of NETWORKS) {
      expect(depositRoutesFor(network, { anyChainEnabled: true }).map((r) => r.id)).not.toContain(
        'anyChain',
      );
      expect(fundingRoutes(network).map((r) => r.id)).toContain('anyChain');
    }
  });
});

describe('a rail that pays only its signer is not a way to reach a chosen address', () => {
  // `core-to-hyperevm` sends to a system address that credits the SENDER on
  // HyperEVM; its action carries no destination parameter at all. It is also
  // the cheapest of the three rails, so ranking on cost put EVERY withdrawal on
  // it — including one to a saved third-party address, which it then paid to
  // the user's own HyperEVM balance while the card named the address the user
  // picked. Cost cannot be the only thing that decides a payout's destination.
  const withdrawTo = (destination: Place, network: HlNetwork) =>
    resolveTransferPlan({
      direction: 'withdraw',
      network,
      source: VENUE,
      destination,
      amount: '100',
      wired: { cctpWithdrawEnabled: true },
      externalWallet: null,
    });

  for (const network of NETWORKS) {
    it(`never offers a self-only rail for an address the user chose on ${network}`, () => {
      for (const kind of ['address', 'external-wallet'] as const) {
        const plan = withdrawTo(place(kind, [], { address: PAYOUT_ADDRESS }), network);
        const offered = [plan.routeId, ...plan.alternatives.map((alt) => alt.routeId)];
        for (const id of offered) {
          const route = withdrawalRoutes(network).find((candidate) => candidate.id === id);
          expect(route?.paysOnlySelf, `${network}/${kind} offered ${String(id)}`).toBe(false);
        }
      }
    });

    // The legitimate use the rail exists for — moving your OWN Core balance out
    // to your own HyperEVM address. Dropping it there would be a cure worse
    // than the disease.
    it(`still offers it for the user's own address on ${network}`, () => {
      expect(withdrawTo(place('self', []), network).routeId).toBe('hyperEvm');
    });
  }

  // Derived from the registry, so a new withdrawal rail has to say whether it
  // can pay somebody else before it can ship.
  it('makes every withdrawal route state whether it pays only its signer', () => {
    for (const network of NETWORKS) {
      for (const route of withdrawalRoutes(network)) {
        expect(typeof route.paysOnlySelf, `${network}/${route.id}`).toBe('boolean');
      }
    }
  });
});

describe('transfer-route resolver — one balance per funding ASSET', () => {
  // The defect: `depositBlockers` runs per route and was fed ONE balance for
  // every candidate regardless of which chain or which dollar that candidate
  // draws on. A user whose USDC sits only on HyperEVM was therefore measured
  // against their (empty) Arbitrum wallet on every rail — AUTO opened on
  // `direct`, a rail they cannot fund, and the two gasless rails that could
  // carry it were either refused on the wrong number or cleared on it.
  //
  // Nothing new ranks here. `compare` has always put fewest-refusing-blockers
  // first; the fix is only that each route is now measured against its own
  // asset. The table below is the evidence for that claim rather than an
  // assertion of it.
  const network = 'testnet';
  const bothChains = () =>
    place('external-wallet', [arbitrumChain(network), hyperEvmChain(network)], { address: WALLET });
  // Two self-served rails past the bridge, so a passkey-only session actually
  // has somewhere to go. `hyperEvm`/`cctpArbitrum` need a wallet and are
  // dropped by step 4 whatever their balance says.
  const wired = { hyperEvmGaslessEnabled: true, cctpSponsoredEnabled: true } as const;

  const depositWith = (
    routeBalances: Record<string, string | null> | undefined,
    amount: string,
  ): TransferPlan =>
    resolve({
      direction: 'deposit',
      network,
      amount,
      wired,
      source: bothChains(),
      externalWallet: null,
      ...(routeBalances === undefined ? {} : { routeBalances }),
    });

  const planFor = (plan: TransferPlan, id: FundingRouteId): TransferPlan => {
    const found = everyRoute(plan).find((candidate) => candidate.routeId === id);
    if (!found) throw new Error(`route not offered: ${id}`);
    return found;
  };

  /**
   * The ranking, as a table. `arbitrum` funds `direct` (the `USDC2` mock) and
   * `cctpSponsored` (Circle's) alike here only because both are given the same
   * figure — they are separate keys, which the last case below is about.
   */
  const TABLE: readonly {
    readonly name: string;
    readonly held: Partial<Record<FundingRouteId, string | null>>;
    readonly amount: string;
    readonly head: FundingRouteId;
  }[] = [
    // At rest nothing can be exceeded, so the head is still the CHEAPEST rail —
    // `direct` is the only row stating a fee at all (`'0'`), and every other
    // one is `'unquoted'`, which never wins on cost. This is the accepted
    // behaviour, not an oversight: see `depositBlockers`' balance branch.
    { name: 'at rest, unfunded on Arbitrum', held: { direct: '0', cctpSponsored: '0', hyperEvmGasless: '1000' }, amount: '0', head: 'direct' },
    // …and it flips the moment there is an amount to measure.
    { name: 'funded only on HyperEVM', held: { direct: '0', cctpSponsored: '0', hyperEvmGasless: '1000' }, amount: '400', head: 'hyperEvmGasless' },
    // The other way round: the bridge is fundable and cheapest, so it stays.
    { name: 'funded only on Arbitrum', held: { direct: '1000', cctpSponsored: '1000', hyperEvmGasless: '0' }, amount: '400', head: 'direct' },
    // Funded everywhere — no blocker anywhere, so cost decides and the free
    // rail wins. The balance map changed nothing here, which is the control.
    { name: 'funded on both', held: { direct: '1000', cctpSponsored: '1000', hyperEvmGasless: '1000' }, amount: '400', head: 'direct' },
    // A FAILED read is advisory, so it neither refuses nor demotes: `direct`
    // keeps the head on cost even though its own read came back unknown.
    { name: 'Arbitrum read failed', held: { direct: null, cctpSponsored: null, hyperEvmGasless: '1000' }, amount: '400', head: 'direct' },
  ];

  for (const row of TABLE) {
    it(`ranks ${row.name} at ${row.amount} → ${row.head}`, () => {
      expect(depositWith(balances(network, row.held), row.amount).routeId).toBe(row.head);
    });
  }

  it('refuses the rail the user cannot fund, and names the figure it measured', () => {
    const plan = depositWith(
      balances(network, { direct: '0', cctpSponsored: '0', hyperEvmGasless: '1000' }),
      '400',
    );
    expect(plan.routeId).toBe('hyperEvmGasless');
    expect(refusingBlockers(plan)).toHaveLength(0);
    expect(plan.balanceUsdc).toBe('1000');

    const bridge = planFor(plan, 'direct');
    expect(bridge.blockers.map((b) => b.code)).toContain('insufficient-balance');
    // The unfundable rail stays VISIBLE in `change` with its own zero on it —
    // a blocker, not a filter, so the user can see why it is not the one.
    expect(bridge.balanceUsdc).toBe('0');
    expect(
      bridge.blockers.find((b) => b.code === 'insufficient-balance')?.params?.availableUsdc,
    ).toBe('0');
  });

  it('measures two dollars on ONE chain separately', () => {
    // Arbitrum Sepolia carries both the Bridge2 `USDC2` mock and Circle's own
    // USDC (`.claude/skills/testnet-usdc-lanes`). A chain-id key would apply
    // one read to both: either refusing a fundable CCTP lane, or clearing
    // `direct` and walking the user into a permit ceremony for a token they do
    // not hold.
    const directKey = fundingBalanceKey(fundingRoute(network, 'direct'));
    const sponsoredKey = fundingBalanceKey(fundingRoute(network, 'cctpSponsored'));
    expect(directKey).not.toBe(sponsoredKey);
    expect(directKey).toBe(`421614:0x1baabb04529d43a73232b713c0fe471f7c7334d5`);
    expect(sponsoredKey).toBe(`421614:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d`);

    const plan = depositWith(
      balances(network, { direct: '0', cctpSponsored: '1000', hyperEvmGasless: '0' }),
      '400',
    );
    expect(plan.routeId).toBe('cctpSponsored');
    expect(planFor(plan, 'direct').blockers.map((b) => b.code)).toContain('insufficient-balance');
  });

  it('collapses the two HyperEVM rails onto ONE key — same chain, same token', () => {
    // What makes "one read per asset, not per route" true rather than a
    // coincidence of today's registry.
    for (const net of NETWORKS) {
      expect(fundingBalanceKey(fundingRoute(net, 'hyperEvm'))).toBe(
        fundingBalanceKey(fundingRoute(net, 'hyperEvmGasless')),
      );
    }
  });

  it('has no funding asset for the any-chain rail', () => {
    // Chain and token are both `null` by construction — its premise is that the
    // input asset is not fixed — and it is `listed: false`, so it never reaches
    // the blocker today either.
    for (const net of NETWORKS) {
      expect(fundingBalanceKey(fundingRoute(net, 'anyChain'))).toBeNull();
    }
  });

  it('refuses nobody when the map is ABSENT, and nobody when a key is null', () => {
    // The three states are three. `noUncheckedIndexedAccess` is off repo-wide,
    // so a bare index read would type as `string | null` and merge the first
    // two — this is the assertion that would go red if it ever did.
    const absent = depositWith(undefined, '400');
    expect(absent.blockers.map((b) => b.code)).not.toContain('ceiling-unknown');
    expect(absent.blockers.map((b) => b.code)).not.toContain('insufficient-balance');
    expect(refusingBlockers(absent)).toHaveLength(0);
    expect(absent.balanceUsdc).toBeNull();

    const failed = depositWith(
      balances(network, { direct: null, cctpSponsored: null, hyperEvmGasless: null }),
      '400',
    );
    for (const candidate of everyRoute(failed)) {
      expect(candidate.blockers.map((b) => b.code), String(candidate.routeId)).toContain(
        'ceiling-unknown',
      );
      expect(refusingBlockers(candidate), String(candidate.routeId)).toHaveLength(0);
      expect(candidate.balanceUsdc, String(candidate.routeId)).toBeNull();
    }
  });

  it('carries the figure each rail was measured against, per alternative', () => {
    // [#901] made unrepresentable: the plan a surface renders and the plan the
    // resolver refused on are the same object, alternatives included, so a
    // manual override cannot show one rail's balance beside another's refusal.
    const plan = depositWith(
      balances(network, { direct: '12', cctpSponsored: '34', hyperEvmGasless: '56' }),
      '400',
    );
    const held = Object.fromEntries(
      everyRoute(plan).map((candidate) => [candidate.routeId, candidate.balanceUsdc]),
    );
    expect(held).toEqual({ direct: '12', cctpSponsored: '34', hyperEvmGasless: '56' });
  });

  it('states withdraw3 ceiling as the withdrawal side of the same field', () => {
    const plan = resolve({
      direction: 'withdraw',
      network,
      amount: '50',
      wired: {},
      destination: place('address', [arbitrumChain(network)], { address: PAYOUT_ADDRESS }),
      withdraw3Ceiling: {
        withdrawableUsdc: '900.5',
        source: 'perp-clearinghouse',
        mode: 'disabled',
        heldElsewhere: null,
        perpWithdrawableUsdc: '900.5',
      },
    });
    expect(plan.routeId).toBe('arbitrum');
    expect(plan.balanceUsdc).toBe('900.5');
  });

  it('normalizes the withdraw3 ceiling through the check its blockers used', () => {
    // [#901] The card renders `balanceUsdc` and the blocker names
    // `availableUsdc`; if the two reach the user by different paths they agree
    // only by convention. `resolveWithdraw3Ceiling` emits normalized strings,
    // so this trailing zero cannot arrive from it today — which is the point:
    // the guard has to fail when a future caller hand-builds a ceiling, not
    // only when the one current producer regresses.
    const plan = resolve({
      direction: 'withdraw',
      network,
      amount: '5000',
      wired: {},
      destination: place('address', [arbitrumChain(network)], { address: PAYOUT_ADDRESS }),
      withdraw3Ceiling: {
        withdrawableUsdc: '900.50',
        source: 'perp-clearinghouse',
        mode: 'disabled',
        heldElsewhere: null,
        perpWithdrawableUsdc: '900.50',
      },
    });
    expect(plan.routeId).toBe('arbitrum');
    expect(plan.balanceUsdc).toBe('900.5');
    const refused = plan.blockers.find((item) => item.code === 'insufficient-balance');
    expect(refused?.params?.availableUsdc).toBe(plan.balanceUsdc);
  });
});

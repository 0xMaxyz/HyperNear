import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  BRIDGE_DEPOSIT_NETWORKS,
  BRIDGE_MIN_DEPOSIT_USD,
  BRIDGE_ROUTE_MIN_DEPOSIT_USD,
  HYPEREVM_CORE_DEPOSIT,
  HYPEREVM_NETWORKS,
  HYPEREVM_ROUTE_MIN_DEPOSIT_USD,
  WITHDRAW3_FEE_USDC,
  HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC,
  defaultFundingRoute,
  defaultWithdrawalRoute,
  fundingRoute,
  fundingRoutes,
  withdrawalRoute,
  withdrawalRoutes,
  withdrawRoutesFor,
  type FundingRouteId,
  type HlNetwork,
  type WithdrawalRouteId,
} from '../../src';

// [#794] Task 7.10.9 — the funding-route registry (ADR 7.9 decision 1).
//
// The defect these tests pin: deposits offered ONE rail with nowhere to put a
// second. Two hardcoded buttons, no chain or token on the type at all, and a
// single bridge-wide 5-USDC minimum threaded through six files — so a tester
// holding USDC on HyperEVM could deposit none of it and the type system could
// not even express why.
//
// What must hold now is that a route carries its OWN facts, and specifically
// that the two facts a shared constant erased stay distinct per route: where the
// floor comes from (a protocol refusal vs. our own dust guard) and whether the
// credit is tradable collateral when it lands.

const NETWORKS: HlNetwork[] = ['mainnet', 'testnet'];

describe('funding-route registry', () => {
  it('is network-keyed and offers more than one rail on both networks', () => {
    for (const network of NETWORKS) {
      const routes = fundingRoutes(network);
      expect(routes.map((r) => r.id)).toEqual([
        'direct',
        'hyperEvm',
        // ADR 7.9.10 decision 7 — the gasless sibling, immediately after the
        // row it is the gasless version of, exactly as `cctpSponsored` follows
        // `cctpArbitrum`.
        'hyperEvmGasless',
        'cctpArbitrum',
        'cctpSponsored',
        'anyChain',
      ]);
      for (const route of routes) expect(route.network).toBe(network);
    }
  });

  it('carries chain, token, destination and minimum per route', () => {
    for (const network of NETWORKS) {
      for (const route of fundingRoutes(network)) {
        expect(typeof route.minDepositUsd).toBe('number');
        expect(route.minDepositUsd).toBeGreaterThanOrEqual(0);
        expect(['protocol', 'economic', 'none']).toContain(route.minimumKind);
        // The any-chain route is the one that legitimately names no chain and no
        // token — its premise is that the input asset is not fixed.
        if (route.id === 'anyChain') {
          expect(route.chain).toBeNull();
          expect(route.token).toBeNull();
          expect(route.destination).toBeNull();
        } else {
          expect(route.chain?.id).toBeGreaterThan(0);
          expect(route.chain?.label).toBeTruthy();
          expect(route.token?.symbol).toBeTruthy();
          expect(route.token?.decimals).toBe(6);
          expect(route.destination).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
      }
    }
  });

  it('sources the bridge route from BRIDGE_DEPOSIT_NETWORKS rather than duplicating it', () => {
    for (const network of NETWORKS) {
      const bridge = BRIDGE_DEPOSIT_NETWORKS[network];
      const route = fundingRoute(network, 'direct');
      expect(route.chain?.id).toBe(bridge.chainId);
      expect(route.destination).toBe(bridge.bridgeAddress);
      expect(route.token?.address).toBe(bridge.usdcAddress);
      expect(route.mechanism).toBe('permit-relay');
    }
  });

  it('names the bridge s token by its ADDRESS — both networks call it USDC', () => {
    // docs/ops/testnet.md § 1: sending Circle USDC to Bridge2 does not deposit
    // it, it accumulates unclaimed with no recovery path. The route still has to
    // say WHICH of the two dollars on that chain it means — and it says it with
    // the contract, because the symbol never could: three tokens answer to
    // "USDC" and two of them on the same chain.
    //
    // The testnet contract is unchanged and is still the `USDC2` mock. Only its
    // presentation moved: "USDC2" read as a token to avoid, on the one deposit
    // rail a passkey session can complete.
    for (const network of NETWORKS) {
      expect(fundingRoute(network, 'direct').token?.symbol).toBe('USDC');
    }
    expect(fundingRoute('testnet', 'direct').token?.address).toBe(
      '0x1baAbB04529D43a73232B713C0FE471f7c7334d5',
    );
    // The same symbol on the same chain as the CCTP lane's Circle USDC — which
    // is exactly why the address has to travel with it.
    const bridge = fundingRoute('testnet', 'direct');
    const circle = fundingRoute('testnet', 'cctpArbitrum');
    expect(circle.chain?.id).toBe(bridge.chain?.id);
    expect(circle.token?.symbol).toBe(bridge.token?.symbol);
    expect(circle.token?.address).not.toBe(bridge.token?.address);
  });

  it('points the HyperEVM route at the CoreDepositWallet, with the ERC-20 as the token', () => {
    for (const network of NETWORKS) {
      const route = fundingRoute(network, 'hyperEvm');
      const configured = HYPEREVM_CORE_DEPOSIT[network];
      expect(route.chain?.id).toBe(HYPEREVM_NETWORKS[network].chainId);
      expect(route.destination).toBe(configured.coreDepositWallet);
      expect(route.token?.address).toBe(configured.usdc.address);
      // [#788] The two are DIFFERENT addresses, and reading a balance at the
      // deposit wallet reverts. A route that let them collapse would reproduce
      // the "the money has not appeared" report on a withdrawal that had landed.
      expect(route.destination).not.toBe(route.token?.address);
      expect(route.mechanism).toBe('external-wallet-direct');
    }
  });

  it('keeps every registry address checksummed', () => {
    for (const network of NETWORKS) {
      for (const route of fundingRoutes(network)) {
        if (route.destination) expect(getAddress(route.destination)).toBe(route.destination);
        if (route.token) expect(getAddress(route.token.address)).toBe(route.token.address);
      }
    }
  });

  it('distinguishes a protocol floor from an economic one', () => {
    for (const network of NETWORKS) {
      const direct = fundingRoute(network, 'direct');
      expect(direct.minDepositUsd).toBe(5);
      expect(direct.minimumKind).toBe('protocol');

      const hyperEvm = fundingRoute(network, 'hyperEvm');
      // ADR 7.9 probed `depositFor(dead, 0, 0)` on both networks: the only
      // amount guard is `> 0`, so there is no protocol minimum here to enforce.
      // The floor is ours, gas-derived, and must be far below the bridge's.
      expect(hyperEvm.minimumKind).toBe('economic');
      expect(hyperEvm.minDepositUsd).toBe(HYPEREVM_ROUTE_MIN_DEPOSIT_USD);
      expect(hyperEvm.minDepositUsd).toBeLessThan(direct.minDepositUsd);
      // The walk's tester asked to deposit 0.1 USDC on HyperEVM. That is a
      // legitimate deposit on this rail and an unrecoverable loss on the other.
      expect(0.1).toBeGreaterThanOrEqual(hyperEvm.minDepositUsd);
    }
  });

  it('marks the HyperEVM credit as landing in spot, needing a following hop', () => {
    // Spike 7.9 Q2, executed on testnet with 1 USDC: the recipient's SPOT
    // balance rose while their perps accountValue stayed 0.0. Presenting that as
    // tradable collateral is the "deposited but nothing happened" failure.
    for (const network of NETWORKS) {
      const hyperEvm = fundingRoute(network, 'hyperEvm');
      expect(hyperEvm.settlesInto).toBe('spot');
      expect(hyperEvm.requiresFollowUpHop).toBe(true);

      const direct = fundingRoute(network, 'direct');
      expect(direct.settlesInto).toBe('perp');
      expect(direct.requiresFollowUpHop).toBe(false);
    }
  });

  it('lists routes that are not wired yet, with what wires them', () => {
    for (const network of NETWORKS) {
      const byId = Object.fromEntries(fundingRoutes(network).map((r) => [r.id, r]));
      expect(byId.direct!.status).toBe('available');
      for (const id of ['hyperEvm', 'cctpArbitrum', 'cctpSponsored', 'anyChain'] as const) {
        expect(byId[id]!.status).toBe('planned');
        expect(byId[id]!.plannedReference).toBeTruthy();
      }
      // The CCTP lane is testnet-only on purpose: it is the only way to deposit
      // the dollar the testnet faucet pays without touching the `USDC2` bridge,
      // while on mainnet Bridge2 already takes Circle USDC in one gasless
      // signature and lands it in perps.
      expect(byId.cctpArbitrum!.status).toBe('planned');
      expect(byId.cctpArbitrum!.plannedReference).toBeTruthy();
    }
  });

  it('keeps BRIDGE_MIN_DEPOSIT_USD as the bridge route s own floor', () => {
    expect(BRIDGE_MIN_DEPOSIT_USD).toBe(BRIDGE_ROUTE_MIN_DEPOSIT_USD);
    expect(BRIDGE_MIN_DEPOSIT_USD).toBe(fundingRoute('mainnet', 'direct').minDepositUsd);
  });

  it('refuses an unknown route id and an unknown network', () => {
    expect(() => fundingRoute('mainnet', 'nope' as FundingRouteId)).toThrow(/unknown funding route/);
    expect(() => fundingRoutes('devnet' as HlNetwork)).toThrow(/unknown funding network/);
  });

  it('marks the legacy bridge on TESTNET only — the one chain with two dollars', () => {
    // Testnet's Bridge2 takes `USDC2`, a mock, while the faucet pays Circle
    // USDC; the two are indistinguishable by symbol and sending the wrong one is
    // unrecoverable. Mainnet's Bridge2 pins Circle's own USDC, so there is
    // nothing to disambiguate and the flag must stay OFF — labelling the mainnet
    // rail "legacy" would push users off the route that lands in perps.
    expect(fundingRoute('testnet', 'direct').legacyBridge).toBe(true);
    expect(fundingRoute('mainnet', 'direct').legacyBridge).toBe(false);
    for (const network of NETWORKS) {
      expect(fundingRoute(network, 'hyperEvm').legacyBridge).toBe(false);
      expect(fundingRoute(network, 'anyChain').legacyBridge).toBe(false);
    }
  });

  it('names exactly one default per network, and never one that needs a wallet', () => {
    for (const network of NETWORKS) {
      expect(fundingRoutes(network).filter((r) => r.isDefault)).toHaveLength(1);
      // The invariant, not the route name. A default carrying
      // `requiresExternalWallet` opens the picker onto a route the passkey
      // master EOA can never broadcast — it is gasless by construction — so a
      // passkey-only session is met with "connect a wallet" on a deposit it
      // could have made gaslessly one route over. Testnet defaulted to HyperEVM
      // and did exactly that.
      const fallback = defaultFundingRoute(network);
      expect(fallback.requiresExternalWallet).toBe(false);
      expect(fallback.status).toBe('available');
    }
    // Both networks open on Bridge2: one gasless signature, lands in perps.
    expect(defaultFundingRoute('mainnet').id).toBe('direct');
    expect(defaultFundingRoute('testnet').id).toBe('direct');
    expect(fundingRoute('testnet', 'hyperEvm').isDefault).toBe(false);
  });
});

describe('withdrawal-route registry', () => {
  it('offers all three exits on both networks', () => {
    for (const network of NETWORKS) {
      const routes = withdrawalRoutes(network);
      expect(routes.map((r) => r.id)).toEqual(['arbitrum', 'cctpArbitrum', 'hyperEvm']);
      for (const route of routes) expect(route.network).toBe(network);
    }
  });

  it('names the CONTRACT each rail actually PAYS OUT, which differs on testnet', () => {
    // The whole reason this registry exists. `withdraw3` pays the bridge's own
    // token — Circle USDC on mainnet, the `USDC2` mock on testnet — while the
    // HyperEVM rail pays native USDC on both. Every one of them is called
    // "USDC", so the ADDRESS is what stops a withdraw screen naming one rail's
    // dollar on another rail's payout.
    expect(withdrawalRoute('mainnet', 'arbitrum').token.symbol).toBe('USDC');
    expect(withdrawalRoute('testnet', 'arbitrum').token.symbol).toBe('USDC');
    expect(withdrawalRoute('testnet', 'arbitrum').token.address).toBe(
      '0x1baAbB04529D43a73232B713C0FE471f7c7334d5',
    );
    for (const network of NETWORKS) {
      const hyperEvm = withdrawalRoute(network, 'hyperEvm');
      expect(hyperEvm.token.symbol).toBe('USDC');
      // Same name, different contract from the Arbitrum rail's payout — on both
      // networks, and the reason neither screen may identify a dollar by symbol.
      expect(hyperEvm.token.address).not.toBe(withdrawalRoute(network, 'arbitrum').token.address);
      // Sourced from the same const the deposit route and the wallet registry
      // read, so the address a balance is read at cannot drift from the address
      // a payout is expected at (#788).
      expect(hyperEvm.token.address).toBe(HYPEREVM_CORE_DEPOSIT[network].usdc.address);
      expect(hyperEvm.chain.id).toBe(HYPEREVM_NETWORKS[network].chainId);
    }
  });

  it('carries each rail s fee in the shape that rail charges it', () => {
    for (const network of NETWORKS) {
      const arbitrum = withdrawalRoute(network, 'arbitrum');
      expect(arbitrum.feeKind).toBe('flat');
      expect(arbitrum.feeUsdc).toBe(WITHDRAW3_FEE_USDC);
      expect(arbitrum.feeRate).toBeUndefined();

      // [#902] Flat too, and a thousandth of the price — this row carried
      // `proportional` and a 0.088% rate read off a single 1 USDC payout, the
      // one size at which a flat 0.0009 and a 0.088% rate are the same number.
      const hyperEvm = withdrawalRoute(network, 'hyperEvm');
      expect(hyperEvm.feeKind).toBe('flat');
      expect(hyperEvm.feeUsdc).toBe(HYPEREVM_WITHDRAWAL_FLAT_FEE_USDC);
      expect(hyperEvm.feeRate).toBeUndefined();
      expect(Number(hyperEvm.feeUsdc)).toBeLessThan(Number(arbitrum.feeUsdc));
    }
  });

  it('marks the legacy payout on testnet only', () => {
    expect(withdrawalRoute('testnet', 'arbitrum').legacyBridge).toBe(true);
    expect(withdrawalRoute('mainnet', 'arbitrum').legacyBridge).toBe(false);
  });

  it('opens on a route the network can actually carry out — never a planned one', () => {
    // [#811] The default is per-network now, and the rule behind it is the one
    // the deposit picker already learned: a default the deployment cannot
    // complete shows the user an exit and then refuses it.
    //
    // Testnet opens on the CCTP rail — same chain, same single ceremony, a
    // fifth of the fee, and Circle's real dollar. Mainnet still opens on
    // Bridge2 because CCTP is `planned` there until a mainnet execution is
    // measured.
    for (const network of NETWORKS) {
      expect(withdrawalRoutes(network).filter((r) => r.isDefault)).toHaveLength(1);
      expect(defaultWithdrawalRoute(network).status).toBe('available');
    }
    expect(defaultWithdrawalRoute('testnet').id).toBe('cctpArbitrum');
    expect(defaultWithdrawalRoute('mainnet').id).toBe('arbitrum');
  });

  it('pays Circle s real USDC on the CCTP rail, not the bridge s mock', () => {
    // The point of the rail on testnet: three dollars answer to "USDC" and this
    // one is Circle's, at a different address from the Bridge2 payout above.
    const testnet = withdrawalRoute('testnet', 'cctpArbitrum');
    expect(testnet.token.address).toBe('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
    expect(testnet.token.address).not.toBe(withdrawalRoute('testnet', 'arbitrum').token.address);
    expect(withdrawalRoute('mainnet', 'cctpArbitrum').token.address).toBe(
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    );
    for (const network of NETWORKS) {
      const route = withdrawalRoute(network, 'cctpArbitrum');
      // Flat like withdraw3 and deducted the same way, but a fifth of the price.
      expect(route.feeKind).toBe('flat');
      expect(route.feeUsdc).toBe('0.2');
      expect(route.legacyBridge).toBe(false);
      expect(route.mechanism).toBe('send-to-evm-cctp');
    }
  });

  it('withholds the CCTP rail on mainnet even with the host capability flag ON', () => {
    // The feature-gate trap (.claude/skills/feature-gates). Two independent
    // gates guard this rail and flipping only the host one must change nothing
    // on mainnet — the rail is unproven there, and no flag can settle a
    // measurement. Whoever ships mainnet gets handed the second switch by this
    // failing, rather than by staring at an unchanged screen.
    //
    // ⚠️ When a mainnet withdrawal IS measured, DELETE this test and replace it
    // with one asserting the route is reachable. Left standing, it enforces the
    // wrong thing.
    const wiredMainnet = withdrawRoutesFor('mainnet', { cctpWithdrawEnabled: true });
    const cctp = wiredMainnet.find((r) => r.id === 'cctpArbitrum')!;
    expect(cctp.status).toBe('planned');
    expect(cctp.plannedReference).toMatch(/#811/);

    // …and the capability gate really does gate: testnet is available with the
    // flag on and demoted without it, so this is not a row that is simply stuck.
    expect(
      withdrawRoutesFor('testnet', { cctpWithdrawEnabled: true }).find(
        (r) => r.id === 'cctpArbitrum',
      )!.status,
    ).toBe('available');
    expect(
      withdrawRoutesFor('testnet').find((r) => r.id === 'cctpArbitrum')!.status,
    ).toBe('planned');
  });

  it('never demotes the rails that need nothing of the host', () => {
    for (const network of NETWORKS) {
      const routes = withdrawRoutesFor(network);
      expect(routes.find((r) => r.id === 'arbitrum')!.status).toBe('available');
      expect(routes.find((r) => r.id === 'hyperEvm')!.status).toBe('available');
    }
  });

  it('refuses an unknown withdrawal route id and an unknown network', () => {
    expect(() => withdrawalRoute('mainnet', 'nope' as WithdrawalRouteId)).toThrow(
      /unknown withdrawal route/,
    );
    expect(() => withdrawalRoutes('devnet' as HlNetwork)).toThrow(/unknown funding network/);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';
import {
  CCTP_ANY_CALLER,
  CCTP_BURN_LIMIT_USDC,
  CCTP_DEPOSIT_FAILURES,
  CCTP_DEPOSIT_FOR_BURN_ABI,
  CCTP_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_FEE_BPS,
  CCTP_FINALITY_FAST,
  CCTP_FINALITY_STANDARD,
  CCTP_LANES,
  CCTP_RECEIVE_MESSAGE_ABI,
  CCTP_RECEIVE_MESSAGE_SELECTOR,
  CCTP_ROUTE_MIN_DEPOSIT_USD,
  CctpDepositError,
  buildCctpRedeemCall,
  fundingRoute,
  isAttestationRedeemable,
  planCctpDeposit,
  toCctpBytes32,
  type HexAddress,
} from '../../src';

// The CCTP burn leg — "Arbitrum + Circle USDC", built the only way this project
// is allowed to build it (docs/roadmap/spikes/cctp-arbitrum-lane.md).
//
// What these pin is the set of things that cost money to get wrong on a rail
// with an irreversible middle: which contract the approve targets, which dollar
// is burned, where the mint is directed, and — the one this rail exists to be
// careful about — what the flow claims about the user's money once the burn has
// landed but the redemption has not.

const RECIPIENT = '0x8e2F3D9A4C71b0e5AF62D1ab4444444444444444' as HexAddress;
const NETWORKS = ['mainnet', 'testnet'] as const;

describe('the CCTP lane registry', () => {
  it('uses a DIFFERENT Circle deployment per environment, not one set for all chains', () => {
    // This is the correction the spike had to make about itself: reading mainnet
    // with the testnet addresses returns 0 bytes, which reads exactly like "CCTP
    // is not deployed on HyperEVM" and is false.
    expect(CCTP_LANES.testnet.source.tokenMessenger).not.toBe(
      CCTP_LANES.mainnet.source.tokenMessenger,
    );
    expect(CCTP_LANES.testnet.source.messageTransmitter).not.toBe(
      CCTP_LANES.mainnet.source.messageTransmitter,
    );
    // ...and the same set on both ends WITHIN an environment, which is the half
    // that is genuinely shared.
    for (const network of NETWORKS) {
      const lane = CCTP_LANES[network];
      expect(lane.source.tokenMessenger).toBe(lane.destination.tokenMessenger);
      expect(lane.source.messageTransmitter).toBe(lane.destination.messageTransmitter);
    }
  });

  it('burns on domain 3 and mints on domain 19, both networks', () => {
    for (const network of NETWORKS) {
      const lane = CCTP_LANES[network];
      expect(lane.source.domain).toBe(3);
      expect(lane.destination.domain).toBe(19);
    }
  });

  it('names Circle s USDC on the source chain — not the bridge s USDC2', () => {
    // The entire reason this lane is worth building on testnet. Bridge2 takes
    // `0x1baAbB04…`; this burns `0x75faf114…`, which is what the faucet pays.
    expect(CCTP_LANES.testnet.source.usdc).toBe('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
    expect(CCTP_LANES.mainnet.source.usdc).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
    for (const network of NETWORKS) {
      for (const address of [
        CCTP_LANES[network].source.usdc,
        CCTP_LANES[network].destination.usdc,
        CCTP_LANES[network].source.tokenMessenger,
        CCTP_LANES[network].destination.messageTransmitter,
      ]) {
        expect(getAddress(address)).toBe(address);
      }
    }
  });

  it('prices standard finality at zero and makes it the default', () => {
    for (const network of NETWORKS) {
      expect(CCTP_FEE_BPS[network][CCTP_FINALITY_STANDARD]).toBe(0);
      expect(CCTP_FEE_BPS[network][CCTP_FINALITY_FAST]).toBeGreaterThan(0);
    }
    const plan = planCctpDeposit({ network: 'testnet', amount: '25', mintRecipient: RECIPIENT });
    expect(plan.quote.minFinalityThreshold).toBe(CCTP_FINALITY_STANDARD);
    expect(plan.quote.feeUsdc).toBe('0');
    // Free means the whole amount lands, which is the claim the panel makes.
    expect(plan.quote.payoutUsdc).toBe('25');
  });

  it('is host-gated like the HyperEVM rail, and says what each network is waiting on', () => {
    // `planned` in the registry on both networks — the lane needs an external
    // wallet to broadcast three transactions, so only a host can promote it
    // (#813's shape). What differs is WHY, and the reference says so.
    for (const network of NETWORKS) {
      expect(fundingRoute(network, 'cctpArbitrum').status).toBe('planned');
    }
    expect(fundingRoute('testnet', 'cctpArbitrum').plannedReference).toMatch(/connected wallet/i);
    expect(fundingRoute('mainnet', 'cctpArbitrum').plannedReference).toMatch(/Bridge2/);
    // It ends where the HyperEVM rail ends, because its last leg IS that rail.
    for (const network of NETWORKS) {
      const route = fundingRoute(network, 'cctpArbitrum');
      expect(route.settlesInto).toBe('spot');
      expect(route.requiresFollowUpHop).toBe(true);
      // The floor is ours, not Circle's — Circle enforces none.
      expect(route.minimumKind).toBe('economic');
      // The user holds the money on ARBITRUM. That is what separates this row
      // from the `hyperEvm` one, which needs it already on 998/999.
      expect(route.chain?.id).toBe(CCTP_LANES[network].source.chainId);
      expect(route.token?.address).toBe(CCTP_LANES[network].source.usdc);
    }
  });
});

describe('the burn calls', () => {
  const plan = planCctpDeposit({ network: 'testnet', amount: '25', mintRecipient: RECIPIENT });

  it('approves the TOKEN MESSENGER, which is what pulls the USDC', () => {
    // Approving the transmitter or the minter instead is a silent no-op that
    // only fails at the burn, after a signature has been spent.
    const [approve] = plan.calls;
    expect(approve!.kind).toBe('approve');
    expect(approve!.to).toBe(CCTP_LANES.testnet.source.usdc);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve!.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args?.[0]).toBe(CCTP_LANES.testnet.source.tokenMessenger);
    expect(decoded.args?.[1]).toBe(25_000_000n);
  });

  it('burns the exact amount, to the named recipient, on the destination domain', () => {
    const [, burn] = plan.calls;
    expect(burn!.to).toBe(CCTP_LANES.testnet.source.tokenMessenger);
    expect(burn!.data.slice(0, 10)).toBe(CCTP_DEPOSIT_FOR_BURN_SELECTOR);
    const decoded = decodeFunctionData({ abi: CCTP_DEPOSIT_FOR_BURN_ABI, data: burn!.data });
    const [amount, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality] =
      decoded.args!;
    expect(amount).toBe(25_000_000n);
    expect(domain).toBe(19);
    expect(mintRecipient).toBe(toCctpBytes32(RECIPIENT));
    expect(burnToken).toBe(CCTP_LANES.testnet.source.usdc);
    // Anyone may redeem. Pinning a destinationCaller would lock the user out of
    // their own redemption if they changed wallets between the legs.
    expect(destinationCaller).toBe(CCTP_ANY_CALLER);
    expect(maxFee).toBe(0n);
    expect(finality).toBe(CCTP_FINALITY_STANDARD);
  });

  it('left-pads the recipient into bytes32 rather than truncating it', () => {
    const packed = toCctpBytes32(RECIPIENT);
    expect(packed).toHaveLength(66);
    expect(packed.endsWith(RECIPIENT.slice(2).toLowerCase())).toBe(true);
    expect(packed.slice(2, 26)).toBe('0'.repeat(24));
  });

  it('rounds the fee CEILING up, so a small fast transfer is not refused for it', () => {
    // `maxFee` is a limit Circle must fit under. Floor-rounding it takes a small
    // transfer's ceiling to zero and the burn is refused for a fee it would
    // happily have paid.
    const fast = planCctpDeposit({
      network: 'testnet',
      amount: '1',
      mintRecipient: RECIPIENT,
      minFinalityThreshold: CCTP_FINALITY_FAST,
    });
    expect(fast.maxFeeUnits).toBeGreaterThan(0n);
    expect(Number(fast.quote.payoutUsdc)).toBeLessThan(1);
  });

  it('builds the redemption against the DESTINATION transmitter', () => {
    const redeem = buildCctpRedeemCall(CCTP_LANES.testnet, '0xdead', '0xbeef');
    expect(redeem.to).toBe(CCTP_LANES.testnet.destination.messageTransmitter);
    expect(redeem.chainId).toBe(998);
    expect(redeem.data.slice(0, 10)).toBe(CCTP_RECEIVE_MESSAGE_SELECTOR);
    const decoded = decodeFunctionData({ abi: CCTP_RECEIVE_MESSAGE_ABI, data: redeem.data });
    expect(decoded.args).toEqual(['0xdead', '0xbeef']);
  });
});

describe('what is refused before any signature', () => {
  const plan = (over: Partial<Parameters<typeof planCctpDeposit>[0]> = {}) =>
    planCctpDeposit({ network: 'testnet', amount: '25', mintRecipient: RECIPIENT, ...over });

  it('refuses an unparseable or over-precise amount', () => {
    expect(() => plan({ amount: 'abc' })).toThrow(CctpDepositError);
    expect(() => plan({ amount: '1.0000001' })).toThrow(/invalid-amount/);
  });

  it('refuses below our floor and above Circle s burn limit', () => {
    expect(() => plan({ amount: '0.5' })).toThrow(/below-min/);
    expect(() => plan({ amount: String(CCTP_ROUTE_MIN_DEPOSIT_USD) })).not.toThrow();
    expect(() => plan({ amount: String(CCTP_BURN_LIMIT_USDC + 1) })).toThrow(/above-burn-limit/);
  });

  it('refuses a wallet connected to the wrong chain, naming both', () => {
    expect(() => plan({ connectedChainId: 1 })).toThrow(/wrong-source-chain/);
    expect(() => plan({ connectedChainId: 421614 })).not.toThrow();
  });

  it('refuses a KNOWN short balance and leaves an unknown one alone', () => {
    expect(() => plan({ balanceUnits: 1_000_000n })).toThrow(/insufficient-balance/);
    // Unknown is unknown, never zero (#794's rule) — it must not block a deposit
    // the user can actually make.
    expect(() => plan({ balanceUnits: null })).not.toThrow();
    expect(() => plan({ balanceUnits: undefined })).not.toThrow();
  });
});

describe('what the flow is allowed to claim about the money', () => {
  it('says funds have NOT moved for everything refused before the burn', () => {
    for (const code of [
      'invalid-amount',
      'below-min',
      'above-burn-limit',
      'wrong-source-chain',
      'insufficient-balance',
      'approve-declined',
      'burn-declined',
    ] as const) {
      expect(CCTP_DEPOSIT_FAILURES[code].fundsMoved).toBe('no');
    }
  });

  it('never claims the burn did not land once it has been submitted', () => {
    // The window between the legs is the whole risk of this rail. A submitted
    // burn we could not confirm is UNKNOWN — only the chain can say — and every
    // state after a landed burn says the money moved and the flow is resumable.
    expect(CCTP_DEPOSIT_FAILURES['burn-failed'].fundsMoved).toBe('unknown');
    expect(CCTP_DEPOSIT_FAILURES['burn-failed'].resumable).toBe(true);
    for (const code of [
      'attestation-unavailable',
      'redeem-declined',
      'redeem-failed',
      'already-redeemed',
    ] as const) {
      expect(CCTP_DEPOSIT_FAILURES[code].fundsMoved).toBe('yes');
      expect(CCTP_DEPOSIT_FAILURES[code].resumable).toBe(true);
    }
  });

  it('will not submit a pending attestation as if it were redeemable', () => {
    // Circle returns the pending record with a placeholder attestation.
    // Submitting it wastes a transaction and a signature.
    expect(isAttestationRedeemable({ status: 'pending_confirmations', attestation: '0x' })).toBe(
      false,
    );
    expect(isAttestationRedeemable({ status: 'complete', attestation: '0x' })).toBe(false);
    expect(isAttestationRedeemable({ status: 'complete', attestation: '0xabcd' })).toBe(true);
    expect(isAttestationRedeemable(null)).toBe(false);
  });

  it('states the follow-up rail rather than reporting the deposit finished', () => {
    const p = planCctpDeposit({ network: 'testnet', amount: '25', mintRecipient: RECIPIENT });
    expect(p.followUp.railId).toBe('hyperEvm');
    expect(p.followUp.chainId).toBe(998);
  });
});

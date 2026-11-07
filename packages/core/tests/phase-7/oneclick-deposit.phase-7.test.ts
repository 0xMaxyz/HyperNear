import { describe, expect, it } from 'vitest';
import {
  BRIDGE_DEPOSIT_NETWORKS,
  ONECLICK_WIRE_STATUSES,
  buildOneClickQuoteRequest,
  isOneClickFailureStatus,
  isTerminalOneClickStatus,
  oneClickDeliveredUsdcUnits,
  oneClickPhaseForStatus,
  oneClickRefundedUnits,
  type OneClickStatusResponse,
  type OneClickWireStatus,
} from '../../src';

/**
 * Epic 7.4 — "Deposit anything" via NEAR Intents 1Click (task 7.4.4, optional).
 * The pure model: the quote-request builder that pins the delivery to the
 * user's own EOA + this deployment's USDC-on-Arbitrum (so it flows into the
 * 7.4.2 permit path), the status → UI-phase mapping, and the failure/partial
 * bridge surfacing. The `apps/api` lifecycle against recorded 1Click traffic
 * is covered in apps/api/tests/phase-7/deposits.phase-7.test.ts.
 */

const USER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as const;
const ORIGIN_ASSET = 'nep141:eth.omft.near'; // ETH on Ethereum, via 1Click
const DEST_ASSET = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const DEADLINE = '2026-07-22T12:00:00.000Z';

describe('task 7.4.4 — 1Click quote-request builder (delivery pinned to the EOA)', () => {
  it('pins recipient AND refund address to the user’s own EOA', () => {
    const req = buildOneClickQuoteRequest({
      network: 'mainnet',
      userAddress: USER,
      originAsset: ORIGIN_ASSET,
      amount: '1000000000000000000',
      destinationAsset: DEST_ASSET,
      deadline: DEADLINE,
    });
    // The self-custody guarantee: funds can only land at / refund to the user.
    expect(req.recipient).toBe(USER);
    expect(req.refundTo).toBe(USER);
    expect(req.recipientType).toBe('DESTINATION_CHAIN');
    expect(req.refundType).toBe('ORIGIN_CHAIN');
  });

  it('carries the origin/destination assets and defaults slippage + swap type', () => {
    const req = buildOneClickQuoteRequest({
      network: 'testnet',
      userAddress: USER,
      originAsset: ORIGIN_ASSET,
      amount: '5',
      destinationAsset: DEST_ASSET,
      deadline: DEADLINE,
    });
    expect(req.originAsset).toBe(ORIGIN_ASSET);
    expect(req.destinationAsset).toBe(DEST_ASSET);
    expect(req.swapType).toBe('EXACT_INPUT');
    expect(req.depositType).toBe('ORIGIN_CHAIN');
    expect(req.slippageTolerance).toBe(100);
    expect(req.dry).toBe(false);
  });

  it('honors an explicit slippage tolerance and dry flag', () => {
    const req = buildOneClickQuoteRequest({
      network: 'mainnet',
      userAddress: USER,
      originAsset: ORIGIN_ASSET,
      amount: '10',
      destinationAsset: DEST_ASSET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
      dry: true,
    });
    expect(req.slippageTolerance).toBe(50);
    expect(req.dry).toBe(true);
  });

  it('rejects a malformed user address, amount, or slippage', () => {
    const base = {
      network: 'mainnet' as const,
      userAddress: USER,
      originAsset: ORIGIN_ASSET,
      amount: '10',
      destinationAsset: DEST_ASSET,
      deadline: DEADLINE,
    };
    expect(() => buildOneClickQuoteRequest({ ...base, userAddress: '0xnope' as never })).toThrow(
      /address/i
    );
    expect(() => buildOneClickQuoteRequest({ ...base, amount: '0' })).toThrow(/amount/i);
    expect(() => buildOneClickQuoteRequest({ ...base, amount: '-5' })).toThrow(/amount/i);
    expect(() => buildOneClickQuoteRequest({ ...base, slippageToleranceBps: 20_000 })).toThrow(
      /slippage/i
    );
    expect(() => buildOneClickQuoteRequest({ ...base, originAsset: '' })).toThrow(/originAsset/i);
  });

  it('the destination address the delivery must match is the network’s USDC', () => {
    // The 1Click asset id is opaque, but the on-chain USDC/chain the 7.4.2
    // path picks up is the authoritative bridge config — pinned, not guessed.
    expect(BRIDGE_DEPOSIT_NETWORKS.mainnet.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BRIDGE_DEPOSIT_NETWORKS.mainnet.chainId).toBe(42161);
  });
});

describe('task 7.4.4 — status → phase mapping and terminality', () => {
  const cases: Array<[OneClickWireStatus, string, boolean, boolean]> = [
    ['PENDING_DEPOSIT', 'awaiting-deposit', false, false],
    ['INCOMPLETE_DEPOSIT', 'awaiting-deposit', false, false],
    ['KNOWN_DEPOSIT_TX', 'bridging', false, false],
    ['PROCESSING', 'bridging', false, false],
    ['SUCCESS', 'delivered', true, false],
    ['REFUNDED', 'refunded', true, true],
    ['FAILED', 'failed', true, true],
  ];

  it.each(cases)('%s → %s (terminal=%s, failure=%s)', (status, phase, terminal, failure) => {
    expect(oneClickPhaseForStatus(status)).toBe(phase);
    expect(isTerminalOneClickStatus(status)).toBe(terminal);
    expect(isOneClickFailureStatus(status)).toBe(failure);
  });

  it('covers every declared wire status in the phase map', () => {
    for (const status of ONECLICK_WIRE_STATUSES) {
      expect(() => oneClickPhaseForStatus(status)).not.toThrow();
    }
    expect(ONECLICK_WIRE_STATUSES).toHaveLength(7);
  });
});

describe('task 7.4.4 — delivered / refunded amount extraction (7.4.2 handoff)', () => {
  function status(
    s: OneClickWireStatus,
    swapDetails?: OneClickStatusResponse['swapDetails']
  ): OneClickStatusResponse {
    return { status: s, ...(swapDetails ? { swapDetails } : {}) };
  }

  it('returns the delivered USDC units on SUCCESS', () => {
    expect(oneClickDeliveredUsdcUnits(status('SUCCESS', { amountOut: '12500000' }))).toBe(
      12_500_000n
    );
  });

  it('returns null for any non-SUCCESS status (nothing landed at the EOA)', () => {
    for (const s of ['PENDING_DEPOSIT', 'PROCESSING', 'REFUNDED', 'FAILED'] as const) {
      expect(oneClickDeliveredUsdcUnits(status(s, { amountOut: '12500000' }))).toBeNull();
    }
  });

  it('returns null when SUCCESS carries no positive amountOut', () => {
    expect(oneClickDeliveredUsdcUnits(status('SUCCESS'))).toBeNull();
    expect(oneClickDeliveredUsdcUnits(status('SUCCESS', { amountOut: '0' }))).toBeNull();
    expect(oneClickDeliveredUsdcUnits(status('SUCCESS', { amountOut: 'bad' }))).toBeNull();
  });

  it('surfaces the refunded origin amount on REFUNDED (the partial-bridge state)', () => {
    expect(
      oneClickRefundedUnits(status('REFUNDED', { refundedAmount: '1000000000000000000' }))
    ).toBe(1_000_000_000_000_000_000n);
    expect(oneClickRefundedUnits(status('SUCCESS', { amountOut: '5' }))).toBeNull();
    expect(oneClickRefundedUnits(status('REFUNDED'))).toBeNull();
  });
});

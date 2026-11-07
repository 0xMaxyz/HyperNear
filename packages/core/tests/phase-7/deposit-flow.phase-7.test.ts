/**
 * [#196] Phase 7 · Epic 7.3 · Task 7.3.6 — deposits flow (core model).
 *
 * The pure, framework-free half of the deposits flow: the wire-status →
 * UI-phase mapping the client renders, the 5-USDC minimum, the raw-units
 * conversion that binds the permit to the capped amount, and the direct-deposit
 * target derived from Epic 7.4's authoritative `BRIDGE_DEPOSIT_NETWORKS`. Also
 * pins that the retired scaffolds (`DepositPlan`, `PERPS_SEND_ARB_USDC_ADDRESS`,
 * …) no longer leak a second copy of the bridge address.
 */
import { describe, it, expect } from 'vitest';
import {
  BRIDGE_DEPOSIT_NETWORKS,
  BRIDGE_MIN_DEPOSIT_USD,
  BRIDGE_MIN_DEPOSIT_USD_UNITS,
  depositPhaseForStatus,
  describeDirectDeposit,
  isTerminalDepositStatus,
  usdToRawUsdcUnits,
  type BridgeDepositWireStatus,
} from '../../src/index';
import * as core from '../../src/index';

describe('[7.3.6] deposit wire-status → UI phase mapping', () => {
  it('maps a submitted deposit to the confirming phase (non-terminal)', () => {
    expect(depositPhaseForStatus('submitted')).toBe('submitted');
    expect(isTerminalDepositStatus('submitted')).toBe(false);
  });

  it('maps a credited deposit to confirmed (terminal, success)', () => {
    expect(depositPhaseForStatus('credited')).toBe('confirmed');
    expect(isTerminalDepositStatus('credited')).toBe(true);
  });

  it.each<BridgeDepositWireStatus>([
    'preflight-failed',
    'permit-rejected',
    'transfer-failed',
  ])('maps %s to the failed phase (terminal)', (status) => {
    expect(depositPhaseForStatus(status)).toBe('failed');
    expect(isTerminalDepositStatus(status)).toBe(true);
  });
});

describe('[7.3.6] bridge minimum + raw-units conversion', () => {
  it('exposes the 5-USDC minimum in whole USD, matching the raw on-chain units', () => {
    expect(BRIDGE_MIN_DEPOSIT_USD).toBe(5);
    expect(BigInt(BRIDGE_MIN_DEPOSIT_USD * 1_000_000)).toBe(BRIDGE_MIN_DEPOSIT_USD_UNITS);
  });

  it('converts decimal USD to raw 6-decimal USDC units like apps/api', () => {
    expect(usdToRawUsdcUnits('5')).toBe(5_000_000n);
    expect(usdToRawUsdcUnits('12.5')).toBe(12_500_000n);
    expect(usdToRawUsdcUnits('0.000001')).toBe(1n);
  });
});

describe('[7.3.6] direct-deposit target from the authoritative bridge config', () => {
  it('derives the mainnet target from BRIDGE_DEPOSIT_NETWORKS (no duplicated address)', () => {
    const target = describeDirectDeposit('mainnet');
    expect(target.bridgeAddress).toBe(BRIDGE_DEPOSIT_NETWORKS.mainnet.bridgeAddress);
    expect(target.usdcAddress).toBe(BRIDGE_DEPOSIT_NETWORKS.mainnet.usdcAddress);
    expect(target.chainId).toBe(42161);
    expect(target.minDepositUsd).toBe(5);
  });

  it('derives the testnet target too', () => {
    const target = describeDirectDeposit('testnet');
    expect(target.bridgeAddress).toBe(BRIDGE_DEPOSIT_NETWORKS.testnet.bridgeAddress);
    expect(target.chainId).toBe(421614);
  });
});

describe('[7.3.6] scaffolded deposit constants/types retired', () => {
  it('no longer exports the duplicate deposit scaffolds', () => {
    const bag = core as Record<string, unknown>;
    expect(bag.PERPS_SEND_ARB_USDC_ADDRESS).toBeUndefined();
    expect(bag.ARB_USDC_TOKEN_ID).toBeUndefined();
    expect(bag.HYPE_CORE_DEPOSIT_WALLET).toBeUndefined();
    expect(bag.HYPE_EVM_BRIDGE_ADDRESS).toBeUndefined();
  });
});

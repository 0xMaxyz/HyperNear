/**
 * The transfer history's classifier, against the ledger Hyperliquid actually
 * returned for a real testnet account.
 *
 * Every fixture below is a shape observed live on
 * `userNonFundingLedgerUpdates` for `0xa3A50ccC…C6bc`, not one invented to fit
 * the code. Two of them are the reason this file exists: a `send` from the
 * `CoreDepositWallet` is the shared last hop of TWO rails, and the HyperEVM
 * withdrawal appears as `send` OR `spotTransfer` depending on the account's
 * abstraction mode.
 */
import { describe, expect, it } from 'vitest';
import {
  HYPEREVM_CORE_DEPOSIT,
  classifyLedgerEntry,
  transferHistoryFromLedger,
  type HlLedgerUpdate,
} from '../../src/hl';

const ACCOUNT = '0xa3a50cccd49cb5683417533b254eb4f7a85cc6bc';
const SYSTEM = '0x2000000000000000000000000000000000000000';
const CORE_DEPOSIT_WALLET = HYPEREVM_CORE_DEPOSIT.testnet.coreDepositWallet;
const ctx = { network: 'testnet' as const, account: ACCOUNT };

function entry(delta: Record<string, unknown>, time = 1_786_345_927_428): HlLedgerUpdate {
  return { time, hash: `0x${'aa'.repeat(32)}`, delta } as HlLedgerUpdate;
}

describe('the CCTP / HyperEVM credit', () => {
  it('reads a send from the CoreDepositWallet as an inbound credit', () => {
    // The measured 5 USDC sponsored deposit: 4.79935 delivered.
    const row = classifyLedgerEntry(
      entry({
        type: 'send',
        user: CORE_DEPOSIT_WALLET.toLowerCase(),
        destination: ACCOUNT,
        token: 'USDC',
        amount: '4.79935',
        usdcValue: '4.79935',
        fee: '0.0',
      }),
      ctx,
    );
    expect(row.direction).toBe('in');
    expect(row.amountUsd).toBe(4.79935);
    expect(row.token).toBe('USDC');
  });

  it('does NOT claim which rail credited it', () => {
    // Both the HyperEVM depositFor rail and the sponsored CCTP lane finish
    // through this same wallet. The ledger cannot tell them apart, so the row
    // names the HOP and never the rail — saying "CCTP deposit" here would be a
    // false statement in a money history.
    const row = classifyLedgerEntry(
      entry({ type: 'send', user: CORE_DEPOSIT_WALLET, destination: ACCOUNT, usdcValue: '10' }),
      ctx,
    );
    expect(row.kind).toBe('hyperevm-credit');
    expect(row.kind).not.toBe('cctp-deposit');
  });

  it('matches the wallet case-insensitively', () => {
    // The ledger returns lowercase; the registry is checksummed.
    const lower = classifyLedgerEntry(
      entry({ type: 'send', user: CORE_DEPOSIT_WALLET.toLowerCase(), destination: ACCOUNT }),
      ctx,
    );
    expect(lower.kind).toBe('hyperevm-credit');
  });

  it('is per-network — mainnet has a different CoreDepositWallet', () => {
    const onMainnet = classifyLedgerEntry(
      entry({ type: 'send', user: CORE_DEPOSIT_WALLET, destination: ACCOUNT }),
      { network: 'mainnet', account: ACCOUNT },
    );
    // The testnet wallet is not the mainnet one, so on mainnet this is just an
    // inbound transfer from an address we cannot name.
    expect(onMainnet.kind).toBe('transfer');
    expect(onMainnet.direction).toBe('in');
  });
});

describe('withdrawals', () => {
  it('reads a send to the HyperCore system address as the HyperEVM rail', () => {
    const row = classifyLedgerEntry(
      entry({
        type: 'send',
        user: ACCOUNT,
        destination: SYSTEM,
        token: 'USDC',
        amount: '10.0',
        usdcValue: '10.0',
        fee: '0.000919',
      }),
      ctx,
    );
    expect(row.kind).toBe('hyperevm-withdrawal');
    expect(row.direction).toBe('out');
    expect(row.feeUsd).toBeCloseTo(0.000919);
  });

  it('reads the SPLIT-account shape too', () => {
    // The same withdrawal is `sendAsset` on a unified account (`send`) and
    // `usdClassTransfer` + `spotSend` on a split one (`spotTransfer`).
    // Classifying only `send` would silently drop every split-account
    // withdrawal from the history.
    const row = classifyLedgerEntry(
      entry({ type: 'spotTransfer', user: ACCOUNT, destination: SYSTEM, usdcValue: '2.0' }),
      ctx,
    );
    expect(row.kind).toBe('hyperevm-withdrawal');
    expect(row.direction).toBe('out');
  });

  it('reads a bridge withdrawal with its flat fee', () => {
    const row = classifyLedgerEntry(
      entry({ type: 'withdraw', usdc: '4.0', nonce: 1786193386160000, fee: '1.0' }),
      ctx,
    );
    expect(row.kind).toBe('bridge-withdrawal');
    expect(row.direction).toBe('out');
    expect(row.amountUsd).toBe(4);
    expect(row.feeUsd).toBe(1);
  });

  it('reads a bridge deposit', () => {
    const row = classifyLedgerEntry(entry({ type: 'deposit', usdc: '50.0' }), ctx);
    expect(row.kind).toBe('bridge-deposit');
    expect(row.direction).toBe('in');
  });
});

describe('nothing is dropped, and nothing is guessed', () => {
  it('keeps an unknown counterparty unnamed rather than calling it a deposit', () => {
    const row = classifyLedgerEntry(
      entry({
        type: 'send',
        user: '0x1111111111111111111111111111111111111111',
        destination: ACCOUNT,
        usdcValue: '3',
      }),
      ctx,
    );
    expect(row.kind).toBe('transfer');
    expect(row.direction).toBe('in');
    expect(row.counterparty).toBe('0x1111111111111111111111111111111111111111');
  });

  it('renders an unrecognised delta type instead of swallowing the row', () => {
    // The SDK enumerates ~20 variants and Hyperliquid adds more. A row we
    // cannot classify is still the user's money moving.
    const row = classifyLedgerEntry(entry({ type: 'vaultDistribution', usdc: '1.25' }), ctx);
    expect(row.kind).toBe('other');
    expect(row.rawType).toBe('vaultDistribution');
    expect(row.amountUsd).toBe(1.25);
  });

  it('classifies every entry it is given, newest first', () => {
    const rows = transferHistoryFromLedger(
      [
        entry({ type: 'deposit', usdc: '1' }, 100),
        entry({ type: 'somethingNew' }, 300),
        entry({ type: 'withdraw', usdc: '2', fee: '1' }, 200),
      ],
      ctx,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.time)).toEqual([300, 200, 100]);
  });
});

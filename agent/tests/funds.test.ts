import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { canConvert, isUnified, normalizeLeg, USDC_TOKEN } from '../src/funds.ts';
import { Legs, type LegState } from '../src/legs.ts';
import { ch } from './agent-helpers.ts';

describe('normalizeLeg', () => {
  it('leaves a default-mode account as HL reports it', () => {
    const raw = ch({ accountValue: 58.99, maint: 0.5, withdrawable: 56.37 });
    expect(normalizeLeg('default', raw, { spotTotal: 3, hold: 0 })).toEqual({ clearinghouse: raw, spotUsdc: 3 });
  });

  // numbers measured on Hyperliquid testnet after agentSetAbstraction('u') with a BTC position open (docs/unified-accounts.md)
  it('a unified leg shows its spot USDC as equity and total minus hold as free; perp zeros are not the money', () => {
    const raw = ch({ accountValue: 5.24976, maint: 0.4, withdrawable: 0.0216 });
    const n = normalizeLeg('unifiedAccount', raw, { spotTotal: 58.990231, hold: 5.22816 });
    expect(Number(n.clearinghouse.marginSummary.accountValue)).toBeCloseTo(58.990231, 6);
    expect(Number(n.clearinghouse.crossMarginSummary.accountValue)).toBeCloseTo(58.990231, 6);
    expect(Number(n.clearinghouse.withdrawable)).toBeCloseTo(53.762071, 6);
    expect(n.spotUsdc).toBe(0); // already counted in accountValue, so "accountValue + spotUsdc" readers do not double it
    expect(n.unified).toEqual({ spotTotal: 58.990231, hold: 5.22816 });
    expect(n.clearinghouse.crossMaintenanceMarginUsed).toBe(raw.crossMaintenanceMarginUsed); // the exchange's own numbers stay
  });

  it('free is never negative (hold above the total)', () => {
    const n = normalizeLeg('unifiedAccount', ch({ accountValue: 1, maint: 0, withdrawable: 0 }), { spotTotal: 2, hold: 3 });
    expect(Number(n.clearinghouse.withdrawable)).toBe(0);
  });

  it('only a default account can be converted, only unifiedAccount counts as unified', () => {
    expect([isUnified('unifiedAccount'), isUnified('default'), isUnified('portfolioMargin'), isUnified('unknown')]).toEqual([true, false, false, false]);
    expect(['default', 'unifiedAccount', 'disabled', 'portfolioMargin', 'dexAbstraction', 'unknown'].map((a) => canConvert(a as never))).toEqual([true, false, false, false, false, false]);
  });

  it('knows the spot USDC token id of each network', () => {
    expect(USDC_TOKEN.testnet).toMatch(/^USDC:0x[0-9a-f]{32}$/);
    expect(USDC_TOKEN.mainnet).toMatch(/^USDC:0x[0-9a-f]{32}$/);
    expect(USDC_TOKEN.testnet).not.toBe(USDC_TOKEN.mainnet);
  });
});

describe('Legs.convertToUnified', () => {
  const ADDR = '0x1111111111111111111111111111111111111111' as Hex;
  const leg = (o: Partial<LegState> = {}): LegState => ({
    leg: 0, address: ADDR, agent: { address: '0x2222222222222222222222222222222222222222', name: 'hn-leg0', approvedAt: 1 },
    clearinghouse: ch({ accountValue: 30, maint: 0, withdrawable: 30 }), spotUsdc: 0, activation: 'paid', abstraction: 'default', ...o,
  });
  const setup = (send: () => Promise<unknown>) => {
    const legs = new Legs({ client: {} as never, dataDir: null, network: 'testnet', coins: ['BTC'], hl: {} as never });
    const agentSetAbstraction = vi.fn(send);
    legs.tradingClient = () => ({ agentSetAbstraction }) as never;
    return { legs, agentSetAbstraction };
  };
  const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as Hex;

  it('converts an approved, funded default-mode leg with its own agent key', async () => {
    const { legs, agentSetAbstraction } = setup(async () => ({ status: 'ok' }));
    expect(await legs.convertToUnified(OWNER, leg())).toBe('converted');
    expect(agentSetAbstraction).toHaveBeenCalledWith('u');
  });

  it.each([
    ['already unified', leg({ abstraction: 'unifiedAccount' }), 'already'],
    ['portfolio margin (HL refuses a change)', leg({ abstraction: 'portfolioMargin' }), 'skipped'],
    ['unknown mode (read failed)', leg({ abstraction: 'unknown' }), 'skipped'],
    ['agent key not approved yet', leg({ agent: { address: '0x2222222222222222222222222222222222222222', name: 'hn-leg0' } }), 'skipped'],
    ['no agent key', leg({ agent: null }), 'skipped'],
    ['never funded', leg({ activation: 'owed-on-credit' }), 'skipped'],
  ])('does not call HL: %s', async (_n, l, want) => {
    const { legs, agentSetAbstraction } = setup(async () => ({}));
    expect(await legs.convertToUnified(OWNER, l)).toBe(want);
    expect(agentSetAbstraction).not.toHaveBeenCalled();
  });

  it('reports an HL refusal instead of throwing', async () => {
    const { legs } = setup(async () => {
      throw new Error('Must deposit before performing actions. User: 0x11');
    });
    expect(await legs.convertToUnified(OWNER, leg())).toEqual({ failed: expect.stringContaining('Must deposit') });
  });
});

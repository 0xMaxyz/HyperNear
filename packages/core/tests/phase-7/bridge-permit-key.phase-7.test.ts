/**
 * [#787] Phase 7 · task 7.10.2 — the deposit idempotency key is reversible,
 * and `preflight-inconclusive` is part of the wire vocabulary.
 *
 * `apps/api`'s relay keeps its idempotency ledger in memory, and a restart used
 * to drop it silently. Rehydrating it from the durable deposit-tracking store
 * needs the (owner, permit nonce) pair back out of the stored key — that store
 * carries the key and nothing else identifying the permit.
 */
import { describe, it, expect } from 'vitest';

import {
  bridgePermitIdempotencyKey,
  parseBridgePermitIdempotencyKey,
  depositPhaseForStatus,
  isTerminalDepositStatus,
  type HexAddress,
} from '../../src/index';

const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as HexAddress;

describe('[#787] parseBridgePermitIdempotencyKey', () => {
  it('round-trips every key the builder writes', () => {
    for (const nonce of [0n, 1n, 7n, 2n ** 64n]) {
      const key = bridgePermitIdempotencyKey({ owner: OWNER, nonce });
      expect(parseBridgePermitIdempotencyKey(key)).toEqual({
        // The builder lowercases the owner; parsing returns what was stored.
        owner: OWNER.toLowerCase(),
        nonce,
      });
    }
  });

  it('refuses anything that is not a deposit identity', () => {
    for (const key of [
      '',
      'permit-deposit',
      'permit-deposit:0xabc:0',
      `permit-deposit:${OWNER}`,
      `permit-deposit:${OWNER}:`,
      `permit-deposit:${OWNER}:-1`,
      `permit-deposit:${OWNER}:0x1`,
      `permit-deposit:${OWNER}:0:extra`,
      `withdrawal:${OWNER}:0`,
    ]) {
      expect(parseBridgePermitIdempotencyKey(key)).toBeNull();
    }
  });
});

describe('[#787] preflight-inconclusive is part of the wire vocabulary', () => {
  it('renders as a failed, terminal deposit like the other refusals', () => {
    expect(depositPhaseForStatus('preflight-inconclusive')).toBe('failed');
    expect(isTerminalDepositStatus('preflight-inconclusive')).toBe(true);
    // It is NOT the same thing as the bridge predicting a FailedPermitDeposit.
    expect(depositPhaseForStatus('preflight-failed')).toBe('failed');
  });
});

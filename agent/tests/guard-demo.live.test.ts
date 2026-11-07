// LIVE=1 only (ci32, testnet): the guard demo as a test. Same code as `node agent/scripts/guard-demo.ts`.
import { describe, expect, it } from 'vitest';
import { runGuardDemo } from '../scripts/guard-demo.ts';

describe.skipIf(process.env.LIVE !== '1')('live: guard demo (stress leg1 -> guard rebalances from leg0)', () => {
  it('detects, rebalances through the contract, and the leg recovers', async () => {
    const r = await runGuardDemo();
    expect(r.summary.detectMs).not.toBeNull();
    expect(r.summary.nearTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(r.summary.hlPostedMs).toBeGreaterThan(r.summary.detectMs!);
    expect(r.summary.recoveredMs).toBeGreaterThan(r.summary.hlPostedMs!);
    expect(r.summary.leg1RatioAfter).toBeGreaterThan(r.floor);
  }, 600_000);
});

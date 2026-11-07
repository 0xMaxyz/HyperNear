import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { freshKey, funderKey, testnetClient } from '../src/hl';
import { runClaim, writeBlocked } from '../src/results';

const live = LIVE && HAS_FUNDER;

// C11: can an API wallet (agent) do subAccountTransfer? The funder account must already own a
// subaccount (HL gates creating one at $100k volume): set HL_TESTNET_SUBACCOUNT to its address.
// NOTE: this approves a throwaway agent ("hypernear-c11") on the funder account.
describe.skipIf(!live)('C11: agent-signed subAccountTransfer', () => {
  it('agent moves 1 USDC master -> subaccount -> master', async (ctx) => {
    const sub = process.env.HL_TESTNET_SUBACCOUNT as `0x${string}` | undefined;
    if (!sub) {
      writeBlocked('C11', 'C11', 'an API wallet can do subAccountTransfer', 'HL_TESTNET_SUBACCOUNT not set (funder needs an existing subaccount)');
      ctx.skip();
      return;
    }
    await runClaim('C11', 'C11', 'an API wallet can do subAccountTransfer', async (r) => {
      const agent = freshKey();
      const c = testnetClient({ master: funderKey(), agent: agent.key });
      await c.approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c11' });
      const usd = 1_000_000; // 1 USDC in 1e6 units
      try {
        const dep = await c.subAccountTransfer({ subAccountUser: sub, isDeposit: true, usd });
        r.refs.deposit = dep;
        r.numbers.agentCanSubAccountTransfer = true;
        const back = await c.subAccountTransfer({ subAccountUser: sub, isDeposit: false, usd });
        r.refs.withdraw = back;
        expect(dep.status).toBe('ok');
        expect(back.status).toBe('ok');
      } catch (e) {
        r.numbers.agentCanSubAccountTransfer = false;
        r.notes.push(`HL rejected: ${e instanceof Error ? e.message : String(e)}`);
        // a clean rejection is an answer (the README subaccount story changes), not a harness failure
        r.warn('agent-signed subAccountTransfer rejected by HL');
      }
    });
  });
});

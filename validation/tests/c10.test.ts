import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { freshKey, fundFromFunder, funderAddress, snapshot, testnetClient, totalUsdc, waitFor } from '../src/hl';
import { runClaim } from '../src/results';

const live = LIVE && HAS_FUNDER;

// C10: a never-seen address can receive usdSend and then act; measure the activation fee.
// A fresh local key stands in for the derived address (MPC-signed actions are C2/C3).
describe.skipIf(!live)('C10: fresh address receives usdSend, then acts (activation fee)', () => {
  it('measures sender debit, receiver credit and the balance after the first action', async () => {
    await runClaim('C10', 'C10', 'fresh address receives usdSend and then acts (1 USDC activation fee)', async (r) => {
      const fresh = freshKey();
      const agent = freshKey();
      const reader = testnetClient();
      const sendAmount = 5;
      const funderBefore = totalUsdc(await snapshot(reader, funderAddress()));

      r.refs.usdSend = await fundFromFunder(fresh.address, String(sendAmount));
      const got = await waitFor(async () => {
        const s = await snapshot(reader, fresh.address);
        return totalUsdc(s) > 0 ? s : false;
      });
      if (!got) throw new Error('fresh address saw no credit within 30s');
      const funderAfter = totalUsdc(await snapshot(reader, funderAddress()));
      r.numbers.sent = sendAmount;
      r.numbers.receivedTotal = totalUsdc(got);
      r.numbers.funderDebit = funderBefore - funderAfter;
      r.numbers.activationFee = sendAmount - totalUsdc(got);

      // first action by the fresh address: approveAgent
      const act = await testnetClient({ master: fresh.key }).approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c10' });
      r.refs.firstAction = act;
      expect(act.status).toBe('ok');
      const afterAct = await snapshot(reader, fresh.address);
      r.numbers.totalAfterFirstAction = totalUsdc(afterAct);
      r.numbers.feeOnFirstAction = totalUsdc(got) - totalUsdc(afterAct);
      r.refs.freshAddress = fresh.address;
    });
  });
});

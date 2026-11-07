import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { freshKey, fundFromFunder, marketInfo, roundPx, sizeForNotional, snapshot, testnetClient, totalUsdc, waitFor } from '../src/hl';
import { runClaim } from '../src/results';

const live = LIVE && HAS_FUNDER;

// C4: an approved API wallet can trade the leg (order + cancel); and what happens when the same
// agent address is approved by a second master. Local keys stand in for the MPC legs: only the
// approval relationship matters here, not who produced the approving signature (that is C2).
describe.skipIf(!live)('C4: approved agent trades the leg; one agent cannot serve two masters', () => {
  it('order + cancel by the agent, then approve the same agent on leg 2', async () => {
    await runClaim('C4', 'C4', 'approved API wallet trades the leg; same agent on a second master', async (r) => {
      const leg1 = freshKey();
      const leg2 = freshKey();
      const agent = freshKey();
      const reader = testnetClient();
      for (const leg of [leg1, leg2]) {
        await fundFromFunder(leg.address, '15');
      }
      for (const leg of [leg1, leg2]) {
        if (!(await waitFor(async () => totalUsdc(await snapshot(reader, leg.address)) >= 14))) throw new Error('leg not funded in 30s');
      }

      const c1 = testnetClient({ master: leg1.key, agent: agent.key });
      await c1.approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c4' });
      const m = await marketInfo(c1, 'BTC');
      const px = Number(roundPx(m.mid * 0.5)); // far from the book: rests, never fills
      const size = sizeForNotional(11, px, m.szDecimals);
      const order = await c1.limitOrderOpen({ asset: m.asset, isBuy: true, price: String(px), size, tif: 'Gtc' });
      r.refs.order = order;
      const oid = order.response.data.statuses[0]?.resting?.oid;
      expect(oid, JSON.stringify(order)).toBeTypeOf('number');
      const cancel = await c1.cancelOrder({ asset: m.asset, oid: oid! });
      r.refs.cancel = cancel;
      expect(cancel.response.data.statuses[0]).toBe('success');
      r.numbers.agentTradedLeg1 = true;

      // second master approves the SAME agent address
      try {
        await testnetClient({ master: leg2.key }).approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c4' });
        r.numbers.sameAgentOnLeg2 = 'accepted';
        const listed = (await reader.extraAgents({ user: leg2.address })).some((a) => a.address.toLowerCase() === agent.address.toLowerCase());
        r.numbers.agentListedOnLeg2 = listed;
        if (listed) {
          // HL let it through: check the agent can really trade leg 2 as well
          const c2 = testnetClient({ master: leg2.key, agent: agent.key });
          const o2 = await c2.limitOrderOpen({ asset: m.asset, isBuy: true, price: String(px), size, tif: 'Gtc' });
          r.refs.orderLeg2 = o2;
          const oid2 = o2.response.data.statuses[0]?.resting?.oid;
          if (oid2) await c2.cancelOrder({ asset: m.asset, oid: oid2 });
        }
        r.warn('HL accepted the same agent on two masters: one agent per leg may be optional');
      } catch (e) {
        r.numbers.sameAgentOnLeg2 = 'rejected';
        r.notes.push(`second approval rejected: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });
});

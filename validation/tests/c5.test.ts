import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { freshKey, fundFromFunder, funderAddress, marketInfo, sizeForNotional, snapshot, testnetClient, totalUsdc, waitFor } from '../src/hl';
import { runClaim } from '../src/results';

const live = LIVE && HAS_FUNDER;

// C5: a leg holding an open cross position can usdSend up to its `withdrawable`.
describe.skipIf(!live)('C5: usdSend up to withdrawable with an open cross position', () => {
  it('opens a small BTC long, sends floor(withdrawable) back to the funder, closes', async () => {
    await runClaim('C5', 'C5', 'leg with an open cross position can usdSend up to withdrawable', async (r) => {
      const leg = freshKey();
      const agent = freshKey();
      const c = testnetClient({ master: leg.key, agent: agent.key });
      await fundFromFunder(leg.address, '25');
      if (!(await waitFor(async () => totalUsdc(await snapshot(c, leg.address)) >= 24))) throw new Error('leg not funded in 30s');
      await c.approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c5' });

      const m = await marketInfo(c, 'BTC');
      const size = sizeForNotional(15, m.mid, m.szDecimals);
      try {
        const open = await c.placeMarketOrder({ asset: m.asset, isBuy: true, size, midPx: String(m.mid), szDecimals: m.szDecimals });
        r.refs.open = open;
        expect(open.response.data.statuses[0]?.filled, JSON.stringify(open)).toBeTruthy();

        const s = await snapshot(c, leg.address);
        r.numbers.withdrawableWithPosition = s.withdrawable;
        r.numbers.accountValue = s.perpValue;
        r.numbers.positionSzi = s.positions[0]?.szi ?? null;
        const send = Math.floor(s.withdrawable * 100) / 100;
        r.numbers.sent = send;
        expect(send).toBeGreaterThan(0);
        const res = await c.usdSend({ destination: funderAddress(), amount: send.toFixed(2) });
        r.refs.usdSend = res;
        const after = await snapshot(c, leg.address);
        r.numbers.withdrawableAfter = after.withdrawable;
        r.numbers.positionStillOpen = after.positions.length > 0;
        expect(res.status).toBe('ok');
      } finally {
        // flatten the leg even if the claim failed above
        const pos = (await snapshot(c, leg.address)).positions.find((p) => p.coin === 'BTC');
        if (pos) {
          const out = await c.placeMarketOrder({
            asset: m.asset,
            isBuy: Number(pos.szi) < 0,
            size: String(Math.abs(Number(pos.szi))),
            midPx: (await c.allMids()).BTC!,
            szDecimals: m.szDecimals,
            reduceOnly: true,
          });
          r.refs.close = out;
        }
        r.numbers.closedPosition = Boolean(pos);
      }
    });
  });
});

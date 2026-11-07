import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { freshKey, fundFromFunder, marketInfo, roundPx, sizeForNotional, snapshot, testnetClient, totalUsdc, waitFor } from '../src/hl';
import { runClaim } from '../src/results';

const live = LIVE && HAS_FUNDER;

// C19: Hyperliquid's scheduleCancel (dead-man switch) works for an API wallet on testnet: a resting order is cancelled
// by the exchange at the scheduled time, and the schedule can be moved or removed. Phase 2 arms it for grid ladders so
// that after a freeze (which revokes the API wallet) the resting orders still clear by themselves.
describe.skipIf(!live)('C19: scheduleCancel dead-man switch', () => {
  it('cancels a resting order at the scheduled time, with an API wallet signing', async () => {
    await runClaim('C19', 'C19', 'scheduleCancel by an API wallet clears resting orders at the scheduled time', async (r) => {
      const leg = freshKey();
      const agent = freshKey();
      const reader = testnetClient();
      await fundFromFunder(leg.address, '15');
      if (!(await waitFor(async () => totalUsdc(await snapshot(reader, leg.address)) >= 14))) throw new Error('leg not funded in 30s');
      await testnetClient({ master: leg.key }).approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c19' });
      const c = testnetClient({ master: leg.key, agent: agent.key });

      const m = await marketInfo(c, 'BTC');
      const px = Number(roundPx(m.mid * 0.5));
      const order = await c.limitOrderOpen({ asset: m.asset, isBuy: true, price: String(px), size: sizeForNotional(11, px, m.szDecimals), tif: 'Gtc' });
      const oid = order.response.data.statuses[0]?.resting?.oid;
      expect(oid, JSON.stringify(order)).toBeTypeOf('number');
      r.refs.order = order;

      const fireAt = Date.now() + 8_000;
      const armed = await c.scheduleCancel({ time: fireAt });
      r.refs.armed = armed;
      expect(armed.status).toBe('ok');
      const openNow = (await c.openOrders({ user: leg.address })).length;
      r.numbers.openBeforeFire = openNow;
      expect(openNow).toBe(1);

      // moving the schedule works (re-arm), removing it works (no time)
      const moved = await c.scheduleCancel({ time: Date.now() + 60_000 });
      const removed = await c.scheduleCancel({});
      r.refs.rearmed = moved;
      r.refs.removed = removed;
      expect(moved.status).toBe('ok');
      expect(removed.status).toBe('ok');
      expect((await c.openOrders({ user: leg.address })).length, 'order must survive when the schedule was removed').toBe(1);

      // arm again and let it fire
      const fireAt2 = Date.now() + 6_000;
      await c.scheduleCancel({ time: fireAt2 });
      const cleared = await waitFor(async () => (await c.openOrders({ user: leg.address })).length === 0, { timeoutMs: 30_000, everyMs: 1_500 });
      r.numbers.clearedByExchange = Boolean(cleared);
      r.numbers.msFromScheduleToCleared = cleared ? Date.now() - fireAt2 : null;
      expect(cleared).toBeTruthy();
      r.refs.leg = leg.address;
    });
  }, 120_000);
});

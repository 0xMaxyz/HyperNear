import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE, labWallet } from '../src/env';
import { fetchTransport, freshKey, marketInfo, sizeForNotional, snapshot, testnetClient, waitFor } from '../src/hl';
import { runClaim } from '../src/results';

const live = LIVE && HAS_FUNDER;

const VOLUME_GATE_USD = 100_000;
const NOTIONAL_USD = 18_000; // per side; 20x cross on ~1000 USDC
const MAX_ROUND_TRIPS = 6;
const SUB_NAME = 'hypernear-c11';

// C11: can an API wallet do subAccountTransfer? Lab wallet #10 needs >= $100k volume to create a
// subaccount: the test raises it with round-trip IOC trades on BTC (skipped when already there),
// creates the subaccount if missing, approves a throwaway API wallet and has THAT wallet sign
// subAccountTransfer master -> sub -> master (1 USDC). Idempotent: each step checks state first.
describe.skipIf(!live)('C11: agent-signed subAccountTransfer (lab wallet #10)', () => {
  it('raises volume if needed, creates a subaccount, agent moves 1 USDC in and out', async () => {
    await runClaim('C11', 'C11', 'an API wallet can do subAccountTransfer', async (r) => {
      const lab = labWallet(10);
      const agent = freshKey();
      const c = testnetClient({ master: lab.key, agent: agent.key });
      const transport = fetchTransport();

      const volume = async () => {
        const fees = await c.userFees({ user: lab.address });
        return fees.dailyUserVlm.reduce((t, d) => t + Number(d.userCross) + Number(d.userAdd), 0);
      };
      const subAccounts = async () =>
        ((await transport.request('info', { type: 'subAccounts', user: lab.address })) as Array<{ name: string; subAccountUser: `0x${string}` }> | null) ?? [];

      r.refs.labWallet = lab.address;
      const start = await snapshot(c, lab.address);
      r.numbers.startValue = start.perpValue;
      r.numbers.startVolume = await volume();

      await c.approveAgent({ agentAddress: agent.address, agentName: 'hypernear-c11' });

      let sub = (await subAccounts()).find((s) => s.name === SUB_NAME);

      // 1. volume (skipped when a subaccount already exists or the gate is already met)
      if (!sub && (await volume()) < VOLUME_GATE_USD) {
        const m = await marketInfo(c, 'BTC');
        await c.updateLeverage({ asset: m.asset, isCross: true, leverage: 20 });
        let trips = 0;
        while (trips < MAX_ROUND_TRIPS && (await volume()) < VOLUME_GATE_USD) {
          const mid = (await c.allMids()).BTC!;
          const size = sizeForNotional(NOTIONAL_USD, Number(mid), m.szDecimals);
          try {
            await c.placeMarketOrder({ asset: m.asset, isBuy: true, size, midPx: mid, szDecimals: m.szDecimals });
          } finally {
            // always flatten, also when the open failed half way
            const pos = (await snapshot(c, lab.address)).positions.find((p) => p.coin === 'BTC');
            if (pos) {
              await c.placeMarketOrder({
                asset: m.asset,
                isBuy: Number(pos.szi) < 0,
                size: String(Math.abs(Number(pos.szi))),
                midPx: (await c.allMids()).BTC!,
                szDecimals: m.szDecimals,
                reduceOnly: true,
              });
            }
          }
          trips++;
        }
        r.numbers.roundTrips = trips;
        // reported volume can lag the fills
        await waitFor(async () => (await volume()) >= VOLUME_GATE_USD, { timeoutMs: 90_000, everyMs: 5_000 });
      }
      const vol = await volume();
      r.numbers.volumeUsd = vol;
      const end = await snapshot(c, lab.address);
      r.numbers.testUsdcSpentOnFees = start.perpValue - end.perpValue;

      // 2. subaccount
      if (!sub) {
        if (vol < VOLUME_GATE_USD) {
          r.warn(`volume ${vol.toFixed(0)} still below the ${VOLUME_GATE_USD} gate; subaccount not created`);
          return;
        }
        r.refs.createSubAccount = await c.createSubAccount({ name: SUB_NAME });
        sub = await waitFor(async () => (await subAccounts()).find((s) => s.name === SUB_NAME));
      }
      expect(sub, 'subaccount missing after createSubAccount').toBeTruthy();
      r.refs.subAccount = sub!.subAccountUser;

      // 3. the API wallet signs subAccountTransfer
      const usd = 1_000_000; // 1 USDC in 1e6 units
      try {
        r.refs.deposit = await c.subAccountTransfer({ subAccountUser: sub!.subAccountUser, isDeposit: true, usd });
        r.numbers.agentCanSubAccountTransfer = true;
        r.refs.withdraw = await c.subAccountTransfer({ subAccountUser: sub!.subAccountUser, isDeposit: false, usd });
      } catch (e) {
        r.numbers.agentCanSubAccountTransfer = false;
        r.notes.push(`HL rejected: ${e instanceof Error ? e.message : String(e)}`);
        // a clean rejection is an answer (the README subaccount story changes), not a harness failure
        r.warn('agent-signed subAccountTransfer rejected by HL');
      }
    });
  });
});

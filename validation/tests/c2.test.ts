import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import { privateKeyToAccount } from 'viem/accounts';
import {
  freshKey,
  marketInfo,
  readHexKeyFile,
  roundPx,
  signFreshApproveAgent,
  sizeForNotional,
  fundFromFunder,
  loadSignedActionFile,
  recoverUserSigned,
  signApproveAgentLocally,
  snapshot,
  submitSignedAction,
  testnetClient,
  totalUsdc,
  waitFor,
} from '../src/hl';
import { runClaim, writeBlocked } from '../src/results';

// contract/out is gitignored, so on ci32 point C2_FILE_PATH at a copy of the file
const C2_FILE = process.env.C2_FILE_PATH ?? 'contract/out/c2-approve-agent.json';
const live = LIVE && HAS_FUNDER;
const FUND = '5';

describe('C2 offline: contract-dev artefact is self-consistent', () => {
  const f = loadSignedActionFile(C2_FILE);
  it.skipIf(!f)('signature recovers to the derived address', async () => {
    expect(await recoverUserSigned(f!.action, f!.signature)).toBe(f!.address);
  });
});

// Proves the "submit a pre-signed user-signed action JSON" path with a local key. NOT claim C2.
describe.skipIf(!live)('harness self-check (live): local key ApproveAgent submitted as pre-signed JSON', () => {
  it('HL accepts it and extraAgents lists the agent', async () => {
    await runClaim('harness-c2-selfcheck', 'harness-C2', 'harness self-check: local-key approveAgent via submitSignedAction', async (r) => {
      const master = freshKey();
      const agent = freshKey();
      const client = testnetClient();
      const fund = await fundFromFunder(master.address, FUND);
      r.refs.fund = fund;
      const funded = await waitFor(async () => totalUsdc(await snapshot(client, master.address)) > 0);
      if (!funded) throw new Error('master not funded within 30s');
      const body = await signApproveAgentLocally(master.key, agent.address, 'hn-selfcheck');
      const res = await submitSignedAction(body.action, body.signature);
      r.refs.exchange = res;
      expect(res.status).toBe('ok');
      const seen = await waitFor(async () =>
        (await client.extraAgents({ user: master.address })).find((a) => a.address.toLowerCase() === agent.address.toLowerCase()),
      );
      r.numbers.agentListed = Boolean(seen);
      expect(seen).toBeTruthy();
      r.refs.master = master.address;
      r.refs.agent = agent.address;
    });
  });
});

// The real C2: HL testnet accepts approveAgent signed by NEAR MPC from a derived address.
// Needs C2_SIGN_DIR (contract-dev checkout with contract/scripts/sign-approve.mjs and NEAR credentials,
// on ci32: ~/work/near_hck-contract) to get a fresh signature at submit time; the committed-to-disk
// file only supplies addresses, because its nonce goes stale. Also: C10 on derived addresses, and C4 on
// leg0 with the MPC-approved agent (LEG0_AGENT_KEY_PATH).
describe.skipIf(!live)('C2: MPC-signed approveAgent accepted by HL testnet', () => {
  const f = loadSignedActionFile(C2_FILE);
  const signDir = process.env.C2_SIGN_DIR;
  const FUND_LEG = '20';
  const title = 'HL accepts approveAgent signed by MPC from a derived address';
  let approved = false;

  it('funds the legs (C10 on derived addresses), signs fresh, submits, extraAgents lists the agent', async (ctx) => {
    if (!f || !signDir) {
      writeBlocked('C2', 'C2', title, !f ? `${C2_FILE} missing` : 'C2_SIGN_DIR not set');
      ctx.skip();
      return;
    }
    const legs = f.meta?.legs as Record<string, `0x${string}`>;
    const agentAddress = f.action.agentAddress as `0x${string}`;
    const agentName = String(f.action.agentName ?? '');
    const client = testnetClient();

    await runClaim('C10-derived', 'C10', 'derived (MPC) addresses receive usdSend; activation fee', async (r) => {
      for (const [path, addr] of Object.entries(legs)) {
        const before = totalUsdc(await snapshot(client, addr));
        if (before >= Number(FUND_LEG) - 2) {
          r.numbers[`${path}.alreadyFunded`] = before;
          continue;
        }
        r.refs[`${path}.usdSend`] = await fundFromFunder(addr, FUND_LEG);
        const got = await waitFor(async () => {
          const s = await snapshot(client, addr);
          return totalUsdc(s) > before ? s : false;
        });
        if (!got) throw new Error(`${path} saw no credit within 30s`);
        r.numbers[`${path}.sent`] = Number(FUND_LEG);
        r.numbers[`${path}.received`] = totalUsdc(got) - before;
        r.numbers[`${path}.activationFee`] = Number(FUND_LEG) - (totalUsdc(got) - before);
      }
    });

    await runClaim('C2', 'C2', title, async (r) => {
      const t0 = Date.now();
      const signed = signFreshApproveAgent(signDir, 'test/leg0', agentAddress, agentName);
      r.numbers.signAndPollMs = Date.now() - t0;
      r.numbers.signGasTGas = Number(signed.gasTGas);
      r.refs.nearSignTx = signed.signTx;
      r.refs.derivedAddress = signed.master;
      r.refs.signatureChainId = signed.exchangeRequest.action.signatureChainId;
      expect(signed.master.toLowerCase()).toBe(f.address.toLowerCase());
      // our own verifier agrees before HL sees it
      expect((await recoverUserSigned(signed.exchangeRequest.action, signed.exchangeRequest.signature)).toLowerCase()).toBe(f.address.toLowerCase());
      const res = await submitSignedAction(signed.exchangeRequest.action, signed.exchangeRequest.signature);
      r.refs.exchange = res;
      expect(res.status, JSON.stringify(res)).toBe('ok');
      const seen = await waitFor(async () =>
        (await client.extraAgents({ user: f.address })).find((a) => a.address.toLowerCase() === agentAddress.toLowerCase()),
      );
      r.numbers.agentListed = Boolean(seen);
      r.refs.listedAgent = seen ?? null;
      expect(seen).toBeTruthy();
      approved = true;
    });
  }, 300_000);

  it('C4 on leg0: the MPC-approved agent places and cancels an order', async (ctx) => {
    const keyPath = process.env.LEG0_AGENT_KEY_PATH;
    if (!approved || !keyPath || !f) {
      writeBlocked('C4-leg0', 'C4', 'MPC-approved agent trades leg0', !approved ? 'approveAgent step did not pass' : 'LEG0_AGENT_KEY_PATH not set');
      ctx.skip();
      return;
    }
    await runClaim('C4-leg0', 'C4', 'MPC-approved agent trades leg0 (order + cancel)', async (r) => {
      const agentKey = readHexKeyFile(keyPath);
      expect(privateKeyToAccount(agentKey).address.toLowerCase()).toBe(String(f.action.agentAddress).toLowerCase());
      const c = testnetClient({ agent: agentKey });
      const m = await marketInfo(c, 'BTC');
      const px = Number(roundPx(m.mid * 0.5));
      const order = await c.limitOrderOpen({ asset: m.asset, isBuy: true, price: String(px), size: sizeForNotional(11, px, m.szDecimals), tif: 'Gtc' });
      r.refs.order = order;
      const oid = order.response.data.statuses[0]?.resting?.oid;
      expect(oid, JSON.stringify(order)).toBeTypeOf('number');
      const cancel = await c.cancelOrder({ asset: m.asset, oid: oid! });
      r.refs.cancel = cancel;
      expect(cancel.response.data.statuses[0]).toBe('success');
      r.numbers.agentTradedLeg0 = true;
    });
  }, 120_000);
});

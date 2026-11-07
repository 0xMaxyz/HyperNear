import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import {
  freshKey,
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

const C2_FILE = 'contract/out/c2-approve-agent.json';
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
describe.skipIf(!live)('C2: MPC-signed approveAgent accepted by HL testnet', () => {
  it('submits contract/out/c2-approve-agent.json and extraAgents lists the agent', async (ctx) => {
    const f = loadSignedActionFile(C2_FILE);
    if (!f) {
      writeBlocked('C2', 'C2', 'HL accepts approveAgent signed by MPC from a derived address', `${C2_FILE} not produced yet`);
      ctx.skip();
      return;
    }
    await runClaim('C2', 'C2', 'HL accepts approveAgent signed by MPC from a derived address', async (r) => {
      const client = testnetClient();
      expect(await recoverUserSigned(f.action, f.signature)).toBe(f.address);
      const before = await snapshot(client, f.address);
      r.numbers.usdcBefore = totalUsdc(before);
      if (totalUsdc(before) === 0) {
        r.notes.push(`derived address unfunded; funded ${FUND} USDC from funder first (see C10)`);
        r.refs.fund = await fundFromFunder(f.address, FUND);
        await waitFor(async () => totalUsdc(await snapshot(client, f.address)) > 0);
      }
      const res = await submitSignedAction(f.action, f.signature);
      r.refs.exchange = res;
      r.refs.derivedAddress = f.address;
      r.refs.signatureChainId = f.action.signatureChainId;
      expect(res.status, JSON.stringify(res)).toBe('ok');
      const agentAddress = String(f.action.agentAddress).toLowerCase();
      const seen = await waitFor(async () =>
        (await client.extraAgents({ user: f.address })).find((a) => a.address.toLowerCase() === agentAddress),
      );
      r.numbers.agentListed = Boolean(seen);
      expect(seen).toBeTruthy();
    });
  });
});

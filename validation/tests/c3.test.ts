import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import {
  funderAddress,
  fundFromFunder,
  loadSignedActionFile,
  recoverUserSigned,
  signFreshAction,
  snapshot,
  submitSignedAction,
  testnetClient,
  totalUsdc,
  waitFor,
} from '../src/hl';
import { runClaim } from '../src/results';

// Offline: any pre-signed artefact contract-dev leaves behind must recover to its derived address.
const FILES = {
  usdSend: 'contract/out/c3-usd-send.json',
  withdraw3: 'contract/out/c3-withdraw3.json',
  usdClassTransfer: 'contract/out/c3-usd-class-transfer.json',
} as const;

describe('C3 offline: artefacts (when present) recover to their derived address', () => {
  for (const [name, path] of Object.entries(FILES)) {
    const f = loadSignedActionFile(path);
    it.skipIf(!f)(name, async () => {
      expect((await recoverUserSigned(f!.action, f!.signature)).toLowerCase()).toBe(f!.address.toLowerCase());
    });
  }
});

// Live: sign on demand with contract-dev's sign-action.mjs (C2_SIGN_DIR = its checkout on ci32), submit, watch balances.
const live = LIVE && HAS_FUNDER && Boolean(process.env.C2_SIGN_DIR);
const PATH = 'test/leg0';
const LEG0 = '0xff689f4bf14686c751df87304178eacb3c2194e3' as const;

describe.skipIf(!live)('C3: HL accepts usdSend / withdraw3 / usdClassTransfer signed by MPC (leg0)', () => {
  const signDir = process.env.C2_SIGN_DIR!;
  const dest = () => funderAddress().toLowerCase();

  async function run(name: string, buildArgs: (s: Awaited<ReturnType<typeof snapshot>>) => Record<string, unknown>) {
    await runClaim(`C3-${name}`, 'C3', `HL accepts ${name} signed by MPC (caller-supplied nonce)`, async (r) => {
      const client = testnetClient();
      let before = await snapshot(client, LEG0);
      if (totalUsdc(before) < 8) {
        r.refs.topUp = await fundFromFunder(LEG0, '20');
        await waitFor(async () => totalUsdc(await snapshot(client, LEG0)) > totalUsdc(before));
        before = await snapshot(client, LEG0);
      }
      const args = buildArgs(before);
      const signed = signFreshAction(signDir, name, PATH, args);
      r.numbers.signGasTGas = Number(signed.gasTGas);
      r.refs.nearSignTx = signed.signTx;
      r.refs.action = signed.exchangeRequest.action;
      expect((await recoverUserSigned(signed.exchangeRequest.action, signed.exchangeRequest.signature)).toLowerCase()).toBe(LEG0);
      const res = await submitSignedAction(signed.exchangeRequest.action, signed.exchangeRequest.signature);
      r.refs.exchange = res;
      expect(res.status, JSON.stringify(res)).toBe('ok');
      const after = await waitFor(async () => {
        const s = await snapshot(client, LEG0);
        return s.perpValue !== before.perpValue || s.spotUsdc !== before.spotUsdc ? s : false;
      });
      r.numbers.perpBefore = before.perpValue;
      r.numbers.spotBefore = before.spotUsdc;
      r.numbers.perpAfter = after?.perpValue ?? null;
      r.numbers.spotAfter = after?.spotUsdc ?? null;
      if (!after) r.warn('HL returned ok but no balance change within 30s');
    });
  }

  it('usdSend 1 USDC leg0 -> lab wallet #1', () => run('usdSend', () => ({ destination: dest(), amount: '1', time: Date.now() })), 300_000);
  it('usdClassTransfer 1 USDC', () => run('usdClassTransfer', (s) => ({ amount: '1', toPerp: s.spotUsdc >= 1, nonce: Date.now() })), 300_000);
  it('withdraw3 2 USDC to lab wallet #1 (Arbitrum Sepolia)', () => run('withdraw3', () => ({ destination: dest(), amount: '2', time: Date.now() })), 300_000);
});

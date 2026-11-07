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
import { Recorder, runClaim } from '../src/results';

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

// Live: sign on demand with contract-dev's sign-action.mjs (C2_SIGN_DIR = its checkout on ci32), submit, judge by HL's own state.
const live = LIVE && HAS_FUNDER && Boolean(process.env.C2_SIGN_DIR);
const LEG0 = '0xff689f4bf14686c751df87304178eacb3c2194e3' as const;
const LEG1 = '0x6c116aef0a090893af5d80b39602666a9a450328' as const;

describe.skipIf(!live)('C3: HL accepts usdSend / withdraw3 / usdClassTransfer signed by MPC', () => {
  const signDir = process.env.C2_SIGN_DIR!;
  type Snap = Awaited<ReturnType<typeof snapshot>>;

  async function run(
    name: string,
    path: string,
    signer: `0x${string}`,
    args: Record<string, unknown>,
    judge: (r: Recorder, before: { signer: Snap; leg1: Snap }, after: { signer: Snap; leg1: Snap }, ledger: unknown[]) => boolean,
  ) {
    await runClaim(`C3-${name}`, 'C3', `HL accepts ${name} signed by MPC (caller-supplied nonce)`, async (r) => {
      const client = testnetClient();
      const read = async () => ({ signer: await snapshot(client, signer), leg1: await snapshot(client, LEG1) });
      const startMs = Date.now() - 5_000;
      let before = await read();
      if (totalUsdc(before.signer) < 8) {
        r.refs.topUp = await fundFromFunder(signer, '20');
        await waitFor(async () => totalUsdc(await snapshot(client, signer)) > totalUsdc(before.signer));
        before = await read();
      }
      const signed = signFreshAction(signDir, name, path, args);
      r.numbers.signGasTGas = Number(signed.gasTGas);
      r.refs.nearSignTx = signed.signTx;
      r.refs.action = signed.exchangeRequest.action;
      expect((await recoverUserSigned(signed.exchangeRequest.action, signed.exchangeRequest.signature)).toLowerCase()).toBe(signer);
      const res = await submitSignedAction(signed.exchangeRequest.action, signed.exchangeRequest.signature);
      r.refs.exchange = res;
      expect(res.status, JSON.stringify(res)).toBe('ok');
      let ledger: unknown[] = [];
      const after = await waitFor(async () => {
        const a = await read();
        ledger = (await client.userNonFundingLedgerUpdates({ user: signer, startTime: startMs })).map((u) => u.delta);
        return judge(new Recorder(), before, a, ledger) ? a : false;
      });
      const last = after ?? (await read());
      r.numbers.signerPerpBefore = before.signer.perpValue;
      r.numbers.signerSpotBefore = before.signer.spotUsdc;
      r.numbers.signerPerpAfter = last.signer.perpValue;
      r.numbers.signerSpotAfter = last.signer.spotUsdc;
      r.numbers.leg1TotalBefore = totalUsdc(before.leg1);
      r.numbers.leg1TotalAfter = totalUsdc(last.leg1);
      r.refs.ledger = ledger;
      if (!after) r.fail('HL returned ok but the expected balance/ledger change did not appear within 30s');
    });
  }

  it('usdSend 1 USDC leg0 -> leg1: leg1 balance goes up', () =>
    run('usdSend', 'test/leg0', LEG0, { destination: LEG1, amount: '1', time: Date.now() }, (_r, b, a) => totalUsdc(a.leg1) > totalUsdc(b.leg1)), 300_000);

  it('usdClassTransfer 1 USDC perp -> spot on leg0: leg0 spot goes up', () =>
    run('usdClassTransfer', 'test/leg0', LEG0, { amount: '1', toPerp: false, nonce: Date.now() }, (_r, b, a) => a.signer.spotUsdc > b.signer.spotUsdc), 300_000);

  it('withdraw3 2 USDC leg1 -> lab wallet #1: leg1 drops, ledger shows a withdraw', () =>
    run(
      'withdraw3',
      'test/leg1',
      LEG1,
      { destination: funderAddress().toLowerCase(), amount: '2', time: Date.now() },
      (_r, b, a, ledger) => totalUsdc(a.signer) < totalUsdc(b.signer) && ledger.some((d) => (d as { type?: string }).type === 'withdraw'),
    ), 300_000);
});

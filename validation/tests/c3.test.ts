import { describe, expect, it } from 'vitest';
import { HAS_FUNDER, LIVE } from '../src/env';
import {
  fundFromFunder,
  loadSignedActionFile,
  recoverUserSigned,
  snapshot,
  submitSignedAction,
  testnetClient,
  totalUsdc,
  waitFor,
} from '../src/hl';
import { runClaim, writeBlocked } from '../src/results';

// contract-dev produces one file per action, same shape as c2-approve-agent.json.
const FILES = {
  usdSend: 'contract/out/c3-usd-send.json',
  withdraw3: 'contract/out/c3-withdraw3.json',
  usdClassTransfer: 'contract/out/c3-usd-class-transfer.json',
} as const;

const live = LIVE && HAS_FUNDER;

describe('C3 offline: artefacts recover to their derived address', () => {
  for (const [name, path] of Object.entries(FILES)) {
    const f = loadSignedActionFile(path);
    it.skipIf(!f)(name, async () => {
      expect(await recoverUserSigned(f!.action, f!.signature)).toBe(f!.address);
    });
  }
});

describe.skipIf(!live)('C3: HL accepts usdSend / withdraw3 / usdClassTransfer signed by MPC', () => {
  for (const [name, path] of Object.entries(FILES)) {
    it(name, async (ctx) => {
      const f = loadSignedActionFile(path);
      const resultFile = `C3-${name}`;
      const title = `HL accepts ${name} signed by MPC (caller-supplied time nonce)`;
      if (!f) {
        writeBlocked(resultFile, 'C3', title, `${path} not produced yet`);
        ctx.skip();
        return;
      }
      await runClaim(resultFile, 'C3', title, async (r) => {
        const client = testnetClient();
        let before = await snapshot(client, f.address);
        if (totalUsdc(before) === 0) {
          r.refs.fund = await fundFromFunder(f.address, '5');
          await waitFor(async () => totalUsdc(await snapshot(client, f.address)) > 0);
          before = await snapshot(client, f.address);
        }
        const res = await submitSignedAction(f.action, f.signature);
        r.refs.exchange = res;
        r.refs.action = f.action;
        expect(res.status, JSON.stringify(res)).toBe('ok');
        // balances must change (perp, spot or total depending on the action)
        const after = await waitFor(async () => {
          const s = await snapshot(client, f.address);
          return s.perpValue !== before.perpValue || s.spotUsdc !== before.spotUsdc ? s : false;
        });
        r.numbers.perpBefore = before.perpValue;
        r.numbers.spotBefore = before.spotUsdc;
        r.numbers.perpAfter = after?.perpValue ?? null;
        r.numbers.spotAfter = after?.spotUsdc ?? null;
        if (!after) r.warn('HL returned ok but no balance change was seen within 30s');
      });
    });
  }
});

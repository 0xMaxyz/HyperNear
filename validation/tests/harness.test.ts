import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { LIVE } from '../src/env';
import {
  freshKey,
  recoverUserSigned,
  signApproveAgentLocally,
  snapshot,
  testnetClient,
  toRsv,
  userSignedTypedData,
  type UserSignedAction,
} from '../src/hl';

const golden = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../packages/core/tests/fixtures/golden/${name}.json`, import.meta.url)), 'utf8'));

describe('harness: user-signed typed data matches the Python SDK golden vectors (offline)', () => {
  for (const name of ['approveAgent', 'usdSend', 'withdraw3']) {
    it(name, async () => {
      const g = golden(name);
      const account = privateKeyToAccount(g.wallet.privateKey);
      const action = g.input.action as UserSignedAction;
      const td = userSignedTypedData(action);
      expect(td.primaryType).toBe(g.input.primaryType);
      const sig = await account.signTypedData(td);
      const rsv = toRsv(sig);
      expect(rsv.r).toBe(g.output.signature.r);
      expect(rsv.s).toBe(g.output.signature.s);
      expect(rsv.v).toBe(g.output.signature.v);
      expect(await recoverUserSigned(action, rsv)).toBe(account.address);
    });
  }
});

describe('harness self-check: core HlClient approveAgent is recoverable by our own verifier (offline)', () => {
  it('signature recovers to the master and the body has the wire shape /exchange expects', async () => {
    const master = freshKey();
    const agent = freshKey();
    const body = await signApproveAgentLocally(master.key, agent.address, 'hn-selfcheck');
    expect(body.action.type).toBe('approveAgent');
    expect(body.action.signatureChainId).toBe('0x66eee');
    expect(body.action.hyperliquidChain).toBe('Testnet');
    expect(body.nonce).toBe(body.action.nonce);
    expect(await recoverUserSigned(body.action, body.signature)).toBe(master.address);
  });
});

describe.skipIf(!LIVE)('harness live: info reads (no key needed)', () => {
  it('reads an unknown address and the mids on HL testnet', async () => {
    const client = testnetClient();
    const mids = await client.allMids();
    expect(Number(mids.BTC)).toBeGreaterThan(0);
    const s = await snapshot(client, freshKey().address);
    expect(s.perpValue).toBe(0);
    expect(s.agents).toEqual([]);
  });
});

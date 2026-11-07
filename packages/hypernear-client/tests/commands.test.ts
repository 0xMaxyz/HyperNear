import { describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COMMAND_TYPES, commandTypedData, newCommand, ownerIntentTypedData, recoverCommandSigner, ZERO_SPEC_HASH } from '../src';

// well-known PUBLIC web3 test key: never funded
const owner = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const o = owner.address.toLowerCase() as `0x${string}`;
const SPEC = `0x${'ab'.repeat(32)}` as const;

describe('Command typed data', () => {
  it('round-trips: viem signs, recoverCommandSigner returns the owner', async () => {
    const c = newCommand(o, 'openHedge', 'BTC', '0.5', 30, 1_800_000_000_000);
    expect(c).toEqual({ owner: o, action: 'openHedge', coin: 'BTC', ratio: '0.5', expiry: 1_800_000_030, nonce: 1_800_000_000_000, specHash: ZERO_SPEC_HASH });
    const sig = await owner.signTypedData(commandTypedData('near-testnet', 'leash.testnet', c) as never);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', c, sig)).toBe(o);
    // bound to the deployment and to every field
    expect(await recoverCommandSigner('near-mainnet', 'leash.testnet', c, sig)).not.toBe(o);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', { ...c, ratio: '1' }, sig)).not.toBe(o);
  });

  it('specHash is a signed bytes32 field: a startStrategy signature is bound to one spec', async () => {
    expect(COMMAND_TYPES.Command.at(-1)).toEqual({ name: 'specHash', type: 'bytes32' });
    const c = newCommand(o, 'startStrategy', '', '0', 30, 1_800_000_000_000, SPEC);
    const sig = await owner.signTypedData(commandTypedData('near-testnet', 'leash.testnet', c) as never);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', c, sig)).toBe(o);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', { ...c, specHash: ZERO_SPEC_HASH }, sig)).not.toBe(o);
  });

  // pinned digests: other implementations (web, wallets) check their typed data against these
  it.each([
    ['openHedge, zero specHash', newCommand(o, 'openHedge', 'BTC', '0.5', 30, 1_800_000_000_000), '0xac7bae0662415104e5710382aebf433e0f489bf6c7aaaad0bf5506e3bd097cd1'],
    ['startStrategy', newCommand(o, 'startStrategy', '', '0', 30, 1_800_000_000_000, SPEC), '0xa1f3052df11466855a81dde5d0e712b42185031c5f466182100c871165b6b285'],
  ])('vector: %s', (_n, c, digest) => {
    expect(hashTypedData(commandTypedData('near-testnet', 'leash-spike-1107.testnet', c) as never)).toBe(digest);
  });

  it('independent vector: a hand-written typed-data literal (not commandTypedData) gives the pinned startStrategy digest', () => {
    const literal = {
      domain: { name: 'Leash', version: '1', salt: keccak256(toHex('near-testnet:leash-spike-1107.testnet')) },
      types: {
        Command: [
          { name: 'owner', type: 'address' },
          { name: 'action', type: 'string' },
          { name: 'coin', type: 'string' },
          { name: 'ratio', type: 'string' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'specHash', type: 'bytes32' },
        ],
      },
      primaryType: 'Command',
      message: { owner: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23', action: 'startStrategy', coin: '', ratio: '0', expiry: 1_800_000_030n, nonce: 1_800_000_000_000n, specHash: `0x${'ab'.repeat(32)}` },
    } as const;
    const digest = hashTypedData(literal);
    expect(digest).toBe('0xa1f3052df11466855a81dde5d0e712b42185031c5f466182100c871165b6b285');
    expect(hashTypedData(commandTypedData('near-testnet', 'leash-spike-1107.testnet', newCommand(o, 'startStrategy', '', '0', 30, 1_800_000_000_000, SPEC)) as never)).toBe(digest);
  });

  it('never collides with an owner intent digest (separate primary type)', () => {
    const c = newCommand(o, 'closeHedge', 'BTC');
    const cmd = hashTypedData(commandTypedData('near-testnet', 'x.testnet', c) as never);
    const intent = hashTypedData(ownerIntentTypedData({ chainTag: 'near-testnet', contractId: 'x.testnet', owner: o, nonce: c.nonce, intent: { type: 'freeze', frozen: true } }) as never);
    expect(cmd).not.toBe(intent);
  });
});

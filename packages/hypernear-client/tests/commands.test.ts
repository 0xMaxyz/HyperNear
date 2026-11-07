import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, newCommand, ownerIntentTypedData, recoverCommandSigner } from '../src';

// well-known PUBLIC web3 test key: never funded
const owner = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const o = owner.address.toLowerCase() as `0x${string}`;

describe('Command typed data', () => {
  it('round-trips: viem signs, recoverCommandSigner returns the owner', async () => {
    const c = newCommand(o, 'openHedge', 'BTC', '0.5', 30, 1_800_000_000_000);
    expect(c).toEqual({ owner: o, action: 'openHedge', coin: 'BTC', ratio: '0.5', expiry: 1_800_000_030, nonce: 1_800_000_000_000 });
    const sig = await owner.signTypedData(commandTypedData('near-testnet', 'leash.testnet', c) as never);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', c, sig)).toBe(o);
    // bound to the deployment and to every field
    expect(await recoverCommandSigner('near-mainnet', 'leash.testnet', c, sig)).not.toBe(o);
    expect(await recoverCommandSigner('near-testnet', 'leash.testnet', { ...c, ratio: '1' }, sig)).not.toBe(o);
  });

  it('never collides with an owner intent digest (separate primary type)', () => {
    const c = newCommand(o, 'closeHedge', 'BTC');
    const cmd = hashTypedData(commandTypedData('near-testnet', 'x.testnet', c) as never);
    const intent = hashTypedData(ownerIntentTypedData({ chainTag: 'near-testnet', contractId: 'x.testnet', owner: o, nonce: c.nonce, intent: { type: 'freeze', frozen: true } }) as never);
    expect(cmd).not.toBe(intent);
  });
});

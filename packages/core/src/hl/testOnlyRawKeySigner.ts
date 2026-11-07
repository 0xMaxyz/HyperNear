import { privateKeyToAccount } from 'viem/accounts';
import type { TypedDataDefinition } from 'viem';
import type { HlAsyncSigner, HlHex } from './types';

/**
 * TEST-ONLY convenience: builds an in-memory signer from a raw private key.
 * Never use in production code paths — real signers (passkey iframe,
 * apps/api session facade, browser wallet) implement HlAsyncSigner without
 * ever exposing key material, and nothing else in the wrapper accepts a key.
 */
export function testOnlyRawKeySigner(privateKey: HlHex): HlAsyncSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (payload) => account.signTypedData(payload as TypedDataDefinition),
  };
}

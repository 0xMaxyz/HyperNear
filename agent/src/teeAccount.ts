// The TEE agent's NEAR account: an implicit account (hex ed25519 public key) derived from a key that dstack gives only to
// this app (getKey at a fixed path), so the account is the SAME on every boot of the same Phala app and an owner can name
// it in setTee. The quote's report_data is still that public key, zero-padded to 64 bytes (shade-agent-js does that).
// Dev (HYPERNEAR_TEE_DEV=1, no dstack socket): derived from HYPERNEAR_TEE_DEV_SEED instead. Testnet only: anyone who knows the seed owns the account.
import { createHash } from 'node:crypto';
import { PublicKey } from '@near-js/crypto';
import { generateSeedPhrase } from 'near-seed-phrase';

export const NEAR_ACCOUNT_KEY_PATH = 'hypernear/near-account/v1';

export interface TeeAccount {
  /** 64 lowercase hex chars = the ed25519 public key */
  accountId: string;
  /** `ed25519:<base58>`; stays in memory */
  secretKey: string;
}

/** Same hashing-to-seed step as shade-agent-js (sha256 -> generateSeedPhrase), with a domain tag so the key is not reusable elsewhere. */
export function accountFromSeed(material: Uint8Array | string): TeeAccount {
  const bytes = typeof material === 'string' ? Buffer.from(material) : Buffer.from(material);
  const hash = createHash('sha256').update('leash-tee-near-account-v1').update(bytes).digest();
  const s = generateSeedPhrase(hash);
  return { accountId: Buffer.from(PublicKey.from(s.publicKey).data).toString('hex'), secretKey: s.secretKey };
}

export async function teeAccount(o: { dev: boolean; devSeed?: string; dstack?: { getKey(path: string): Promise<{ key: Uint8Array }> } }): Promise<TeeAccount> {
  if (o.dev) {
    if (!o.devSeed) throw new Error('HYPERNEAR_TEE_DEV=1 needs HYPERNEAR_TEE_DEV_SEED (testnet only): the account is derived from it');
    return accountFromSeed(`dev:${o.devSeed}`);
  }
  const dstack = o.dstack ?? new (await import('@phala/dstack-sdk')).DstackClient();
  return accountFromSeed((await dstack.getKey(NEAR_ACCOUNT_KEY_PATH)).key);
}

/**
 * shade-agent-js 2.2.0 (pinned) always makes a random account. We keep its quote + collateral fetching and signing and swap
 * in ours: the account id is what its attestation binds as report_data, its key is what `call` signs with. Fails loudly if a
 * future version moves these fields.
 */
export function pinAccount(shade: { accountId(): string }, a: TeeAccount) {
  const s = shade as unknown as { agentAccountId: string; agentPrivateKeys: string[] };
  s.agentAccountId = a.accountId;
  s.agentPrivateKeys = [a.secretKey];
  if (shade.accountId() !== a.accountId) throw new Error('shade-agent-js layout changed: cannot pin the TEE account (pin @neardefi/shade-agent-js to 2.2.0)');
}

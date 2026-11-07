// @vitest-environment jsdom
//
// [#631] The backup file must cover the key tier that OWNS THE FUNDS.
//
// Master and agent derive from independent PRF salts (ADR 7.5.1 § Tier
// separation), so neither key can be computed from the other. The account logs
// in as the agent, but the balance sits on the master EOA and `withdraw3` is
// master-signed — so a single-tier (agent) backup restores an identity that can
// trade and cannot withdraw. That was the shipped behaviour, and it meant a user
// who did exactly what the product instructed still lost their funds on passkey
// loss.
//
// These tests pin the format that closes it: a `hl-key-backup/v2` bundle with
// one entry per tier, backwards-compatible with the single-export files already
// in users' hands (which must keep importing, and must be reported as NOT
// covering the funds so the UI can say so).
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_EXPORT_KDF,
  KEY_BACKUP_BUNDLE_VERSION,
  KeyBackupParseError,
  bundleKeyBackupFiles,
  createKeyBackupFile,
  parseKeyBackupBundle,
  recoverSignerFromBackup,
  recoverSignersFromBackup,
  serializeKeyBackup,
  type HexAddress,
  type KeyBackupFile,
} from '../../src/index';

const PASSPHRASE = 'correct horse battery staple';

// scrypt at the production cost (32 MiB) × several exports per test is slow and
// buys nothing here — the KDF parameters are exercised by the key-export suite.
const FAST_KDF = { n: 2 ** 8, r: 8, p: 1 };

const MASTER_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as HexAddress;
const AGENT_KEY =
  '0x2222222222222222222222222222222222222222222222222222222222222222' as HexAddress;

const masterAddress = privateKeyToAccount(MASTER_KEY).address;
const agentAddress = privateKeyToAccount(AGENT_KEY).address;

function exportTier(tier: 'master' | 'agent'): Promise<KeyBackupFile> {
  const privateKey = tier === 'master' ? MASTER_KEY : AGENT_KEY;
  return createKeyBackupFile({
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    tier,
    passphrase: PASSPHRASE,
    kdfParams: FAST_KDF,
  });
}

async function bothTiers(): Promise<KeyBackupFile> {
  return bundleKeyBackupFiles([await exportTier('master'), await exportTier('agent')]);
}

describe('[#631] a two-tier backup restores control of the funds', () => {
  it('round-trips both keys through one file and one passphrase', async () => {
    const restored = await recoverSignersFromBackup((await bothTiers()).contents, PASSPHRASE);

    expect(restored.master?.address).toBe(masterAddress);
    expect(restored.agent?.address).toBe(agentAddress);
    expect(restored.master?.privateKey).toBe(MASTER_KEY);
    expect(restored.agent?.privateKey).toBe(AGENT_KEY);
    expect(restored.coversFunds).toBe(true);
  });

  it('treats the master as the backup identity — it is the EOA holding the balance', async () => {
    const file = await bothTiers();

    // The file the user sees is named and labelled for the funds key, not the
    // trading key that happens to be listed second.
    expect(file.address).toBe(masterAddress);
    expect(file.fileName).toContain(masterAddress.slice(2, 10).toLowerCase());

    const restored = await recoverSignersFromBackup(file.contents, PASSPHRASE);
    expect(restored.primary.address).toBe(masterAddress);
    // The single-signer view agrees, so a caller that only shows one address
    // shows the one that matters.
    expect((await recoverSignerFromBackup(file.contents, PASSPHRASE)).address).toBe(
      masterAddress,
    );
  });

  it('writes a versioned bundle carrying one entry per tier', async () => {
    const parsed = JSON.parse((await bothTiers()).contents) as {
      version: string;
      entries: Array<{ tier: string; ciphertext: string }>;
    };

    expect(parsed.version).toBe(KEY_BACKUP_BUNDLE_VERSION);
    expect(parsed.entries.map((e) => e.tier).sort()).toEqual(['agent', 'master']);
    // Each tier is encrypted independently — a shared ciphertext would mean one
    // of them was never really in the file.
    expect(parsed.entries[0].ciphertext).not.toBe(parsed.entries[1].ciphertext);
  });

  it('surfaces the same indistinguishable error on a wrong passphrase', async () => {
    const file = await bothTiers();
    await expect(recoverSignersFromBackup(file.contents, 'not the passphrase')).rejects.toThrow(
      /wrong passphrase or corrupted/,
    );
  });
});

describe('[#631] legacy single-tier backups still import, and are reported as incomplete', () => {
  it('imports a pre-#631 agent-only file and flags that it does not cover the funds', async () => {
    // Exactly what the product used to hand users: a bare v1 export, agent tier.
    const legacy = await exportTier('agent');

    const restored = await recoverSignersFromBackup(legacy.contents, PASSPHRASE);

    expect(restored.agent?.address).toBe(agentAddress);
    expect(restored.master).toBeUndefined();
    expect(restored.primary.address).toBe(agentAddress);
    // The whole point: this user can trade again but cannot withdraw, and the
    // UI must be able to tell them so.
    expect(restored.coversFunds).toBe(false);
  });

  it('parses a bare v1 export as a one-entry bundle', async () => {
    const legacy = await exportTier('agent');
    const entries = parseKeyBackupBundle(legacy.contents);
    expect(entries).toHaveLength(1);
    expect(entries[0].tier).toBe('agent');
  });
});

describe('[#631] malformed bundles are refused rather than silently half-restored', () => {
  it('refuses a bundle carrying two entries for the same tier', async () => {
    const agent = await exportTier('agent');
    expect(() => bundleKeyBackupFiles([agent, agent])).toThrow(KeyBackupParseError);

    const duplicated = JSON.stringify({
      version: KEY_BACKUP_BUNDLE_VERSION,
      entries: [JSON.parse(agent.contents), JSON.parse(agent.contents)],
    });
    // Picking one of two "agent" entries would be a coin flip over which key
    // the user actually gets back.
    expect(() => parseKeyBackupBundle(duplicated)).toThrow(/two "agent" entries/);
  });

  it('refuses an empty bundle', () => {
    expect(() => bundleKeyBackupFiles([])).toThrow(KeyBackupParseError);
    expect(() =>
      parseKeyBackupBundle(JSON.stringify({ version: KEY_BACKUP_BUNDLE_VERSION, entries: [] })),
    ).toThrow(/no entries/);
  });

  it('refuses a bundle whose entry is not a well-formed export', async () => {
    const master = await exportTier('master');
    const tampered = JSON.parse(master.contents) as Record<string, unknown>;
    delete tampered.ciphertext;
    expect(() =>
      parseKeyBackupBundle(
        JSON.stringify({ version: KEY_BACKUP_BUNDLE_VERSION, entries: [tampered] }),
      ),
    ).toThrow(KeyBackupParseError);
  });

  it('still refuses junk uploads on shape alone', () => {
    expect(() => parseKeyBackupBundle('not json')).toThrow(/not valid JSON/);
    expect(() => parseKeyBackupBundle('[]')).toThrow(/not a JSON object/);
  });
});

describe('[#631] bundling is a ciphertext-only operation', () => {
  // This is what lets the host merge the two per-tier exports without widening
  // the hl-signer/v2 contract: nothing here needs, or can reach, key material.
  it('produces a file whose entries are byte-identical to the per-tier exports', async () => {
    const master = await exportTier('master');
    const agent = await exportTier('agent');
    const bundled = bundleKeyBackupFiles([master, agent]);

    const entries = parseKeyBackupBundle(bundled.contents);
    expect(serializeKeyBackup(entries[0])).toBe(master.contents);
    expect(serializeKeyBackup(entries[1])).toBe(agent.contents);
  });

  it('carries no plaintext key material in the file', async () => {
    const contents = (await bothTiers()).contents;
    expect(contents).not.toContain(MASTER_KEY.slice(2));
    expect(contents).not.toContain(AGENT_KEY.slice(2));
  });
});

describe('[#631] the production KDF default is unchanged', () => {
  it('still defaults to the audited scrypt cost', () => {
    expect(DEFAULT_EXPORT_KDF).toEqual({ n: 2 ** 15, r: 8, p: 1 });
  });
});

/**
 * Shared golden-fixture loader for the Epic 0.1 signing-verification harness.
 *
 * This is the "harness shape for ongoing use" decided in Epic 0.1.4: fixtures
 * are JSON files keyed by action type, listed in index.json, and read through
 * this one module rather than re-implemented per test file. Phase 1's Epics
 * 1.2/1.3 extend coverage to new endpoints by adding a fixture + index entry
 * here — see docs/roadmap/spikes/0.1.4-harness-shape-adr.md for the full
 * extension pattern.
 *
 * No network-capable import belongs in this file: it only reads JSON already
 * committed under packages/core/tests/fixtures/golden/, which is what keeps
 * `pnpm test:phase 0` safe to run in CI without live Hyperliquid access.
 */
import fs from 'node:fs';
import path from 'node:path';

export type SigningScheme = 'sign_l1_action' | 'sign_user_signed_action';

export interface SignatureWire {
  r: string;
  s: string;
  v: number;
}

export interface GoldenFixture {
  actionType: string;
  signingScheme: SigningScheme;
  input: Record<string, unknown>;
  wallet: { address: string; privateKey: string };
  output: {
    msgpack: string;
    actionHash: string;
    signature: SignatureWire;
  };
  metadata: {
    sdkName: string;
    sdkVersion: string;
    generatedBy: string;
    notes: string;
  };
}

export interface FixtureIndexEntry {
  file: string;
  signingScheme: SigningScheme;
}

export type FixtureIndex = Record<string, FixtureIndexEntry>;

const GOLDEN_DIR = __dirname;

export function loadFixtureIndex(): FixtureIndex {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'index.json'), 'utf-8'));
}

/** All action types the harness currently has fixtures for, e.g. ['order', 'usdSend']. */
export function listFixtureActionTypes(): string[] {
  return Object.keys(loadFixtureIndex());
}

export function loadGoldenFixture(actionType: string): GoldenFixture {
  const index = loadFixtureIndex();
  const entry = index[actionType];
  if (!entry) {
    throw new Error(
      `No golden fixture indexed for action type "${actionType}". ` +
        `Known types: ${Object.keys(index).join(', ') || '(none)'}. ` +
        `Add a fixture file + index.json entry — see docs/roadmap/spikes/0.1.4-harness-shape-adr.md.`,
    );
  }
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, entry.file), 'utf-8'));
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
}

/**
 * Structural schema every golden fixture must satisfy, independent of its
 * signing scheme. Scheme-specific assertions (e.g. usdSend's msgpack-not-in-
 * preimage note) stay in the test file that owns that action type.
 */
export function assertFixtureSchema(fixture: GoldenFixture): void {
  if (!fixture.actionType) throw new Error('Fixture missing actionType');
  if (fixture.signingScheme !== 'sign_l1_action' && fixture.signingScheme !== 'sign_user_signed_action') {
    throw new Error(`Fixture "${fixture.actionType}" has unknown signingScheme: ${fixture.signingScheme}`);
  }
  if (typeof fixture.input !== 'object' || !fixture.input.action) {
    throw new Error(`Fixture "${fixture.actionType}" missing input.action`);
  }
  if (!isHex(fixture.wallet.address) || fixture.wallet.address.length !== 42) {
    throw new Error(`Fixture "${fixture.actionType}" has malformed wallet.address`);
  }
  if (!isHex(fixture.wallet.privateKey) || fixture.wallet.privateKey.length !== 66) {
    throw new Error(`Fixture "${fixture.actionType}" has malformed wallet.privateKey`);
  }
  if (typeof fixture.output.msgpack !== 'string' || !/^[0-9a-f]*$/i.test(fixture.output.msgpack)) {
    throw new Error(`Fixture "${fixture.actionType}" has malformed output.msgpack`);
  }
  if (!isHex(fixture.output.actionHash)) {
    throw new Error(`Fixture "${fixture.actionType}" has malformed output.actionHash`);
  }
  if (!isHex(fixture.output.signature.r) || !isHex(fixture.output.signature.s)) {
    throw new Error(`Fixture "${fixture.actionType}" has malformed output.signature`);
  }
  if (fixture.output.signature.v !== 27 && fixture.output.signature.v !== 28) {
    throw new Error(`Fixture "${fixture.actionType}" has invalid signature.v: ${fixture.output.signature.v}`);
  }
  if (!fixture.metadata.sdkName || !fixture.metadata.sdkVersion) {
    throw new Error(`Fixture "${fixture.actionType}" missing metadata.sdkName/sdkVersion`);
  }
}

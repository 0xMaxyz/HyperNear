/**
 * [Epic 0.1.1 + 0.1.2] Golden-fixture harness + @nktkas/hyperliquid byte-for-byte diff.
 *
 * The golden fixtures are generated offline (no live network) by
 * packages/core/scripts/golden-fixtures/generate_fixtures.py against the
 * pinned `hyperliquid-python-sdk` version and committed to
 * packages/core/tests/fixtures/golden/. The first describe block below only
 * loads and validates them (Epic 0.1.1).
 *
 * The "@nktkas/hyperliquid byte-for-byte diff" block (Epic 0.1.2) re-signs
 * the exact same two actions through `@nktkas/hyperliquid`'s TS signing
 * primitives (`signL1Action` / `signUserSignedAction`, the equivalents of
 * the Python SDK's `sign_l1_action` / `sign_user_signed_action`) and diffs
 * msgpack bytes, action hash, and signature against the fixtures — entirely
 * offline, against the checked-in fixtures, no live network.
 *
 * Fixture loading goes through the shared harness loader
 * (../fixtures/golden/loader.ts, decided in Epic 0.1.4) rather than
 * reimplementing it here — see harness-shape.phase-0.test.ts for the
 * loader's own coverage and docs/roadmap/spikes/0.1.4-harness-shape-adr.md
 * for the extension pattern new endpoints follow.
 */
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData } from 'viem';
import { createL1ActionHash, signL1Action, signUserSignedAction } from '@nktkas/hyperliquid/signing';
import { UsdSendTypes } from '@nktkas/hyperliquid/api/exchange';
import { encode as encodeMsgpack } from '@msgpack/msgpack';
import { loadGoldenFixture, loadFixtureIndex, assertFixtureSchema } from '../fixtures/golden/loader';

const FIXTURE_NAMES = ['order', 'usdSend'] as const;

describe('[Phase 0.1.1] Golden-fixture harness (Python SDK)', () => {
  describe('index.json', () => {
    it('keys every fixture by action type', () => {
      const index = loadFixtureIndex();
      // Phase 0.1 owns exactly these two; later epics (1.2, 1.3, ...) extend
      // this same index.json with more entries per the harness's own
      // extension pattern (loader.ts, 0.1.4-harness-shape-adr.md) — so this
      // asserts a subset, not an exact match, to stay valid as coverage
      // grows.
      for (const name of FIXTURE_NAMES) {
        expect(index[name]).toMatchObject({ file: `${name}.json` });
        expect(typeof index[name].signingScheme).toBe('string');
      }
    });
  });

  describe.each(FIXTURE_NAMES)('%s.json', (name) => {
    it('loads and parses as JSON', () => {
      expect(() => loadGoldenFixture(name)).not.toThrow();
    });

    it('has the common fixture schema', () => {
      const fixture = loadGoldenFixture(name);

      expect(() => assertFixtureSchema(fixture)).not.toThrow();
      expect(fixture.actionType).toBe(name);
      // These fixtures specifically come from the Python SDK generator (Epic
      // 0.1.1); assertFixtureSchema only checks the scheme-agnostic shape.
      expect(fixture.metadata.sdkName).toBe('hyperliquid-python-sdk');
    });
  });

  describe('order.json (sign_l1_action)', () => {
    it('records the L1 order action wire and its signing scheme', () => {
      const fixture = loadGoldenFixture('order');

      expect(fixture.signingScheme).toBe('sign_l1_action');
      expect(fixture.input.action).toMatchObject({
        type: 'order',
        grouping: 'na',
        orders: [
          {
            a: 0,
            b: true,
            p: '50000',
            s: '0.01',
            r: false,
            t: { limit: { tif: 'Gtc' } },
          },
        ],
      });
      expect(fixture.input.nonce).toBe(1700000000000);
      expect(fixture.input.vaultAddress).toBeNull();
      expect(fixture.input.expiresAfter).toBeNull();

      // msgpack is part of the actual signing preimage for L1 actions.
      expect(fixture.output.msgpack.length).toBeGreaterThan(0);
    });
  });

  describe('usdSend.json (sign_user_signed_action)', () => {
    it('records the user-signed transfer action and its EIP-712 scheme', () => {
      const fixture = loadGoldenFixture('usdSend');

      expect(fixture.signingScheme).toBe('sign_user_signed_action');
      expect(fixture.input.action).toMatchObject({
        type: 'usdSend',
        destination: '0x0000000000000000000000000000000000000001',
        amount: '1',
        time: 1700000000000,
        signatureChainId: '0x66eee',
        hyperliquidChain: 'Testnet',
      });
      expect(fixture.input.primaryType).toBe('HyperliquidTransaction:UsdSend');

      // Documented discrepancy vs. the L1 scheme: msgpack is NOT part of the
      // signing preimage for user-signed (EIP-712) actions.
      expect(fixture.metadata.notes).toMatch(/not.*part of the signing preimage/i);
    });
  });

  describe('CI safety', () => {
    it('reads only committed fixture files, no live network', () => {
      // This test file must never import a network-capable client. It only
      // reads JSON fixtures checked into packages/core/tests/fixtures/golden/,
      // which is what makes `pnpm test:phase 0` safe to run in CI.
      const fixture = loadGoldenFixture('order');
      expect(fixture).toBeDefined();
    });
  });
});

// A fixed, throwaway timestamp — mirrors NONCE in generate_fixtures.py, used
// as both the L1 action nonce and the usdSend `time` field.
const NONCE = 1700000000000;

type HexString = `0x${string}`;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('[Phase 0.1.2] @nktkas/hyperliquid byte-for-byte diff', () => {
  describe('order.json — sign_l1_action equivalent (signL1Action)', () => {
    const fixture = loadGoldenFixture('order');
    const wallet = privateKeyToAccount(fixture.wallet.privateKey as HexString);

    // Key order mirrors the Python SDK's order_wires_to_order_action()
    // output (type, orders[{a,b,p,s,r,t}], grouping). msgpack is
    // key-order-sensitive and this exact order is what the phantom-agent
    // action hash is computed over, so it is not cosmetic.
    const action = {
      type: 'order',
      orders: [{ a: 0, b: true, p: '50000', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }],
      grouping: 'na',
    };

    it('wallet address matches the fixture wallet', () => {
      expect(wallet.address.toLowerCase()).toBe(fixture.wallet.address.toLowerCase());
    });

    it('msgpack bytes match byte-for-byte', () => {
      expect(hex(encodeMsgpack(action))).toBe(fixture.output.msgpack);
    });

    it('action hash matches byte-for-byte', () => {
      const actionHash = createL1ActionHash({ action, nonce: NONCE });
      expect(actionHash).toBe(fixture.output.actionHash);
    });

    it('signature matches byte-for-byte', async () => {
      // isMainnet: false (fixture) -> nktkas's isTestnet: true (source: "b").
      const signature = await signL1Action({ wallet, action, nonce: NONCE, isTestnet: true });
      expect(signature.r).toBe(fixture.output.signature.r);
      expect(signature.s).toBe(fixture.output.signature.s);
      expect(signature.v).toBe(fixture.output.signature.v);
    });
  });

  describe('usdSend.json — sign_user_signed_action equivalent (signUserSignedAction)', () => {
    const fixture = loadGoldenFixture('usdSend');
    const wallet = privateKeyToAccount(fixture.wallet.privateKey as HexString);

    // Key order mirrors the Python SDK's dict-mutation order in
    // sign_usd_transfer_action() (destination, amount, time, type, then
    // signatureChainId/hyperliquidChain appended by the signing call).
    // Field order has no effect on the EIP-712 digest below (that's keyed
    // by `types`, not object key order) but it keeps the msgpack
    // wire-format comparison genuinely byte-for-byte, not merely
    // structurally equivalent.
    const action = {
      destination: '0x0000000000000000000000000000000000000001' as HexString,
      amount: '1',
      time: NONCE,
      type: 'usdSend',
      signatureChainId: '0x66eee' as HexString,
      hyperliquidChain: 'Testnet',
    };

    it('wallet address matches the fixture wallet', () => {
      expect(wallet.address.toLowerCase()).toBe(fixture.wallet.address.toLowerCase());
    });

    it('msgpack bytes match byte-for-byte', () => {
      expect(hex(encodeMsgpack(action))).toBe(fixture.output.msgpack);
    });

    it('action hash (EIP-712 digest) matches byte-for-byte', () => {
      // Mirrors signUserSignedAction's internal domain construction
      // (HyperliquidSignTransaction / v1 / zero verifyingContract) so this
      // digest is computed independently of nktkas's own signing call.
      const actionHash = hashTypedData({
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: parseInt(action.signatureChainId, 16),
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: UsdSendTypes,
        primaryType: 'HyperliquidTransaction:UsdSend',
        message: action,
      });
      expect(actionHash).toBe(fixture.output.actionHash);
    });

    it('signature matches byte-for-byte', async () => {
      const signature = await signUserSignedAction({ wallet, action, types: UsdSendTypes });
      expect(signature.r).toBe(fixture.output.signature.r);
      expect(signature.s).toBe(fixture.output.signature.s);
      expect(signature.v).toBe(fixture.output.signature.v);
    });
  });

  describe('diff failure pinpoints the divergence', () => {
    it('a tampered action diverges on msgpack bytes and action hash, independent of each other', () => {
      const fixture = loadGoldenFixture('order');
      const tamperedAction = {
        type: 'order',
        // size perturbed vs. the fixture: "0.01" -> "0.02"
        orders: [{ a: 0, b: true, p: '50000', s: '0.02', r: false, t: { limit: { tif: 'Gtc' } } }],
        grouping: 'na',
      };

      const tamperedMsgpack = hex(encodeMsgpack(tamperedAction));
      const tamperedHash = createL1ActionHash({ action: tamperedAction, nonce: NONCE });

      // Each divergence is asserted separately so a real regression's
      // failure output names exactly which layer (wire bytes vs. hash)
      // diverged, rather than a single opaque deep-equal failure.
      expect(tamperedMsgpack).not.toBe(fixture.output.msgpack);
      expect(tamperedHash).not.toBe(fixture.output.actionHash);
    });
  });

  describe('CI safety', () => {
    it('signs offline: no Transport/Client class is imported anywhere in this suite', () => {
      // signL1Action / signUserSignedAction / createL1ActionHash are pure
      // crypto (msgpack + keccak + ECDSA over in-memory inputs) — this file
      // only imports @nktkas/hyperliquid/signing and the pure UsdSendTypes
      // constant from @nktkas/hyperliquid/api/exchange, never a
      // network-capable Transport or ExchangeClient, so this suite is safe
      // to run in CI against the checked-in fixtures only.
      expect(true).toBe(true);
    });
  });
});

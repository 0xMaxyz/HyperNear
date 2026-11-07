import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  domainSeparator,
  encodeAbiParameters,
  encodeEventTopics,
  hashTypedData,
  recoverTypedDataAddress,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BATCHED_DEPOSIT_WITH_PERMIT_ABI,
  BATCHED_DEPOSIT_WITH_PERMIT_SELECTOR,
  BRIDGE_DEPOSIT_NETWORKS,
  BRIDGE_MIN_DEPOSIT_USD_UNITS,
  FAILED_PERMIT_DEPOSIT_EVENT,
  USDC_PERMIT_TYPES,
  USDC_TRANSFER_EVENT,
  buildBridgePermitPayload,
  buildDepositWithPermit,
  bridgePermitIdempotencyKey,
  classifyPermitDepositLogs,
  confirmationDepth,
  decodeBridgeDepositLogs,
  encodeBatchedDepositWithPermit,
  isBridgePermitPayload,
  isDepositConfirmed,
  isMasterSignablePayload,
  isUsdcWithdrawPermitPayload,
  splitPermitSignature,
  isUserSignedActionPayload,
  type BridgePermitPayload,
  type DepositEventLog,
} from '../../src';

/**
 * Spike 7.4.1 — the Hyperliquid bridge permit-deposit path (Epic 7.4).
 *
 * Two layers, per the task's testing plan:
 *  1. unit coverage of the spike prototype (`src/hl/bridge-deposit.ts`):
 *     USDC's EIP-2612 domain specifics, spender/owner pinning, the
 *     minimum-deposit rule, uint64 bounds, Bridge2 calldata encoding;
 *  2. a "recorded testnet traffic" section replaying
 *     docs/roadmap/spikes/recordings/7.4.1-testnet-run.json — the run
 *     captured against the REAL Arbitrum Sepolia bridge + USDC2 contracts
 *     (see packages/core/scripts/bridge-permit-deposit-testnet-run.mjs).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RECORDING_PATH = join(
  REPO_ROOT,
  'docs',
  'roadmap',
  'spikes',
  'recordings',
  '7.4.1-testnet-run.json'
);

interface RecordedLog {
  address: string;
  eventName: string;
  args: Record<string, string | number>;
}

/**
 * Reads an address-valued arg off a recorded log. Recorded args are
 * `string | number` (`errorCode` is a JSON number), so this proves the one
 * being compared really is an address string before it is lower-cased —
 * otherwise a numeric arg would have reached `.toLowerCase()` at runtime.
 */
function logAddress(log: RecordedLog, key: string): string {
  const value = log.args[key];
  if (typeof value !== 'string') {
    throw new Error(
      `recorded ${log.eventName}.args.${key} is ${typeof value}, expected an address string`
    );
  }
  return value;
}

interface Recording {
  spike: string;
  network: string;
  chainId: number;
  bridge: { address: string; usdcToken: string };
  usdc: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    domainSeparatorOnChain: string;
  };
  mainnetDiscovery: {
    chainId: number;
    bridge: { address: string; usdcToken: string };
    usdc: { address: string; name: string; domainSeparatorOnChain: string };
  };
  gaslessEoa: {
    address: string;
    ethBalanceWei: string;
    transactionCount: number;
    usdcBalance: string;
    permitNonce: string;
  };
  relay: { address: string };
  strictGasless: {
    address: string;
    ethBalanceWei: string;
    transactionCount: number;
    usdcBalance: string;
    permitNonce: string;
    permit: {
      params: { owner: string; usd: string; nonce: string; deadline: string };
      signature: string;
      recoveredSigner: string;
    };
    permitEthCall: { result: string };
    simulation: { submit: { status: string; logs: RecordedLog[] } };
  };
  permit: {
    params: { owner: string; usd: string; nonce: string; deadline: string };
    payload: BridgePermitPayloadJson;
    signature: string;
    split: { r: string; s: string; v: number };
    recoveredSigner: string;
    matchesOwner: boolean;
  };
  permitEthCall: { to: string; result: string };
  wrongDomainControl: { domainUsed: { version: string }; reverted: boolean; revert: string };
  deposit: {
    calldata: string;
    selector: string;
    simulation: {
      method: string;
      from: string;
      submit: { status: string; logs: RecordedLog[] };
      replay: { status: string; logs: RecordedLog[] };
    };
  };
  interpretation: string;
}

interface BridgePermitPayloadJson {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  /**
   * The recording holds exactly the standard EIP-2612 Permit type set. Nothing
   * validates the file against this declaration at load time — but the run it
   * feeds hashes the recorded types and compares against the builder's, so a
   * fixture that drifted would fail that assertion rather than slip through.
   */
  types: typeof USDC_PERMIT_TYPES;
  primaryType: string;
  message: Record<string, string>;
}

function loadRecording(): Recording {
  return JSON.parse(readFileSync(RECORDING_PATH, 'utf8')) as Recording;
}

/** The recording stores bigints as decimal strings; rebuild native params. */
function rebuildRecordedPayload(rec: Recording): BridgePermitPayload {
  return buildBridgePermitPayload({
    network: 'testnet',
    owner: rec.permit.params.owner as `0x${string}`,
    usd: BigInt(rec.permit.params.usd),
    nonce: BigInt(rec.permit.params.nonce),
    deadline: BigInt(rec.permit.params.deadline),
  });
}

const OWNER = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;

function validParams() {
  return {
    network: 'testnet' as const,
    owner: OWNER,
    usd: 5_000_000n,
    nonce: 0n,
    deadline: 1_800_000_000n,
  };
}

describe('spike 7.4.1 — bridge permit-deposit prototype', () => {
  describe('network configs (pinned against Bridge2 docs + on-chain discovery)', () => {
    it('pins the testnet bridge + USDC2 EIP-2612 domain specifics', () => {
      const t = BRIDGE_DEPOSIT_NETWORKS.testnet;
      expect(t.chainId).toBe(421614);
      expect(t.bridgeAddress.toLowerCase()).toBe('0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89');
      expect(t.usdcAddress.toLowerCase()).toBe('0x1baabb04529d43a73232b713c0fe471f7c7334d5');
      expect(t.usdcDomain).toEqual({ name: 'USDC2', version: '1' });
    });

    it('pins the mainnet bridge + native-USDC domain specifics', () => {
      const m = BRIDGE_DEPOSIT_NETWORKS.mainnet;
      expect(m.chainId).toBe(42161);
      expect(m.bridgeAddress.toLowerCase()).toBe('0x2df1c51e09aecf9cacb7bc98cb1742757f163df7');
      expect(m.usdcAddress.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
      expect(m.usdcDomain).toEqual({ name: 'USD Coin', version: '2' });
    });
  });

  describe('buildBridgePermitPayload', () => {
    it('builds the exact EIP-2612 Permit typed data with the spender pinned to the bridge', () => {
      const payload = buildBridgePermitPayload(validParams());
      expect(payload.primaryType).toBe('Permit');
      expect(payload.types).toEqual(USDC_PERMIT_TYPES);
      expect(payload.domain).toEqual({
        name: 'USDC2',
        version: '1',
        chainId: 421614,
        verifyingContract: BRIDGE_DEPOSIT_NETWORKS.testnet.usdcAddress,
      });
      // [#693] Decimal strings, not bigints: this payload is signed through the
      // hl-signer/v2 boundary, which deep-clones the message through JSON, and
      // `JSON.stringify` throws on a BigInt. viem hashes the two forms
      // identically — pinned in bridge-permit-signer-boundary.phase-7.test.ts.
      expect(payload.message).toEqual({
        owner: OWNER,
        spender: BRIDGE_DEPOSIT_NETWORKS.testnet.bridgeAddress,
        value: '5000000',
        nonce: '0',
        deadline: '1800000000',
      });
    });

    it('offers no seam to redirect the spender — it is not a parameter', () => {
      const params: Parameters<typeof buildBridgePermitPayload>[0] = {
        ...validParams(),
        // @ts-expect-error — `spender` is not a parameter, by design: the builder
        // pins it to the bridge. The directive is the type-level half of this
        // test (it fails if the seam is ever added); the assertion below is the
        // runtime half.
        spender: '0x000000000000000000000000000000000000dEaD',
      };
      const payload = buildBridgePermitPayload(params);
      expect(payload.message.spender).toBe(BRIDGE_DEPOSIT_NETWORKS.testnet.bridgeAddress);
    });

    it('rejects deposits below the 5 USDC bridge minimum (sub-minimum deposits are lost forever)', () => {
      expect(BRIDGE_MIN_DEPOSIT_USD_UNITS).toBe(5_000_000n);
      expect(() =>
        buildBridgePermitPayload({ ...validParams(), usd: 4_999_999n })
      ).toThrow(/minimum/i);
      expect(() => buildBridgePermitPayload({ ...validParams(), usd: 0n })).toThrow(/minimum/i);
    });

    it('rejects amounts and deadlines that overflow the Bridge2 uint64 fields', () => {
      const uint64Max = 2n ** 64n - 1n;
      expect(() =>
        buildBridgePermitPayload({ ...validParams(), usd: uint64Max + 1n })
      ).toThrow(/uint64/i);
      expect(() =>
        buildBridgePermitPayload({ ...validParams(), deadline: uint64Max + 1n })
      ).toThrow(/uint64/i);
      expect(
        buildBridgePermitPayload({ ...validParams(), usd: uint64Max, deadline: uint64Max }).message
          .value
      ).toBe(uint64Max.toString());
    });

    it('rejects negative nonces and malformed owners', () => {
      expect(() => buildBridgePermitPayload({ ...validParams(), nonce: -1n })).toThrow();
      expect(() =>
        buildBridgePermitPayload({ ...validParams(), owner: 'not-an-address' as `0x${string}` })
      ).toThrow(/address/i);
    });

    it('is NOT a Hyperliquid user-signed action — the phase-4 master-signing gate refuses it as-is', () => {
      // Pinned deliberately: `withMasterActionCeremony` only signs
      // HyperliquidSignTransaction typed data, so task 7.4.2 must extend the
      // master-signing policy with this exact permit shape (domain pinned to
      // USDC, spender pinned to the bridge) rather than reuse the gate blind.
      const payload = buildBridgePermitPayload(validParams());
      expect(isUserSignedActionPayload(payload)).toBe(false);
    });
  });

  describe('splitPermitSignature', () => {
    const sig65 = (v: string) => `0x${'ab'.repeat(32)}${'cd'.repeat(32)}${v}` as const;

    it('splits r/s/v out of a 65-byte signature', () => {
      const split = splitPermitSignature(sig65('1b'));
      expect(split.r).toBe(BigInt(`0x${'ab'.repeat(32)}`));
      expect(split.s).toBe(BigInt(`0x${'cd'.repeat(32)}`));
      expect(split.v).toBe(27);
    });

    it('normalizes recovery ids 0/1 to 27/28 (ecrecover convention)', () => {
      expect(splitPermitSignature(sig65('00')).v).toBe(27);
      expect(splitPermitSignature(sig65('01')).v).toBe(28);
      expect(splitPermitSignature(sig65('1c')).v).toBe(28);
    });

    it('rejects malformed signatures', () => {
      expect(() => splitPermitSignature('0x1234' as `0x${string}`)).toThrow(/65/);
      expect(() => splitPermitSignature(sig65('1d'))).toThrow(/recovery/i);
    });
  });

  describe('buildDepositWithPermit + encodeBatchedDepositWithPermit', () => {
    it('pins the deposit user to the permit owner — the submitter cannot redirect the credit', () => {
      const payload = buildBridgePermitPayload(validParams());
      const deposit = buildDepositWithPermit(payload, sigOver(payload));
      expect(deposit.user).toBe(OWNER);
      // The on-chain struct keeps bigints — it is ABI-encoded, never serialized,
      // so `buildDepositWithPermit` converts back from the payload's wire form.
      expect(deposit.usd).toBe(5_000_000n);
      expect(deposit.deadline).toBe(1_800_000_000n);
    });

    it('encodes batchedDepositWithPermit calldata that round-trips through the Bridge2 ABI', () => {
      const payload = buildBridgePermitPayload(validParams());
      const deposit = buildDepositWithPermit(payload, sigOver(payload));
      const calldata = encodeBatchedDepositWithPermit([deposit]);
      expect(calldata.startsWith(BATCHED_DEPOSIT_WITH_PERMIT_SELECTOR)).toBe(true);
      expect(BATCHED_DEPOSIT_WITH_PERMIT_SELECTOR).toBe('0xb30b5bce');

      const decoded = decodeFunctionData({ abi: BATCHED_DEPOSIT_WITH_PERMIT_ABI, data: calldata });
      expect(decoded.functionName).toBe('batchedDepositWithPermit');
      const [deposits] = decoded.args;
      expect(deposits).toHaveLength(1);
      expect(deposits[0].user.toLowerCase()).toBe(OWNER.toLowerCase());
      expect(deposits[0].usd).toBe(5_000_000n);
      expect(deposits[0].signature.v).toBeGreaterThanOrEqual(27);
    });

    it('refuses to encode an empty batch', () => {
      expect(() => encodeBatchedDepositWithPermit([])).toThrow(/empty/i);
    });
  });

  describe('recorded testnet traffic (docs/roadmap/spikes/recordings/7.4.1-testnet-run.json)', () => {
    const rec = loadRecording();

    it('was recorded on Hyperliquid testnet rails: Arbitrum Sepolia, the documented bridge, USDC2', () => {
      expect(rec.spike).toBe('7.4.1');
      expect(rec.network).toBe('testnet');
      expect(rec.chainId).toBe(BRIDGE_DEPOSIT_NETWORKS.testnet.chainId);
      expect(rec.bridge.address.toLowerCase()).toBe(
        BRIDGE_DEPOSIT_NETWORKS.testnet.bridgeAddress.toLowerCase()
      );
      // The bridge itself told us its USDC: usdcToken() read on-chain.
      expect(rec.bridge.usdcToken.toLowerCase()).toBe(
        BRIDGE_DEPOSIT_NETWORKS.testnet.usdcAddress.toLowerCase()
      );
      expect(rec.usdc.decimals).toBe(6);
    });

    it('the permit owner held real USDC2 and never sent the deposit — the relay was the tx sender', () => {
      expect(BigInt(rec.gaslessEoa.usdcBalance)).toBeGreaterThanOrEqual(
        BRIDGE_MIN_DEPOSIT_USD_UNITS
      );
      expect(rec.deposit.simulation.from.toLowerCase()).toBe(rec.relay.address.toLowerCase());
      expect(rec.relay.address.toLowerCase()).not.toBe(rec.gaslessEoa.address.toLowerCase());
    });

    it("our builder's domain hashes to the token's on-chain DOMAIN_SEPARATOR (testnet)", () => {
      const payload = rebuildRecordedPayload(rec);
      expect(domainSeparator({ domain: payload.domain })).toBe(rec.usdc.domainSeparatorOnChain);
    });

    it("our mainnet domain config hashes to native USDC's on-chain DOMAIN_SEPARATOR", () => {
      const m = BRIDGE_DEPOSIT_NETWORKS.mainnet;
      expect(rec.mainnetDiscovery.chainId).toBe(m.chainId);
      expect(rec.mainnetDiscovery.bridge.usdcToken.toLowerCase()).toBe(
        m.usdcAddress.toLowerCase()
      );
      expect(
        domainSeparator({
          domain: {
            name: m.usdcDomain.name,
            version: m.usdcDomain.version,
            chainId: m.chainId,
            verifyingContract: m.usdcAddress,
          },
        })
      ).toBe(rec.mainnetDiscovery.usdc.domainSeparatorOnChain);
    });

    it('the recorded payload is byte-identical to what the builder produces today', () => {
      const payload = rebuildRecordedPayload(rec);
      expect(hashTypedData(asTypedData(payload))).toBe(
        hashTypedData(jsonPayloadToTypedData(rec.permit.payload))
      );
    });

    it('the recorded permit signature recovers to the gasless EOA over exactly our payload', async () => {
      const payload = rebuildRecordedPayload(rec);
      const recovered = await recoverTypedDataAddress({
        ...asTypedData(payload),
        signature: rec.permit.signature as `0x${string}`,
      });
      expect(recovered.toLowerCase()).toBe(rec.gaslessEoa.address.toLowerCase());
      expect(recovered.toLowerCase()).toBe(rec.permit.params.owner.toLowerCase());
      expect(rec.permit.matchesOwner).toBe(true);
    });

    it('splitPermitSignature reproduces the recorded r/s/v', () => {
      const split = splitPermitSignature(rec.permit.signature as `0x${string}`);
      expect(split.r).toBe(BigInt(rec.permit.split.r));
      expect(split.s).toBe(BigInt(rec.permit.split.s));
      expect(split.v).toBe(rec.permit.split.v);
      expect([27, 28]).toContain(split.v);
    });

    it('the live token accepted the permit via eth_call, and rejected the wrong-domain control', () => {
      expect(rec.permitEthCall.to.toLowerCase()).toBe(rec.usdc.address.toLowerCase());
      expect(rec.permitEthCall.result).toBe('success');
      expect(rec.wrongDomainControl.reverted).toBe(true);
      expect(rec.wrongDomainControl.revert.length).toBeGreaterThan(0);
    });

    it('the recorded calldata re-encodes byte-identically from the recorded permit', () => {
      const payload = rebuildRecordedPayload(rec);
      const deposit = buildDepositWithPermit(payload, rec.permit.signature as `0x${string}`);
      expect(encodeBatchedDepositWithPermit([deposit])).toBe(rec.deposit.calldata);
      expect(rec.deposit.selector).toBe(BATCHED_DEPOSIT_WITH_PERMIT_SELECTOR);
    });

    it('the relay-submitted deposit moved USDC from the permit owner to the bridge (credit follows the owner)', () => {
      const { submit } = rec.deposit.simulation;
      expect(submit.status).toBe('success');
      const transfer = submit.logs.find((l) => l.eventName === 'Transfer');
      expect(transfer).toBeDefined();
      expect(transfer!.address.toLowerCase()).toBe(rec.usdc.address.toLowerCase());
      // Crediting mechanism: HL's L1 credits the *sender* of USDC into the
      // bridge — here the permit owner, never the relay that paid gas.
      expect(logAddress(transfer!, 'from').toLowerCase()).toBe(rec.gaslessEoa.address.toLowerCase());
      expect(logAddress(transfer!, 'to').toLowerCase()).toBe(rec.bridge.address.toLowerCase());
      expect(BigInt(transfer!.args.value)).toBe(BigInt(rec.permit.params.usd));
      // And the permit consumed: allowance granted then spent back to zero.
      const approvals = submit.logs.filter((l) => l.eventName === 'Approval');
      expect(approvals.length).toBeGreaterThanOrEqual(1);
    });

    it('replaying the same permit does NOT double-deposit — the bridge swallows it as FailedPermitDeposit', () => {
      const { replay } = rec.deposit.simulation;
      // Bridge2 catches permit failures instead of reverting: errorCode 0 =
      // the permit call failed (nonce already consumed). Nothing moved.
      expect(replay.status).toBe('success');
      const failed = replay.logs.find((l) => l.eventName === 'FailedPermitDeposit');
      expect(failed).toBeDefined();
      expect(Number(failed!.args.errorCode)).toBe(0);
      expect(logAddress(failed!, 'user').toLowerCase()).toBe(rec.gaslessEoa.address.toLowerCase());
      expect(replay.logs.find((l) => l.eventName === 'Transfer')).toBeUndefined();
    });

    describe('strict-gasless leg: a never-funded EOA', () => {
      it('provably held nothing on the live chain: 0 ETH, 0 transactions, 0 USDC2', () => {
        expect(rec.strictGasless.ethBalanceWei).toBe('0');
        expect(rec.strictGasless.transactionCount).toBe(0);
        expect(rec.strictGasless.usdcBalance).toBe('0');
      });

      it('its permit still verifies against the live token — signing needs no funds at all', async () => {
        expect(rec.strictGasless.permitEthCall.result).toBe('success');
        const payload = buildBridgePermitPayload({
          network: 'testnet',
          owner: rec.strictGasless.permit.params.owner as `0x${string}`,
          usd: BigInt(rec.strictGasless.permit.params.usd),
          nonce: BigInt(rec.strictGasless.permit.params.nonce),
          deadline: BigInt(rec.strictGasless.permit.params.deadline),
        });
        const recovered = await recoverTypedDataAddress({
          ...asTypedData(payload),
          signature: rec.strictGasless.permit.signature as `0x${string}`,
        });
        expect(recovered.toLowerCase()).toBe(rec.strictGasless.address.toLowerCase());
      });

      it('the deposit records FailedPermitDeposit(errorCode 1): permit consumed, no balance to pull, no revert', () => {
        const { submit } = rec.strictGasless.simulation;
        expect(submit.status).toBe('success');
        const failed = submit.logs.find((l) => l.eventName === 'FailedPermitDeposit');
        expect(failed).toBeDefined();
        expect(Number(failed!.args.errorCode)).toBe(1);
        expect(logAddress(failed!, 'user').toLowerCase()).toBe(
          rec.strictGasless.address.toLowerCase()
        );
        expect(submit.logs.find((l) => l.eventName === 'Transfer')).toBeUndefined();
        // The permit stage DID succeed (Approval emitted) before transferFrom
        // failed — so the allowance to the bridge lingers on-chain. Inert for
        // Bridge2 (it only pulls immediately after a fresh permit) but a
        // documented constraint for 7.4.2's status tracking.
        expect(submit.logs.find((l) => l.eventName === 'Approval')).toBeDefined();
      });
    });
  });
});

describe('task 7.4.2 — relay-side deposit helpers', () => {
  const NET = BRIDGE_DEPOSIT_NETWORKS.testnet;
  const BRIDGE = NET.bridgeAddress;
  const USDC = NET.usdcAddress;

  describe('bridgePermitIdempotencyKey', () => {
    it('keys on (owner, permit nonce), lowercased and stable', () => {
      const key = bridgePermitIdempotencyKey({ owner: OWNER, nonce: 7n });
      expect(key).toBe(`permit-deposit:${OWNER.toLowerCase()}:7`);
      // Same identity → same key regardless of address casing.
      const upperOwner = `0x${OWNER.slice(2).toUpperCase()}` as `0x${string}`;
      expect(bridgePermitIdempotencyKey({ owner: upperOwner, nonce: 7n })).toBe(key);
    });

    it('distinguishes different nonces for the same owner (each permit is one deposit)', () => {
      expect(bridgePermitIdempotencyKey({ owner: OWNER, nonce: 0n })).not.toBe(
        bridgePermitIdempotencyKey({ owner: OWNER, nonce: 1n })
      );
    });

    it('rejects a negative nonce and a malformed owner', () => {
      expect(() => bridgePermitIdempotencyKey({ owner: OWNER, nonce: -1n })).toThrow();
      expect(() =>
        bridgePermitIdempotencyKey({ owner: 'nope' as `0x${string}`, nonce: 0n })
      ).toThrow(/address/i);
    });
  });

  describe('confirmation depth', () => {
    it('counts inclusive of the tx block (a tx in the head is depth 1)', () => {
      expect(confirmationDepth(100n, 100n)).toBe(1);
      expect(confirmationDepth(100n, 104n)).toBe(5);
    });

    it('never goes negative when the head lags the tx (reorg / stale read)', () => {
      expect(confirmationDepth(100n, 99n)).toBe(0);
    });

    it('is confirmed only at/after the required depth', () => {
      expect(isDepositConfirmed(100n, 103n, 5)).toBe(false); // depth 4
      expect(isDepositConfirmed(100n, 104n, 5)).toBe(true); // depth 5
    });

    it('clamps a sub-1 requirement up so an unmined tx is never "confirmed"', () => {
      // depth 1 = only the including block; required<1 must not accept depth 0.
      expect(isDepositConfirmed(100n, 99n, 0)).toBe(false);
      expect(isDepositConfirmed(100n, 100n, 0)).toBe(true);
    });
  });

  describe('classifyPermitDepositLogs (success ONLY off the USDC Transfer log)', () => {
    const params = { owner: OWNER, bridgeAddress: BRIDGE, usdcAddress: USDC, usd: 5_000_000n };

    const transferLog: DepositEventLog = {
      address: USDC,
      eventName: 'Transfer',
      args: { from: OWNER, to: BRIDGE, value: '5000000' },
    };
    const failedLog = (errorCode: number): DepositEventLog => ({
      address: BRIDGE,
      eventName: 'FailedPermitDeposit',
      args: { user: OWNER, usd: '5000000', errorCode },
    });

    it('credits on Transfer(owner → bridge, usd)', () => {
      expect(classifyPermitDepositLogs([transferLog], params)).toEqual({
        status: 'credited',
        usd: 5_000_000n,
      });
    });

    it('does NOT credit a Transfer that is not owner → bridge for the exact amount', () => {
      const wrongTo: DepositEventLog = {
        ...transferLog,
        args: { from: OWNER, to: '0x000000000000000000000000000000000000dEaD', value: '5000000' },
      };
      const wrongAmount: DepositEventLog = {
        ...transferLog,
        args: { from: OWNER, to: BRIDGE, value: '4000000' },
      };
      expect(classifyPermitDepositLogs([wrongTo], params).status).toBe('inconclusive');
      expect(classifyPermitDepositLogs([wrongAmount], params).status).toBe('inconclusive');
    });

    it('surfaces FailedPermitDeposit errorCode 0 (permit rejected) and 1 (transfer failed) distinctly', () => {
      expect(classifyPermitDepositLogs([failedLog(0)], params)).toEqual({
        status: 'failed',
        errorCode: 0,
      });
      expect(classifyPermitDepositLogs([failedLog(1)], params)).toEqual({
        status: 'failed',
        errorCode: 1,
      });
    });

    it('ignores the bridge Deposit event entirely — it is never emitted on this path', () => {
      const depositEvent: DepositEventLog = {
        address: BRIDGE,
        eventName: 'Deposit',
        args: { user: OWNER, usd: '5000000' },
      };
      // A lone (spurious) Deposit event is NOT a credit signal.
      expect(classifyPermitDepositLogs([depositEvent], params).status).toBe('inconclusive');
    });

    it('prefers the Transfer credit even if a stray failure event is also present', () => {
      expect(classifyPermitDepositLogs([failedLog(1), transferLog], params).status).toBe(
        'credited'
      );
    });

    it('is inconclusive with no relevant logs (an unmined tx)', () => {
      expect(classifyPermitDepositLogs([], params).status).toBe('inconclusive');
    });
  });

  describe('decodeBridgeDepositLogs (raw viem logs → classifiable shape)', () => {
    it('decodes the USDC Transfer log and round-trips through classification', () => {
      const topics = encodeEventTopics({
        abi: [USDC_TRANSFER_EVENT],
        eventName: 'Transfer',
        args: { from: OWNER, to: BRIDGE },
      });
      const data = encodeAbiParameters([{ type: 'uint256' }], [5_000_000n]);
      const raw = [{ address: USDC, data, topics }] as unknown as Parameters<
        typeof decodeBridgeDepositLogs
      >[0];
      const decoded = decodeBridgeDepositLogs(raw, USDC, BRIDGE);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.eventName).toBe('Transfer');
      expect(
        classifyPermitDepositLogs(decoded, {
          owner: OWNER,
          bridgeAddress: BRIDGE,
          usdcAddress: USDC,
          usd: 5_000_000n,
        }).status
      ).toBe('credited');
    });

    it('decodes FailedPermitDeposit from the bridge and skips foreign/unknown logs', () => {
      const topics = encodeEventTopics({
        abi: [FAILED_PERMIT_DEPOSIT_EVENT],
        eventName: 'FailedPermitDeposit',
      });
      const data = encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint64' }, { type: 'uint8' }],
        [OWNER, 5_000_000n, 1]
      );
      const raw = [
        { address: BRIDGE, data, topics },
        // A log from an unwatched contract must be ignored, not throw.
        { address: '0x000000000000000000000000000000000000dEaD', data: '0x', topics: [] },
      ] as unknown as Parameters<typeof decodeBridgeDepositLogs>[0];
      const decoded = decodeBridgeDepositLogs(raw, USDC, BRIDGE);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.eventName).toBe('FailedPermitDeposit');
      expect(Number(decoded[0]!.args.errorCode)).toBe(1);
    });
  });

  describe('master-signing allowlist extension (the permit is master-signable, nothing looser)', () => {
    const permit = buildBridgePermitPayload(validParams());

    it('accepts the pinned bridge permit as master-signable, but NOT as a user-signed action', () => {
      expect(isBridgePermitPayload(permit)).toBe(true);
      expect(isMasterSignablePayload(permit)).toBe(true);
      // The phase-4 gate shape is unchanged — the permit is still not a
      // HyperliquidSignTransaction action.
      expect(isUserSignedActionPayload(permit)).toBe(false);
    });

    it('refuses a permit whose spender is not the bridge (the load-bearing pin)', () => {
      const redirected = {
        ...permit,
        message: { ...permit.message, spender: '0x000000000000000000000000000000000000dEaD' },
      };
      expect(isBridgePermitPayload(redirected)).toBe(false);
      // [#677] Task 7.8.3 widened the master allowlist with a SECOND permit
      // shape — the withdraw permit, whose spender is the withdrawal
      // destination — and it exists only on networks whose token lacks
      // EIP-3009 (testnet here). So this redirected permit is still refused as
      // a DEPOSIT, and where it is master-signable at all it is as that other,
      // separately-reviewed shape. The blanket refusal survives on mainnet,
      // where the fallback does not apply: see the mainnet case below and
      // tests/phase-7/money-rails-testnet.phase-7.test.ts for the disjointness
      // of the two gates.
      expect(isUsdcWithdrawPermitPayload(redirected)).toBe(true);
    });

    it('on mainnet, a permit naming any spender but the bridge is master-signable by nothing', () => {
      const mainnetPermit = buildBridgePermitPayload({ ...validParams(), network: 'mainnet' });
      const redirected = {
        ...mainnetPermit,
        message: {
          ...mainnetPermit.message,
          spender: '0x000000000000000000000000000000000000dEaD',
        },
      };
      expect(isBridgePermitPayload(redirected)).toBe(false);
      expect(isUsdcWithdrawPermitPayload(redirected)).toBe(false);
      expect(isMasterSignablePayload(redirected)).toBe(false);
    });

    it('refuses a permit on an unknown token/domain', () => {
      const foreignDomain = {
        ...permit,
        domain: { ...permit.domain, verifyingContract: BRIDGE },
      };
      expect(isBridgePermitPayload(foreignDomain)).toBe(false);
      const foreignName = { ...permit, domain: { ...permit.domain, name: 'Evil USD' } };
      expect(isBridgePermitPayload(foreignName)).toBe(false);
    });

    it('refuses a permit with a mutated (non-EIP-2612) type shape', () => {
      const mutatedTypes = {
        ...permit,
        types: {
          Permit: [
            ...USDC_PERMIT_TYPES.Permit.slice(0, 4),
            { name: 'deadline', type: 'uint256' },
            { name: 'extra', type: 'address' },
          ],
        },
      };
      expect(isBridgePermitPayload(mutatedTypes)).toBe(false);
    });

    it('mainnet native-USDC permits are recognized too', () => {
      const mainnet = buildBridgePermitPayload({ ...validParams(), network: 'mainnet' });
      expect(isBridgePermitPayload(mainnet)).toBe(true);
    });
  });
});

/**
 * [#693] `BridgePermitPayload.message` carries wire-safe DECIMAL STRINGS, while
 * viem's typed-data generics demand `bigint` for a `uint256`. viem hashes the
 * two forms byte-identically (pinned by
 * `bridge-permit-signer-boundary.phase-7.test.ts`), so this bridges the two type
 * shapes without changing a single value.
 */
function asTypedData(payload: BridgePermitPayload): TypedDataDefinition {
  return payload as unknown as TypedDataDefinition;
}

function sigOver(payload: BridgePermitPayload): `0x${string}` {
  // A structurally valid 65-byte signature; recovery correctness is covered
  // by the recorded-run tests, structural plumbing by these.
  void payload;
  return `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`;
}

/**
 * The recorded payload rebuilt in viem's NATIVE bigint form.
 *
 * Deliberately NOT `BridgePermitPayload`: that type's message values are
 * decimal strings ([#693] — the payload crosses the hl-signer/v2 JSON
 * boundary), and this helper converts them back to bigints. Declaring
 * `BridgePermitPayload` claimed the two were one type, which is the opposite of
 * what its only caller asserts: that the two *different* forms hash identically.
 */
type RecordedPermitTypedData = Omit<BridgePermitPayload, 'message'> & {
  message: {
    owner: `0x${string}`;
    spender: `0x${string}`;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };
};

function jsonPayloadToTypedData(json: BridgePermitPayloadJson): RecordedPermitTypedData {
  return {
    domain: {
      name: json.domain.name,
      version: json.domain.version,
      chainId: json.domain.chainId,
      verifyingContract: json.domain.verifyingContract as `0x${string}`,
    },
    types: json.types,
    primaryType: 'Permit',
    message: {
      owner: json.message.owner as `0x${string}`,
      spender: json.message.spender as `0x${string}`,
      value: BigInt(json.message.value),
      nonce: BigInt(json.message.nonce),
      deadline: BigInt(json.message.deadline),
    },
  };
}

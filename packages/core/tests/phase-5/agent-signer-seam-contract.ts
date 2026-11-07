/**
 * Phase 5 Epic 5.1 — the shared agent-signer seam conformance suite.
 *
 * The Phase 1 Epic 1.5.2 contract, packaged as a reusable suite the way
 * `runSignerContract` packages the hl-signer/v2 boundary contract
 * (signer-embed.phase-4.test.ts): every implementation of the revised,
 * signature-oriented seam — the passkey agent signer (task 5.1.2), the
 * server-side session signer facade (task 5.1.3), test doubles — runs the
 * same checks:
 *
 *  - `AgentVaultAdapter` surface is exactly its three members; the retired
 *    key-exporting `getOrCreateAgent` is gone; no member is key-shaped
 *  - the seam result is exactly `{ signer, isNew }` and the signer surface
 *    is exactly `agentAddress` + async `sign` — nothing else to hold key
 *    material
 *  - sign dispatch: the signature over the canonical L1 phantom-agent
 *    envelope recovers to `agentAddress` (i.e. L1 signatures are valid),
 *    including the EIP712Domain-carrying envelope variant the Phase 0.6
 *    handshake produces
 *  - the derived agent identity is stable across seam calls
 *  - leak probe: everything that crosses the seam — and every boundary
 *    transcript the harness exposes — carries the agent's PUBLIC address and
 *    none of the implementation's secrets, in any hex casing
 *
 * A conforming implementation passes with zero implementation-specific
 * setup beyond the harness; suite-level policy tests (payload gating,
 * ceremony counting) stay with the implementation that owns the policy.
 */
import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import type {
  AgentSignPayload,
  AgentSigner,
  AgentVaultAdapter,
  HexAddress,
} from '../../src/adapters/types';

/** Member names the seam must never grow — the 1.5.2 "no key export" rule. */
export const SEAM_KEY_SHAPED_NAME = /key|private|secret|mnemonic|seed|prf/i;

/** Every string reachable from `value` via enumerable own properties. */
export function collectStrings(
  value: unknown,
  out: string[] = [],
  seen = new Set<unknown>()
): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const inner of Object.values(value)) collectStrings(inner, out, seen);
  return out;
}

/** The canonical L1 phantom-agent envelope (what HlClient hands the agent tier). */
export function seamL1Envelope(
  overrides: {
    source?: 'a' | 'b';
    connectionId?: string;
    withDomainType?: boolean;
  } = {}
): AgentSignPayload {
  return {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      ...(overrides.withDomainType
        ? {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          }
        : {}),
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: {
      source: overrides.source ?? 'a',
      connectionId: overrides.connectionId ?? `0x${'ab'.repeat(32)}`,
    },
  };
}

export async function recoverSeamL1Signer(
  payload: AgentSignPayload,
  signature: `0x${string}`
): Promise<string> {
  const { EIP712Domain: _omit, ...types } = payload.types;
  return recoverTypedDataAddress({
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
    signature,
  } as Parameters<typeof recoverTypedDataAddress>[0]);
}

export interface AgentSeamContractHarness {
  vault: AgentVaultAdapter;
  /** The master account the vault is asked to serve. */
  master: HexAddress;
  /** The agent address this implementation is expected to derive for it. */
  expectedAgentAddress: HexAddress;
  /**
   * Hex strings (without 0x) that must never be observable outside the
   * signer implementation: private keys, key-derivation inputs, etc.
   */
  secrets: string[];
  /**
   * Everything that crossed an implementation boundary during the run
   * (RPC transcripts, wire traffic) — probed for secrets after signing.
   */
  observable?(): unknown[];
  close?(): void | Promise<void>;
}

export function runAgentSignerSeamContract(
  name: string,
  setup: () => AgentSeamContractHarness | Promise<AgentSeamContractHarness>
): void {
  const withHarness = async (
    fn: (harness: AgentSeamContractHarness) => Promise<void>
  ): Promise<void> => {
    const harness = await setup();
    try {
      await fn(harness);
    } finally {
      await harness.close?.();
    }
  };

  describe(`agent-signer seam conformance (shared 1.5.2 contract): ${name}`, () => {
    it('the vault surface is exactly the AgentVaultAdapter contract — the retired key-exporting member is gone', () =>
      withHarness(async ({ vault }) => {
        const surface: Record<keyof AgentVaultAdapter, true> = {
          getOrCreateAgentSigner: true,
          getApproveSignatures: true,
          saveApproveSignatures: true,
        };
        for (const member of Object.keys(surface)) {
          expect(typeof (vault as unknown as Record<string, unknown>)[member]).toBe('function');
          expect(member).not.toMatch(SEAM_KEY_SHAPED_NAME);
        }
        expect('getOrCreateAgent' in vault).toBe(false);
      }));

    it('the seam result is exactly { signer, isNew }; the signer surface is exactly agentAddress + sign', () =>
      withHarness(async ({ vault, master, expectedAgentAddress }) => {
        const result = await vault.getOrCreateAgentSigner(master);
        expect(Object.keys(result).sort()).toEqual(['isNew', 'signer']);
        expect(typeof result.isNew).toBe('boolean');
        expect(Object.keys(result.signer).sort()).toEqual(['agentAddress', 'sign']);
        for (const member of Object.keys(result.signer)) {
          expect(member).not.toMatch(SEAM_KEY_SHAPED_NAME);
        }
        const seamSigner: AgentSigner = result.signer; // type-level: assignable to the seam
        expect(seamSigner.agentAddress.toLowerCase()).toBe(expectedAgentAddress.toLowerCase());
      }));

    it('sign dispatch: L1 envelope signatures recover to agentAddress (plain and EIP712Domain-carrying variants)', () =>
      withHarness(async ({ vault, master }) => {
        const { signer } = await vault.getOrCreateAgentSigner(master);

        for (const envelope of [
          seamL1Envelope(),
          seamL1Envelope({ source: 'b', withDomainType: true }),
        ]) {
          const signature = await signer.sign(envelope);
          expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
          await expect(
            recoverSeamL1Signer(envelope, signature as `0x${string}`)
          ).resolves.toBe(signer.agentAddress);
        }
      }));

    it('the derived agent identity is stable across seam calls', () =>
      withHarness(async ({ vault, master, expectedAgentAddress }) => {
        const first = await vault.getOrCreateAgentSigner(master);
        const second = await vault.getOrCreateAgentSigner(master);
        expect(first.signer.agentAddress).toBe(second.signer.agentAddress);
        expect(first.signer.agentAddress.toLowerCase()).toBe(
          expectedAgentAddress.toLowerCase()
        );
      }));

    it('leak probe: nothing that crossed the seam or a boundary transcript carries key material', () =>
      withHarness(async ({ vault, master, expectedAgentAddress, secrets, observable }) => {
        expect(secrets.length).toBeGreaterThan(0);

        const result = await vault.getOrCreateAgentSigner(master);
        const signature = await result.signer.sign(seamL1Envelope());

        // What crossed the seam: the result object graph plus the returned
        // signature. The agent's PUBLIC address should cross; secrets never.
        const crossed = collectStrings([result, signature]).join(',').toLowerCase();
        expect(crossed).toContain(expectedAgentAddress.slice(2).toLowerCase());
        for (const secret of secrets) {
          expect(crossed).not.toContain(secret.toLowerCase());
        }

        // Whatever else the implementation let cross a boundary (RPC
        // transcript, wire traffic): also secret-free.
        const transcript = JSON.stringify(observable?.() ?? []).toLowerCase();
        for (const secret of secrets) {
          expect(transcript).not.toContain(secret.toLowerCase());
        }
      }));
  });
}

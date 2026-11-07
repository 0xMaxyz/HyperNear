/**
 * PRF capability: how it is established, what is recorded, and what stays the
 * same forever.
 *
 * Passkeys stored in Windows Hello were reported as "PRF not supported". The
 * authenticator was never the problem — verified on Windows 11 25H2 returning
 * a 32-byte PRF output on assertion. The problem was reading
 * `create()`'s `prf.enabled` as a verdict: the WebAuthn spec makes it optional
 * and advisory at creation time, Windows Hello (webauthn.dll) omits it while
 * evaluating PRF on every assertion, and Chrome/Edge before 147 omit it on
 * every platform.
 *
 * This file pins the four properties that keep that from coming back:
 *
 *  1. an advisory flag can never condemn a credential;
 *  2. the three outcomes stay distinguishable — in particular a ceremony that
 *     never completed is `unknown`, not `unavailable`;
 *  3. the same salt and credential yield byte-identical output across
 *     sessions, restarts and reboots, whichever ceremony returned it;
 *  4. nothing derived from PRF output — and never the output itself — is
 *     recordable material.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

import {
  CURRENT_SALT_VERSION,
  deriveAddress,
  enrollPasskey,
  isPrfAdvertised,
  isPrfStatus,
  PRF_RESULT_BYTES,
  prfSalt,
  readPrfOutput,
  statusOfCompletedCeremony,
  type PrfCredential,
  type PrfCredentialsApi,
} from '../../src/index';

const RP_ID = 'perps.example';

const sha256 = (data: string | Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());
const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', key).update(data).digest());

/**
 * A credential whose PRF output is HMAC(secret, salt) — the same shape a real
 * authenticator has, and the reason the output is stable for a given secret.
 * A synced passkey (iCloud, Google) is modelled by reusing one secret.
 */
interface AuthenticatorShape {
  /** What `create()` says about PRF: `true`, `false`, or nothing at all. */
  advertises?: 'true' | 'false' | 'absent';
  /** Whether `create()` itself honours `prf.eval` — the one-prompt clients. */
  evalAtCreate?: boolean;
  /** Whether an assertion evaluates the salt. The only real answer. */
  prfAvailable?: boolean;
  /** Make the assertion throw, as a dismissed OS prompt does. */
  getThrows?: boolean;
}

class FakeAuthenticator implements PrfCredentialsApi {
  getCalls = 0;
  createCalls = 0;

  constructor(
    private readonly secret: Uint8Array,
    private readonly shape: AuthenticatorShape = {}
  ) {}

  private saltOf(options: { publicKey: Record<string, unknown> }): Uint8Array {
    const prf = (options.publicKey as { extensions?: { prf?: Record<string, never> } }).extensions
      ?.prf as
      | {
          eval?: { first?: Uint8Array };
          evalByCredential?: Record<string, { first?: Uint8Array }>;
        }
      | undefined;
    const first =
      prf?.eval?.first ??
      (prf?.evalByCredential ? Object.values(prf.evalByCredential)[0]?.first : undefined);
    if (!first) throw new Error('fake authenticator: no PRF salt in the request');
    return new Uint8Array(first);
  }

  async create(options: { publicKey: Record<string, unknown> }): Promise<PrfCredential> {
    this.createCalls += 1;
    const advertises = this.shape.advertises ?? 'absent';
    const prf: Record<string, unknown> = {};
    if (advertises !== 'absent') prf.enabled = advertises === 'true';
    if (this.shape.evalAtCreate && this.shape.prfAvailable !== false) {
      prf.results = { first: hmac(this.secret, this.saltOf(options)) };
    }
    return {
      rawId: sha256('credential-id').slice(0, 16),
      getClientExtensionResults: () => (Object.keys(prf).length ? { prf } : {}),
    };
  }

  async get(options: { publicKey: Record<string, unknown> }): Promise<PrfCredential> {
    this.getCalls += 1;
    if (this.shape.getThrows) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'NotAllowedError' });
    }
    const rawId = sha256('credential-id').slice(0, 16);
    if (this.shape.prfAvailable === false) {
      return { rawId, getClientExtensionResults: () => ({}) };
    }
    return {
      rawId,
      getClientExtensionResults: () => ({
        prf: { results: { first: hmac(this.secret, this.saltOf(options)) } },
      }),
    };
  }
}

function enrollArgs(credentials: PrfCredentialsApi) {
  return {
    credentials,
    rpId: RP_ID,
    userId: new TextEncoder().encode('user-1'),
    userName: 'alice',
    createChallenge: new Uint8Array([1, 2, 3, 4]),
    getChallenge: new Uint8Array([5, 6, 7, 8]),
  };
}

const SECRET = sha256('a-single-authenticator');

describe('an advisory create() flag never decides capability', () => {
  it.each(['absent', 'false', 'true'] as const)(
    'enrols with prf.enabled=%s when the assertion evaluates the salt',
    async (advertises) => {
      const auth = new FakeAuthenticator(SECRET, { advertises });
      const result = await enrollPasskey(enrollArgs(auth));

      expect(result.prfStatus).toBe('confirmed');
      expect(auth.getCalls).toBe(1);
      expect(result.address).toBe(deriveAddress(hmac(SECRET, prfSalt(RP_ID, 'agent'))));
    }
  );

  it('reads the flag as a hint without letting it change the outcome', () => {
    const advertised: PrfCredential = {
      rawId: new Uint8Array(1),
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
    };
    const silent: PrfCredential = {
      rawId: new Uint8Array(1),
      getClientExtensionResults: () => ({}),
    };
    expect(isPrfAdvertised(advertised)).toBe(true);
    expect(isPrfAdvertised(silent)).toBe(false);
    // …and neither says anything about what a ceremony returned.
    expect(statusOfCompletedCeremony(advertised)).toBe('unavailable');
    expect(statusOfCompletedCeremony(silent)).toBe('unavailable');
  });
});

describe('the three outcomes stay distinguishable', () => {
  it('confirms only on real PRF output', async () => {
    const result = await enrollPasskey(enrollArgs(new FakeAuthenticator(SECRET)));
    expect(result.prfStatus).toBe('confirmed');
  });

  it('marks unavailable when a COMPLETED assertion returns nothing', async () => {
    const auth = new FakeAuthenticator(SECRET, { prfAvailable: false });
    const result = await enrollPasskey(enrollArgs(auth));
    expect(result.prfStatus).toBe('unavailable');
    expect(auth.getCalls).toBe(1);
  });

  // Acceptance criterion 4: a cancelled probe leaves the credential retryable.
  it('marks unknown — never unavailable — when the probe is cancelled', async () => {
    const auth = new FakeAuthenticator(SECRET, { getThrows: true });
    const result = await enrollPasskey(enrollArgs(auth));

    expect(result.prfStatus).toBe('unknown');
    expect(result.address).toBeUndefined();
    // The credential exists and is nameable, which is what makes a retry
    // possible at all — the alternative is an orphan on the authenticator.
    expect(result.credentialId).toBeTruthy();
  });

  it('re-probing after a cancellation succeeds against the same credential', async () => {
    const cancelled = await enrollPasskey(
      enrollArgs(new FakeAuthenticator(SECRET, { getThrows: true }))
    );
    expect(cancelled.prfStatus).toBe('unknown');

    // Same authenticator secret, this time the user completes the prompt.
    const retried = await enrollPasskey(enrollArgs(new FakeAuthenticator(SECRET)));
    expect(retried.prfStatus).toBe('confirmed');
    expect(retried.credentialId).toBe(cancelled.credentialId);
  });

  it('only accepts the three states as a status', () => {
    for (const status of ['confirmed', 'unavailable', 'unknown']) {
      expect(isPrfStatus(status)).toBe(true);
    }
    for (const nope of ['supported', true, false, null, undefined, '']) {
      expect(isPrfStatus(nope)).toBe(false);
    }
  });
});

// Acceptance criterion 3. If this ever drifts, every account derived under the
// old behaviour becomes unreachable — the address IS the account.
describe('the same salt and credential give byte-identical output, always', () => {
  it('survives repeated sessions, browser restarts and reboots', async () => {
    // Each enrolment is an independent "session": a fresh authenticator object
    // holding the same credential secret, which is exactly what a restart or a
    // synced passkey on a second device looks like from here.
    const addresses = new Set<string>();
    for (let session = 0; session < 5; session += 1) {
      const result = await enrollPasskey(enrollArgs(new FakeAuthenticator(SECRET)));
      addresses.add(result.address as string);
    }
    expect(addresses.size).toBe(1);
  });

  it('does not depend on which ceremony returned the bytes', async () => {
    const oneShot = await enrollPasskey(
      enrollArgs(new FakeAuthenticator(SECRET, { evalAtCreate: true, advertises: 'true' }))
    );
    const probed = await enrollPasskey(
      enrollArgs(new FakeAuthenticator(SECRET, { advertises: 'absent' }))
    );

    expect(oneShot.singlePrompt).toBe(true);
    expect(probed.singlePrompt).toBe(false);
    // A user enrolling on Safari and the same user on Windows Hello land on
    // the same account.
    expect(oneShot.address).toBe(probed.address);
  });

  it('changes with the salt, and the salt is stable, domain-separated and 32 bytes', () => {
    const agent = prfSalt(RP_ID, 'agent');
    const master = prfSalt(RP_ID, 'master');
    const elsewhere = prfSalt('other.example', 'agent');
    const rotated = prfSalt(RP_ID, 'agent', CURRENT_SALT_VERSION + 1);

    for (const salt of [agent, master, elsewhere, rotated]) {
      expect(salt.length).toBe(PRF_RESULT_BYTES);
    }
    // Same inputs, same bytes — the property the account address rests on.
    expect([...prfSalt(RP_ID, 'agent')]).toEqual([...agent]);
    // Distinct tier, RP and version each give a distinct key.
    const distinct = new Set([agent, master, elsewhere, rotated].map((s) => s.join(',')));
    expect(distinct.size).toBe(4);
  });

  it('rejects a PRF output that is not exactly 32 bytes rather than deriving from it', () => {
    const short: PrfCredential = {
      rawId: new Uint8Array(1),
      getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(16) } } }),
    };
    expect(readPrfOutput(short)).toBeNull();
    expect(statusOfCompletedCeremony(short)).toBe('unavailable');
  });
});

// Acceptance criterion 7, at the layer that owns the bytes.
describe('PRF output is not recordable material', () => {
  it('never appears in the enrolment result, in any encoding', async () => {
    const result = await enrollPasskey(enrollArgs(new FakeAuthenticator(SECRET)));
    const prfOutput = hmac(SECRET, prfSalt(RP_ID, 'agent'));

    const serialized = JSON.stringify(result).toLowerCase();
    const hex = [...prfOutput].map((b) => b.toString(16).padStart(2, '0')).join('');
    const base64 = Buffer.from(prfOutput).toString('base64');
    for (const encoding of [
      hex,
      base64.toLowerCase(),
      base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').toLowerCase(),
      [...prfOutput].join(','),
    ]) {
      expect(serialized).not.toContain(encoding);
    }
    // What it DOES carry is public: an address, an id, a status.
    expect(Object.keys(result).sort()).toEqual([
      'address',
      'credentialId',
      'prfStatus',
      'singlePrompt',
      'tier',
    ]);
  });
});

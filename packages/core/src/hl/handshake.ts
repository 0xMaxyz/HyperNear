import { recoverTypedDataAddress, type Hex } from 'viem';
import { hashHlL1Action } from './HlClient';
import type { HexAddress } from '../adapters/types';
import type {
  HlHex,
  HlNetwork,
  HlOrderGrouping,
  HlOrderInput,
  HlSignPayload,
  HlTransport,
} from './types';

/**
 * Phase 0 Epic 0.6.1 — three-step signing-handshake prototype.
 *
 * The single trading path every user rides once Phase 5 builds it for real:
 *
 *  1. **Build** — the backend constructs the unsigned action (here: one market
 *     order, a FrontendMarket-tif aggressive limit), allocates the nonce, and
 *     issues a short-TTL, single-use pending-action token bound to the exact
 *     payload. The client receives the token plus the ready-made EIP-712
 *     payload and nothing else to fill in.
 *  2. **Sign** — the browser signs that payload wherever the key lives
 *     (passkey signer iframe, browser wallet). The backend never sees key
 *     material; the client never constructs an action.
 *  3. **Verify + relay** — the backend verifies the returned signature against
 *     the payload *it stored* (a client cannot substitute a payload, because no
 *     payload is accepted on submit) and that the ECDSA-recovered address is
 *     the session account the token was issued to — only then does the
 *     fully-formed signed action go upstream through the injected transport.
 *
 * Spike boundaries, on purpose: in-memory pending store, market order only,
 * one coordinator per process. Phase 5 Epic 5.2 productionizes this (shared
 * store, full action set, per-account nonce queue); 0.6.2 catalogues the
 * replay/tamper vectors against exactly this surface.
 *
 * SDK note: action hashing is the one primitive that must never be
 * reimplemented here (Epic 0.1's whole point), and HlClient.ts is the
 * package's single SDK seam — so it comes in through `hashHlL1Action` there.
 */

/** Client-visible lifetime of a pending action. Short by design: the token is
 * meant to cover one immediate sign ceremony, not a shopping cart. */
export const HANDSHAKE_TOKEN_TTL_MS = 15_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

// The L1 phantom-agent envelope, byte-identical to the SDK's construction
// (verified against `signL1Action` in the phase-0 suite).
const HL_EXCHANGE_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000' as HlHex,
} as const;

const HL_AGENT_SIGN_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

export interface HandshakeSession {
  /** The account the app session is authenticated as — the only address a
   * returned signature is allowed to recover to. */
  account: HexAddress;
}

export interface HandshakeMarketOrderParams {
  asset: number;
  isBuy: boolean;
  /** Slippage-capped crossing price. Client-declared in this spike; Phase 5's
   * build step prices server-side. */
  px: string;
  sz: string;
  reduceOnly?: boolean;
  cloid?: HlHex;
}

export interface HlOrderAction {
  type: 'order';
  orders: HlOrderInput[];
  grouping: HlOrderGrouping;
}

/** What the client gets back from step 1 — display material plus the exact
 * payload to sign. None of it is trusted on the way back in. */
export interface PendingActionIssue {
  token: string;
  expiresAt: number;
  nonce: number;
  action: HlOrderAction;
  signPayload: HlSignPayload;
}

export interface HandshakeSubmission {
  token: string;
  /** The 65-byte (r || s || v) hex signature over the issued payload. */
  signature: string;
}

export type HandshakeRejectionCode =
  | 'UNKNOWN_TOKEN'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'MALFORMED_SIGNATURE'
  | 'SIGNER_MISMATCH';

export type HandshakeSubmitResult =
  | {
      relayed: true;
      token: string;
      account: HexAddress;
      recoveredSigner: HexAddress;
      nonce: number;
      /** The upstream (Hyperliquid) response, passed through verbatim. */
      response: unknown;
    }
  | { relayed: false; code: HandshakeRejectionCode; message: string };

export interface HandshakeCoordinatorOptions {
  network: HlNetwork;
  /** Where verified actions are relayed — apps/api's egress in production, a
   * capturing mock in tests, plain HTTPS in the recorded testnet runs. */
  relay: HlTransport;
  ttlMs?: number;
  now?: () => number;
  /** Nonce allocator; defaults to a per-coordinator monotonic wall clock.
   * Phase 2.3.3's per-account action queue slots in here. */
  nonceSource?: () => number;
  /** Token minting; defaults to crypto.randomUUID (unguessable). */
  tokenSource?: () => string;
}

interface PendingActionRecord {
  account: HexAddress;
  action: HlOrderAction;
  nonce: number;
  signPayload: HlSignPayload;
  expiresAt: number;
  used: boolean;
}

/** Recovers the EOA that signed a handshake payload. Exported for the
 * recorded-run script and tests; `submit` uses it internally. */
export async function recoverHandshakeSigner(
  payload: HlSignPayload,
  signature: string
): Promise<HexAddress> {
  // viem hashes the domain itself; the EIP712Domain entry stays in the payload
  // for wallets but must not be passed as a message type.
  const { EIP712Domain: _omit, ...types } = payload.types;
  return recoverTypedDataAddress({
    domain: payload.domain,
    types: types as HlSignPayload['types'],
    primaryType: payload.primaryType,
    message: payload.message,
    signature: signature as Hex,
  });
}

function splitSignature(signature: string): { r: HlHex; s: HlHex; v: number } {
  const raw = parseInt(signature.slice(130, 132), 16);
  return {
    r: `0x${signature.slice(2, 66)}` as HlHex,
    s: `0x${signature.slice(66, 130)}` as HlHex,
    v: raw < 27 ? raw + 27 : raw,
  };
}

export class HandshakeCoordinator {
  readonly #network: HlNetwork;
  readonly #relay: HlTransport;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #nonceSource: () => number;
  readonly #tokenSource: () => string;
  readonly #pending = new Map<string, PendingActionRecord>();
  // Every nonce ever allocated, keyed by lowercased account. Nonce uniqueness is
  // per-account (Hyperliquid nonces bind per address), so the same nonce for two
  // different accounts is fine — a repeat for the *same* account is the collision
  // this guards (see 0.6.2 catalogue, vector "nonce collision").
  readonly #allocatedNonces = new Map<string, Set<number>>();
  #lastNonce = 0;

  constructor(options: HandshakeCoordinatorOptions) {
    this.#network = options.network;
    this.#relay = options.relay;
    this.#ttlMs = options.ttlMs ?? HANDSHAKE_TOKEN_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#nonceSource = options.nonceSource ?? (() => this.#nextDefaultNonce());
    this.#tokenSource = options.tokenSource ?? (() => crypto.randomUUID());
  }

  // Wall-clock nonces with a monotonic bump, so two actions issued in the same
  // millisecond still sign distinct digests.
  #nextDefaultNonce(): number {
    const nonce = Math.max(this.#now(), this.#lastNonce + 1);
    this.#lastNonce = nonce;
    return nonce;
  }

  /** Step 1 — build the unsigned market order and issue its pending token. */
  issueMarketOrder(
    session: HandshakeSession,
    params: HandshakeMarketOrderParams
  ): PendingActionIssue {
    if (!ADDRESS_RE.test(session.account)) {
      throw new Error('issueMarketOrder: session.account must be a 0x-prefixed EVM address');
    }

    const order: HlOrderInput = {
      a: params.asset,
      b: params.isBuy,
      p: params.px,
      s: params.sz,
      r: params.reduceOnly ?? false,
      t: { limit: { tif: 'FrontendMarket' } },
      ...(params.cloid ? { c: params.cloid } : {}),
    };
    const action: HlOrderAction = { type: 'order', orders: [order], grouping: 'na' };
    const nonce = this.#nonceSource();

    // Nonce-collision guard. The default allocator is monotonic and can't
    // collide, but the nonce source is injectable (Phase 2.3.3's per-account
    // action queue slots in here), so a faulty or hostile allocator handing two
    // concurrently-issued actions the same nonce for one account is a real
    // vector: on relay the exchange rejects the second as a nonce replay, and a
    // signature captured for one becomes valid for the other (identical digest).
    // Refuse to mint the colliding action at all — fail closed at build time.
    const accountKey = session.account.toLowerCase();
    if (this.#allocatedNonces.get(accountKey)?.has(nonce)) {
      throw new Error(
        `issueMarketOrder: nonce ${nonce} was already allocated for this account — ` +
          'refusing to issue a second action that would collide on nonce (replay risk)'
      );
    }

    const connectionId = hashHlL1Action({ action, nonce });

    const signPayload: HlSignPayload = {
      domain: { ...HL_EXCHANGE_DOMAIN },
      types: HL_AGENT_SIGN_TYPES,
      primaryType: 'Agent',
      message: { source: this.#network === 'testnet' ? 'b' : 'a', connectionId },
    };

    const token = this.#tokenSource();
    const issuedAt = this.#now();
    const record: PendingActionRecord = {
      account: session.account,
      action,
      nonce,
      signPayload,
      expiresAt: issuedAt + this.#ttlMs,
      used: false,
    };
    this.#pending.set(token, record);

    const allocated = this.#allocatedNonces.get(accountKey);
    if (allocated) allocated.add(nonce);
    else this.#allocatedNonces.set(accountKey, new Set([nonce]));

    // The client gets deep copies: whatever it later mutates, verification and
    // relay run off the record stored here.
    return {
      token,
      expiresAt: record.expiresAt,
      nonce,
      action: structuredClone(action),
      signPayload: structuredClone(signPayload),
    };
  }

  /** Step 3 — verify the returned signature against the stored payload and
   * relay only on a full match. */
  async submit(submission: HandshakeSubmission): Promise<HandshakeSubmitResult> {
    const record = this.#pending.get(submission.token);
    if (!record) {
      return {
        relayed: false,
        code: 'UNKNOWN_TOKEN',
        message: 'no pending action was issued under this token',
      };
    }
    if (record.used) {
      return {
        relayed: false,
        code: 'ALREADY_USED',
        message: 'pending-action tokens are single-use; build a fresh action to retry',
      };
    }
    if (this.#now() >= record.expiresAt) {
      return {
        relayed: false,
        code: 'EXPIRED',
        message: 'the pending action expired before a signature arrived; build a fresh action',
      };
    }
    // A garbage-formatted blob is rejected before the token burns; anything
    // that reaches cryptographic verification consumes the attempt.
    if (!SIGNATURE_RE.test(submission.signature)) {
      return {
        relayed: false,
        code: 'MALFORMED_SIGNATURE',
        message: 'signature must be 65 bytes of 0x-prefixed hex (r || s || v)',
      };
    }

    // Fail closed: one verification attempt per issued action. Burning before
    // the async recovery also makes a concurrent double-submit race impossible.
    record.used = true;

    let recovered: HexAddress;
    try {
      recovered = await recoverHandshakeSigner(record.signPayload, submission.signature);
    } catch {
      return {
        relayed: false,
        code: 'MALFORMED_SIGNATURE',
        message: 'signature did not parse as a secp256k1 signature over the issued payload',
      };
    }

    if (recovered.toLowerCase() !== record.account.toLowerCase()) {
      return {
        relayed: false,
        code: 'SIGNER_MISMATCH',
        message:
          'recovered signer is not the session account the pending action was issued to',
      };
    }

    const response = await this.#relay.request('exchange', {
      action: record.action,
      signature: splitSignature(submission.signature),
      nonce: record.nonce,
    });

    return {
      relayed: true,
      token: submission.token,
      account: record.account,
      recoveredSigner: recovered,
      nonce: record.nonce,
      response,
    };
  }
}

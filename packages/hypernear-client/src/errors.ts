/** Base class: every error this package throws on purpose. */
export class HyperNearError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** The payload cannot be expressed by the contract in this mode; thrown before any NEAR call. */
export class HyperNearUnsupportedActionError extends HyperNearError {}

/** The contract call ran but the MPC signer failed (`on_signed` returned null). The owner nonce stays used. */
export class HyperNearMpcSignError extends HyperNearError {}

/** The contract rejected the call (panic message in `message`), or the transaction failed. */
export class HyperNearContractError extends HyperNearError {}

/** The contract signed a different digest than the payload hashes to (a mapping bug; never post such a signature). */
export class HyperNearDigestMismatchError extends HyperNearError {}

/** relaySubmit refused before sending (e.g. the owner has no registered leg). */
export class HyperNearRelayRefusedError extends HyperNearError {}

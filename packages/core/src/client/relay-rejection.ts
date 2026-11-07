/**
 * [#789] Task 7.10.4 — where `agent-approval.ts`'s `AgentApprovalError`
 * carries the exchange's refusal of a master-signed `approveAgent`, this is
 * the same treatment for the exchange's verdict on the relayed action itself.
 *
 * The underlying Hyperliquid SDK throws its own `ApiRequestError` once
 * Hyperliquid answers an order, cancel, modify or withdrawal with an error
 * response, but only `hl/HlClient.ts` is allowed to know that type exists
 * (the SDK-boundary rule `tests/phase-1/sdk-adoption.phase-1.test.ts`
 * enforces) — so `packages/core` cannot simply re-export it for the relay
 * routes to match against. `HlClient` catches it at the seam and rethrows
 * this wrapper instead, exactly as `PerpsClient.ensureApprovals()` rethrows
 * `AgentApprovalError` in place of the raw SDK failure.
 *
 * Before this, every relay route's catch-all mapped both cases — an upstream
 * rejection and a genuinely internal failure (a dropped connection, a bug) —
 * to the same static "order relay failed" / "withdrawal relay failed" text.
 * A $10-minimum-order-size rejection and a dropped connection were
 * indistinguishable to the user; the second testnet walk (#789) read both as
 * the same opaque message an operator had to grep logs to tell apart.
 *
 * The reason originates at Hyperliquid rather than at a user, but it crosses
 * into an HTTP body and a UI string the same way the agent-approval reason
 * does, so it gets the same sanitization: control characters stripped, length
 * capped, and a generic fallback when nothing legible survives.
 */
const MAX_REASON_LENGTH = 240;

const GENERIC_REASON = 'the exchange rejected the request';

/** Control characters (log forging, terminal escapes) — dropped on the way out. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');

/**
 * An upstream rejection's message reduced to one safe line. Shared by every
 * relay route (via {@link RelayRejectionError}) so the truncation/stripping
 * rule lives in exactly one place rather than being re-implemented per call
 * site.
 */
export function sanitizeRelayRejectionReason(value: unknown): string {
  const raw =
    value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return GENERIC_REASON;
  return cleaned.length > MAX_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_REASON_LENGTH - 1)}…`
    : cleaned;
}

/**
 * The exchange's own verdict on a relayed order, cancel, modify or
 * withdrawal — distinct from a sign-ceremony failure or a genuinely internal
 * relay error. `HlClient` throws this in place of the SDK's `ApiRequestError`
 * so every other caller in this package, and every relay route in `apps/api`,
 * matches against a type local to `packages/core`.
 */
export class RelayRejectionError extends Error {
  readonly code = 'RELAY_REJECTED';
  /** The exchange's own rejection, sanitized for onward reporting. */
  readonly reason: string;
  /** The raw upstream response payload, when `cause` carried one (the SDK's
   * `ApiRequestError.response`) — e.g. a batch's full per-item statuses array,
   * not just the failing entry's message. Preserved so a caller inspecting a
   * partial-failure batch loses none of what the un-wrapped SDK error gave. */
  readonly response?: unknown;
  /** Declared rather than passed to `super`: this package targets ES2020,
   * whose `Error` constructor takes no options bag. The relay routes walk
   * this chain (`routes/trading.ts`/`routes/withdrawals.ts` § findCause). */
  readonly cause?: unknown;

  constructor(params: { cause: unknown }) {
    const reason = sanitizeRelayRejectionReason(params.cause);
    super(`the exchange rejected the relayed action: ${reason}`);
    this.name = 'RelayRejectionError';
    this.cause = params.cause;
    this.reason = reason;
    this.response =
      params.cause && typeof params.cause === 'object' && 'response' in params.cause
        ? (params.cause as { response: unknown }).response
        : undefined;
  }
}

/**
 * Phase 16 Epic B — the one place Hyperliquid's agent-name expiry suffix is
 * written and read.
 *
 * `approveAgent` has no `validUntil` field. The expiry an approval asks for is
 * carried **inside the name**, as the suffix ` valid_until <epoch ms>`, and the
 * pinned Hyperliquid SDK (v0.33.1,
 * `esm/api/exchange/_methods/approveAgent.js:19-25`) proves the exchange treats
 * it that way: it strips exactly `/ valid_until \d+$/` before applying the
 * 16-char name limit, so a suffixed name of any length still validates while
 * the base name is measured on its own.
 *
 * {@link AGENT_VALID_UNTIL_RE} is that regex, character for character, and
 * deliberately so — one space, the literal `valid_until`, one space, digits,
 * end of string. A looser one here (a `\s+`, a trailing-space tolerance, a case
 * fold) would let this module encode names the SDK does NOT strip, which are
 * then measured with the suffix attached and rejected on length, for a reason
 * the caller cannot see.
 *
 * **What the suffix means to Hyperliquid is not settled.** Whether it honours
 * the requested instant, clamps it to its own maximum, or ignores it entirely
 * is unmeasured until spike 16.1.1(d). This module encodes a REQUEST; nothing
 * that reads it may present the value as the resulting expiry.
 */

export const AGENT_VALID_UNTIL_RE = / valid_until \d+$/;

const VALID_UNTIL_PREFIX = ' valid_until ';

/**
 * `perps-api` + an expiry request → `perps-api valid_until 1790000000000`.
 *
 * A non-finite, non-integer or non-positive `validUntil` encodes nothing rather
 * than producing `valid_until NaN` — a name the SDK's strip does not match, so
 * it would be measured with the suffix attached and rejected on length.
 */
export function encodeAgentName(baseName: string, validUntil?: number): string {
  if (validUntil === undefined) return baseName;
  if (!Number.isSafeInteger(validUntil) || validUntil <= 0) return baseName;
  return `${baseName}${VALID_UNTIL_PREFIX}${validUntil}`;
}

/** The name without its expiry suffix — what `extraAgents` entries compare by. */
export function agentBaseName(name: string): string {
  return name.replace(AGENT_VALID_UNTIL_RE, '');
}

/**
 * The expiry an on-chain name ASKS for, or undefined when it carries none. Not
 * the agent's expiry: `ExtraAgent.validUntil` is what Hyperliquid reports back,
 * and the two may disagree (see the module note).
 */
export function agentNameValidUntil(name: string): number | undefined {
  const match = AGENT_VALID_UNTIL_RE.exec(name);
  if (!match) return undefined;
  return Number(match[0].slice(VALID_UNTIL_PREFIX.length));
}

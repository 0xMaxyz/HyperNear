/**
 * [Phase 16 · Epic B.0/B.1/B.4] The three agent names, the cited caps, and the
 * expiry suffix.
 *
 * The failures these prevent, in order:
 *
 *  - **a name collision silently evicting a live agent.** `approveAgent(addr,
 *    name)` replaces whoever holds `name`. If `PERPS_API_AGENT_NAME` ever
 *    equalled `PERPS_AGENT_NAME` or `PERPS_BACKUP_AGENT_NAME`, issuing an API
 *    key would take the user's browser session or their backup passkey
 *    off-chain — no error anywhere, just an account that stops signing. Nothing
 *    else in the codebase compares the three.
 *  - **a name the SDK will not accept.** The 16-char limit is applied to the
 *    base name; a name over it cannot clear a real `approveAgent` at all (the
 *    4.3.2 gate found this once already, with a 20-char name).
 *  - **an expiry suffix the SDK does not strip.** The pinned SDK's regex is
 *    exact. A suffix that misses it is measured WITH the suffix attached and
 *    rejected on length, from inside valibot, for a reason the caller cannot
 *    see. So the encoder is pinned against the SDK's own regex, verbatim.
 */
import { describe, expect, it } from 'vitest';

import {
  PERPS_AGENT_NAME,
  PERPS_API_AGENT_NAME,
  PERPS_BACKUP_AGENT_NAME,
  PERPS_MAX_AGENTS,
  PERPS_MAX_NAMED_AGENTS,
  PERPS_MAX_NAMED_AGENTS_PER_SUBACCOUNT,
  PERPS_MAX_UNNAMED_AGENTS,
  PERPS_MAX_AGENT_VALIDITY_DAYS,
  PERPS_MAX_AGENT_VALIDITY_MS,
  agentBaseName,
  agentNameValidUntil,
  encodeAgentName,
} from '../../src';

/**
 * The pinned Hyperliquid SDK's own strip (v0.33.1,
 * `esm/api/exchange/_methods/approveAgent.js:19-25`) — copied character for
 * character. If a dependency bump changes that regex, this copy is what makes
 * the encoder's disagreement with it a test failure rather than a production
 * rejection.
 */
const SDK_VALID_UNTIL_STRIP = / valid_until \d+$/;

/** The SDK's own check, restated: the BASE name is what must be ≤ 16. */
function sdkAcceptsName(name: string): boolean {
  return name.replace(SDK_VALID_UNTIL_STRIP, '').length <= 16;
}

describe('[16.B.1] the product’s three agent names are distinct', () => {
  it('gives the API-key agent a name that can never evict the browser or backup agent', () => {
    const names = [PERPS_AGENT_NAME, PERPS_BACKUP_AGENT_NAME, PERPS_API_AGENT_NAME];
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every name inside the 16-char limit the SDK enforces', () => {
    for (const name of [PERPS_AGENT_NAME, PERPS_BACKUP_AGENT_NAME, PERPS_API_AGENT_NAME]) {
      expect(sdkAcceptsName(name), `${name} would be refused before signing`).toBe(true);
    }
  });
});

describe('[16.B.0] the agent caps say WHICH cap they are', () => {
  it('keeps PERPS_MAX_AGENTS as an alias of the NAMED cap, so existing readers do not shift', () => {
    expect(PERPS_MAX_AGENTS).toBe(PERPS_MAX_NAMED_AGENTS);
  });

  it('carries the docs’ full set: 3 named + 1 unnamed per account, +2 named per subaccount', () => {
    expect(PERPS_MAX_NAMED_AGENTS).toBe(3);
    expect(PERPS_MAX_UNNAMED_AGENTS).toBe(1);
    expect(PERPS_MAX_NAMED_AGENTS_PER_SUBACCOUNT).toBe(2);
  });

  it('states the 180-day validity ceiling in both units, in agreement', () => {
    expect(PERPS_MAX_AGENT_VALIDITY_DAYS).toBe(180);
    expect(PERPS_MAX_AGENT_VALIDITY_MS).toBe(180 * 24 * 60 * 60 * 1000);
  });
});

describe('[16.B.4] the expiry suffix is exactly what the SDK strips', () => {
  it('produces a name the SDK accepts even when base + suffix exceeds 16 chars', () => {
    const encoded = encodeAgentName(PERPS_API_AGENT_NAME, 1_790_000_000_000);
    expect(encoded).toBe('perps-api valid_until 1790000000000');
    expect(encoded.length).toBeGreaterThan(16);
    expect(sdkAcceptsName(encoded)).toBe(true);
    expect(SDK_VALID_UNTIL_STRIP.test(encoded)).toBe(true);
  });

  it('encodes nothing when no expiry is requested', () => {
    expect(encodeAgentName(PERPS_API_AGENT_NAME)).toBe(PERPS_API_AGENT_NAME);
  });

  it('refuses to encode a value that would become a suffix the SDK cannot strip', () => {
    // `valid_until NaN` / `valid_until -1` / `valid_until 1.5` all miss the
    // `\d+$` and would take the whole string into the length check.
    for (const bad of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
      const encoded = encodeAgentName(PERPS_API_AGENT_NAME, bad);
      expect(encoded, `${bad} must not reach the wire`).toBe(PERPS_API_AGENT_NAME);
      expect(sdkAcceptsName(encoded)).toBe(true);
    }
  });

  it('reads the base name back, so ownership survives whichever name Hyperliquid echoes', () => {
    expect(agentBaseName('perps-api valid_until 1790000000000')).toBe(PERPS_API_AGENT_NAME);
    expect(agentBaseName(PERPS_API_AGENT_NAME)).toBe(PERPS_API_AGENT_NAME);
    // Not a suffix the SDK strips, so not one this may strip either — a name
    // that genuinely contains those characters is a different name.
    expect(agentBaseName('perps-api valid_until soon')).toBe('perps-api valid_until soon');
  });

  it('reports the expiry the NAME asked for, which is not the agent’s expiry', () => {
    expect(agentNameValidUntil('perps-api valid_until 1790000000000')).toBe(1_790_000_000_000);
    expect(agentNameValidUntil(PERPS_API_AGENT_NAME)).toBeUndefined();
  });
});

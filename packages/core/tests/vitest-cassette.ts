/**
 * VCR-style request/response fixtures for testnet integration tests
 * (docs/testing/test-setup.md § "Testnet integration cassettes"), adapted to
 * replay through the Epic 1.1.3 wrapper's transport-injection seam
 * (`HlTransport`) rather than raw `fetch` — this platform's CI/dev
 * environment has no direct egress to Hyperliquid (see CLAUDE.md
 * "Deployment Constraints"), so cassettes are hand-authored from
 * Hyperliquid's documented exchange-endpoint response shapes rather than
 * live-recorded, the same offline-and-reproducible spirit as the Epic 0.1
 * golden fixtures.
 *
 * A cassette is a JSON file under `tests/fixtures/cassettes/<name>.json`:
 * an array of entries, each matched by the outgoing request's `type` field —
 * nested under `action` for exchange requests, top-level for info requests.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HlApiEndpoint, HlTransport } from '../src/hl';

export interface CassetteEntry {
  /** The `action.type` field this entry replays a response for. */
  actionType: string;
  endpoint: HlApiEndpoint;
  response: unknown;
}

const CASSETTES_DIR = path.join(__dirname, 'fixtures', 'cassettes');

export function loadCassette(name: string): CassetteEntry[] {
  const cassettePath = path.join(CASSETTES_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(cassettePath, 'utf-8')) as CassetteEntry[];
}

export interface CassetteTransport {
  transport: HlTransport;
  requests: Array<{ endpoint: HlApiEndpoint; payload: Record<string, unknown> }>;
}

/** A stub `HlTransport` that replays a cassette instead of making a live HTTP call. */
export function createCassetteTransport(name: string): CassetteTransport {
  const entries = loadCassette(name);
  const requests: CassetteTransport['requests'] = [];

  const transport: HlTransport = {
    async request(endpoint, payload) {
      // JSON round-trip = exactly what would go over the wire.
      const wirePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      requests.push({ endpoint, payload: wirePayload });

      // Exchange requests carry `{ action: { type }, ... }`; info requests
      // carry `{ type, ... }` directly.
      const action = wirePayload.action as Record<string, unknown> | undefined;
      const requestType = action?.type ?? wirePayload.type;
      const entry = entries.find((e) => e.endpoint === endpoint && e.actionType === requestType);
      if (!entry) {
        throw new Error(
          `No cassette entry for ${endpoint} action "${String(requestType)}" in cassette "${name}"`
        );
      }
      return entry.response;
    },
  };

  return { transport, requests };
}

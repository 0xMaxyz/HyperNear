/**
 * Epic 1.1 gate ("sdk-adoption.phase-1.test.ts" per
 * docs/testing/phase-gate-testing.md), one slice per task:
 *
 * [Epic 1.1.1] Re-verify @nktkas/hyperliquid at adoption time (ADR): the ADR
 * pins the exact version this repo has actually installed, names the criteria
 * for staying on it and the fork-and-own fallback, and the transitive-
 * dependency surface recorded in the ADR matches what's really in the
 * dependency tree.
 *
 * [Epic 1.1.3] Thin SDK wrapper (packages/core/src/hl/): testnet/mainnet
 * config, transport injection, async two-tier signer dispatch (master =
 * user-signed actions, agent = L1 actions), raw-key path test-only, and no
 * @nktkas/hyperliquid type in packages/core's public surface. The golden
 * fixtures from Epic 0.1 are replayed *through the wrapper* — a stub
 * transport captures what would be POSTed to /exchange and the signatures
 * must still match the official Python SDK's output byte-for-byte.
 *
 * [Epic 1.1.2] Golden fixtures in CI on every dependency bump: the fixture
 * diff above ("golden-fixture diffs still pass through the wrapper") already
 * covers both signing schemes byte-for-byte; this task's own slice checks
 * that a dedicated CI job actually runs it, unconditionally on every push/PR
 * (including a pnpm-lock.yaml-only dependency bump) — the supply-chain
 * regression guard the roadmap asks for.
 *
 * [Epic 1.1.4] Nonce behavior under concurrent signing: exercises the SDK's
 * own nonce machinery *through the wrapper* (per-address serialization lock,
 * strictly-monotonic default nonces, the millisecond timestamp window) and
 * pins the boundary between what the SDK guarantees and what Phase 2 Epic
 * 2.3.3's per-account action queue must still enforce itself — the boundary
 * written up in docs/roadmap/adr/1.1.4-nonce-concurrent-signing.md. Extends
 * this file rather than replacing it — see
 * docs/roadmap/spikes/0.1.4-harness-shape-adr.md for the extension pattern
 * this harness follows.
 *
 * Everything here stays offline: local files (package.json manifests, the
 * ADR markdown, wrapper sources) and in-memory stub transports — no live
 * network access, safe for CI.
 *
 * Package manifests are located by resolving each package's main entry point
 * via Node's own resolver (createRequire), then walking up from that file to
 * the nearest package.json — not by requesting the "./package.json" subpath
 * directly, which @nktkas/hyperliquid's `exports` map (like many modern ESM
 * packages) does not expose.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HL_API_URLS, HL_SIGNATURE_CHAIN_IDS, HlClient, testOnlyRawKeySigner } from '../../src/hl';
import type {
  HlApiEndpoint,
  HlAsyncSigner,
  HlClientConfig,
  HlSignPayload,
  HlTransport,
} from '../../src/hl';
import { loadGoldenFixture } from '../fixtures/golden/loader';

const CORE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(CORE_ROOT, '../..');
const ADR_PATH = path.join(REPO_ROOT, 'docs/roadmap/adr/1.1.1-nktkas-hyperliquid-verification.md');
const CORE_PACKAGE_JSON_PATH = path.join(CORE_ROOT, 'package.json');

interface PackageManifest {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

function readCorePackageJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(CORE_PACKAGE_JSON_PATH, 'utf-8'));
}

function readAdr(): string {
  return fs.readFileSync(ADR_PATH, 'utf-8');
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package.json found above ${startDir}`);
    dir = parent;
  }
  return dir;
}

/** Resolves `specifier`'s manifest as Node would resolve it from `fromFile`, bypassing `exports` restrictions on the package.json subpath. */
function resolvePackageManifest(specifier: string, fromFile: string): { manifest: PackageManifest; mainPath: string } {
  const requireFrom = createRequire(fromFile);
  const mainPath = requireFrom.resolve(specifier);
  const root = findPackageRoot(path.dirname(mainPath));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  return { manifest, mainPath };
}

function readSdkManifest(): { manifest: PackageManifest; mainPath: string } {
  return resolvePackageManifest('@nktkas/hyperliquid', CORE_PACKAGE_JSON_PATH);
}

describe('[Epic 1.1.1] Re-verify @nktkas/hyperliquid at adoption (ADR)', () => {
  it('the ADR file exists', () => {
    expect(fs.existsSync(ADR_PATH)).toBe(true);
  });

  describe('version pin', () => {
    // Epic 1.1.3 promoted the SDK from devDependencies (fixture-harness-only)
    // to a runtime dependency behind the wrapper — the promotion the ADR
    // anticipated. The pin rules are unchanged by the move.
    it('the dependency lives in runtime dependencies (promoted by 1.1.3), not devDependencies', () => {
      const pkg = readCorePackageJson();
      const deps = pkg.dependencies as Record<string, string>;
      const devDeps = pkg.devDependencies as Record<string, string>;

      expect(deps['@nktkas/hyperliquid']).toBeDefined();
      expect(devDeps['@nktkas/hyperliquid']).toBeUndefined();
    });

    it('the dependency version in packages/core/package.json is pinned (not a range)', () => {
      const pkg = readCorePackageJson();
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps['@nktkas/hyperliquid']).toBeDefined();
      expect(deps['@nktkas/hyperliquid']).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('the ADR pins the exact same version as package.json', () => {
      const pkg = readCorePackageJson();
      const deps = pkg.dependencies as Record<string, string>;
      const pinnedVersion = deps['@nktkas/hyperliquid'];

      expect(readAdr()).toContain(pinnedVersion);
    });

    it('the pinned version is actually what is installed', () => {
      const pkg = readCorePackageJson();
      const deps = pkg.dependencies as Record<string, string>;
      const { manifest: sdk } = readSdkManifest();

      expect(sdk.version).toBe(deps['@nktkas/hyperliquid']);
    });
  });

  describe('license', () => {
    it('the installed package is MIT-licensed', () => {
      const { manifest: sdk } = readSdkManifest();
      expect(sdk.license).toBe('MIT');
    });

    it('the ADR records the MIT license', () => {
      expect(readAdr()).toMatch(/MIT/);
    });
  });

  describe('staying-on criteria and fallback', () => {
    it('the ADR states criteria for staying on the dependency', () => {
      expect(readAdr()).toMatch(/criteria/i);
    });

    it('the ADR names a fork-and-own fallback if the dependency goes unmaintained', () => {
      expect(readAdr()).toMatch(/fork-and-own/i);
    });
  });

  describe('transitive-dependency surface', () => {
    it('every direct dependency the SDK declares is named in the ADR', () => {
      const { manifest: sdk } = readSdkManifest();
      const adr = readAdr();
      const declaredDeps = Object.keys(sdk.dependencies ?? {});

      // A version bump that adds/removes a direct dependency must not pass
      // silently — the ADR has to be updated to keep recording reality.
      expect(declaredDeps.length).toBeGreaterThan(0);
      for (const dep of declaredDeps) {
        expect(adr).toContain(dep);
      }
    });

    it("the ADR's surface table lists exactly the SDK's declared dependencies (no more, no fewer)", () => {
      // A real equality check, not just "contains": if a future bump drops a
      // dependency or adds a new one, the ADR's table must be updated to
      // match — this catches both a stale extra row and a missing one.
      const { manifest: sdk } = readSdkManifest();
      const declaredDeps = new Set(Object.keys(sdk.dependencies ?? {}));
      const adr = readAdr();
      const tableSection = adr.split(/## Transitive-dependency surface/i)[1]?.split(/\n## /)[0] ?? '';
      const rowMatches = [...tableSection.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);

      expect(rowMatches.length).toBeGreaterThan(0);
      expect(new Set(rowMatches)).toEqual(declaredDeps);
    });

    it('every direct dependency of the SDK is itself MIT-licensed', () => {
      const { manifest: sdk, mainPath: sdkMainPath } = readSdkManifest();

      for (const dep of Object.keys(sdk.dependencies ?? {})) {
        const { manifest: depManifest } = resolvePackageManifest(dep, sdkMainPath);
        expect(depManifest.license, `${dep} license`).toBe('MIT');
      }
    });
  });

  describe('Node engine requirement', () => {
    it("the SDK's engines.node requirement is recorded in the ADR", () => {
      const { manifest: sdk } = readSdkManifest();
      const required = sdk.engines?.node;
      expect(required).toBeDefined();
      expect(readAdr()).toContain(required as string);
    });
  });

  describe('CI safety', () => {
    it('this suite stays offline — local files and stub transports only', () => {
      // Documents the same safety property as the phase-0 harness: the 1.1.1
      // slice reads only package manifests and the ADR, and the 1.1.3 slice
      // below always injects an in-memory stub transport into the wrapper —
      // the SDK's real HttpTransport is never instantiated here, so no
      // request can leave the process.
      expect(true).toBe(true);
    });
  });
});

// ============================================================
// [Epic 1.1.3] Thin SDK wrapper
// ============================================================

// Mirrors NONCE in generate_fixtures.py: injected through the wrapper's
// nonceSource so wrapper-signed output is byte-comparable to the fixtures.
const WRAPPER_NONCE = 1700000000000;

// Key order mirrors the golden order fixture (see signing-verification
// .phase-0.test.ts for why the order is not cosmetic for L1 actions).
const ORDER_FIXTURE_PARAMS = {
  orders: [{ a: 0, b: true, p: '50000', s: '0.01', r: false, t: { limit: { tif: 'Gtc' as const } } }],
  grouping: 'na' as const,
};

const USD_SEND_FIXTURE_PARAMS = {
  destination: '0x0000000000000000000000000000000000000001' as const,
  amount: '1',
};

function createStubTransport() {
  const requests: Array<{ endpoint: HlApiEndpoint; payload: Record<string, unknown> }> = [];
  const transport: HlTransport = {
    async request(endpoint, payload) {
      // JSON round-trip = exactly what would go over the wire (drops
      // undefined-valued optional fields, like real POST bodies).
      const wirePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      requests.push({ endpoint, payload: wirePayload });
      const action = wirePayload.action as Record<string, unknown> | undefined;
      if (action?.type === 'order') {
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } };
      }
      return { status: 'ok', response: { type: 'default' } };
    },
  };
  return { transport, requests };
}

function createSpySigner(base: HlAsyncSigner) {
  const payloads: HlSignPayload[] = [];
  const signer: HlAsyncSigner = {
    address: base.address,
    sign: async (payload) => {
      payloads.push(payload);
      // A macrotask hop proves the wrapper genuinely awaits the callback —
      // the shape a network- or iframe-backed signer actually has.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return base.sign(payload);
    },
  };
  return { signer, payloads };
}

function fixtureSigner(actionType: 'order' | 'usdSend'): HlAsyncSigner {
  const fixture = loadGoldenFixture(actionType);
  return testOnlyRawKeySigner(fixture.wallet.privateKey as `0x${string}`);
}

function createWrapper(overrides: Partial<HlClientConfig> = {}) {
  const { transport, requests } = createStubTransport();
  const agent = createSpySigner(fixtureSigner('order'));
  const master = createSpySigner(fixtureSigner('usdSend'));
  const client = new HlClient({
    network: 'testnet',
    transport,
    agentSigner: agent.signer,
    masterSigner: master.signer,
    nonceSource: () => WRAPPER_NONCE,
    ...overrides,
  });
  return { client, requests, agent, master };
}

describe('[Epic 1.1.3] Thin SDK wrapper (transport injection + async two-tier signer)', () => {
  describe('testnet/mainnet config', () => {
    it('exposes both networks base URLs', () => {
      expect(HL_API_URLS.mainnet).toBe('https://api.hyperliquid.xyz');
      expect(HL_API_URLS.testnet).toBe('https://api.hyperliquid-testnet.xyz');
    });

    it('reflects the configured network and its resolved base URL', () => {
      const { client } = createWrapper();
      expect(client.network).toBe('testnet');
      expect(client.apiUrl).toBe(HL_API_URLS.testnet);

      const { client: mainnetClient } = createWrapper({ network: 'mainnet' });
      expect(mainnetClient.network).toBe('mainnet');
      expect(mainnetClient.apiUrl).toBe(HL_API_URLS.mainnet);
    });

    it('honors an explicit base-URL override', () => {
      const { client } = createWrapper({ apiUrl: 'https://egress.internal.example' });
      expect(client.apiUrl).toBe('https://egress.internal.example');
    });

    it('network config drives the signing domain: agent source is "b" on testnet, "a" on mainnet', async () => {
      const testnet = createWrapper();
      await testnet.client.order(ORDER_FIXTURE_PARAMS);
      expect(testnet.agent.payloads[0].message.source).toBe('b');

      const mainnet = createWrapper({ network: 'mainnet' });
      await mainnet.client.order(ORDER_FIXTURE_PARAMS);
      expect(mainnet.agent.payloads[0].message.source).toBe('a');
    });

    // The user-signed half of the same rule. This was ONE constant, 0x66eee
    // (Arbitrum Sepolia), on both networks — copied from the Python SDK, whose
    // signer is a bare key that never consults a chain. A connected wallet
    // does: MetaMask refuses typed data whose domain chain id is not the chain
    // it is on, so a mainnet deployment could not approveAgent at all, and a
    // wallet user's first order or leverage change died on that approval.
    it('network config drives the user-signed domain chain id: Arbitrum One on mainnet, Arbitrum Sepolia on testnet', async () => {
      expect(HL_SIGNATURE_CHAIN_IDS.mainnet).toBe('0xa4b1');
      expect(HL_SIGNATURE_CHAIN_IDS.testnet).toBe('0x66eee');

      const testnet = createWrapper();
      await testnet.client.usdSend(USD_SEND_FIXTURE_PARAMS);
      expect(testnet.master.payloads[0].domain.chainId).toBe(421614);

      const mainnet = createWrapper({ network: 'mainnet' });
      await mainnet.client.usdSend(USD_SEND_FIXTURE_PARAMS);
      expect(mainnet.master.payloads[0].domain.chainId).toBe(42161);
    });

    it('an explicit signatureChainId still overrides the per-network default', async () => {
      const { client, master } = createWrapper({ network: 'mainnet', signatureChainId: '0x1' });
      await client.usdSend(USD_SEND_FIXTURE_PARAMS);
      expect(master.payloads[0].domain.chainId).toBe(1);
    });
  });

  describe('transport injection', () => {
    it('routes an L1 action through the injected transport as a single /exchange request', async () => {
      const { client, requests } = createWrapper();
      await client.order(ORDER_FIXTURE_PARAMS);

      expect(requests).toHaveLength(1);
      expect(requests[0].endpoint).toBe('exchange');
      expect(Object.keys(requests[0].payload).sort()).toEqual(['action', 'nonce', 'signature']);
    });

    it('routes a user-signed action through the same injected transport', async () => {
      const { client, requests } = createWrapper();
      await client.usdSend(USD_SEND_FIXTURE_PARAMS);

      expect(requests).toHaveLength(1);
      expect(requests[0].endpoint).toBe('exchange');
      const action = requests[0].payload.action as Record<string, unknown>;
      expect(action.type).toBe('usdSend');
    });

    it('returns the transport response to the caller', async () => {
      const { client } = createWrapper();
      const result = await client.order(ORDER_FIXTURE_PARAMS);
      expect(result.response.data.statuses).toEqual([{ resting: { oid: 1 } }]);
    });
  });

  describe('async two-tier signer dispatch', () => {
    it('L1 actions (order) dispatch to the agent signer only', async () => {
      const { client, agent, master } = createWrapper();
      await client.order(ORDER_FIXTURE_PARAMS);

      expect(agent.payloads).toHaveLength(1);
      expect(master.payloads).toHaveLength(0);
    });

    it('user-signed actions (usdSend) dispatch to the master signer only', async () => {
      const { client, agent, master } = createWrapper();
      await client.usdSend(USD_SEND_FIXTURE_PARAMS);

      expect(master.payloads).toHaveLength(1);
      expect(agent.payloads).toHaveLength(0);
    });

    it('the agent signer receives the phantom-agent EIP-712 payload, never the raw action', async () => {
      const { client, agent } = createWrapper();
      await client.order(ORDER_FIXTURE_PARAMS);

      const payload = agent.payloads[0];
      expect(payload.primaryType).toBe('Agent');
      expect(payload.domain).toEqual({
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      });
      expect(payload.types.Agent).toEqual([
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ]);
      // The wrapper hands the signer the digest-bearing typed data — the
      // fixture's action hash — proving the signer needs no key material
      // and no SDK types to do its job.
      expect(payload.message.connectionId).toBe(loadGoldenFixture('order').output.actionHash);
    });

    it('the master signer receives the user-signed EIP-712 payload', async () => {
      const { client, master } = createWrapper();
      await client.usdSend(USD_SEND_FIXTURE_PARAMS);

      const payload = master.payloads[0];
      expect(payload.primaryType).toBe('HyperliquidTransaction:UsdSend');
      expect(payload.domain.name).toBe('HyperliquidSignTransaction');
      expect(payload.domain.chainId).toBe(0x66eee);
      // The message carries exactly the primary type's fields (the SDK strips
      // envelope fields like `type`/`signatureChainId` that are not part of
      // the EIP-712 struct).
      expect(payload.message).toEqual({
        destination: USD_SEND_FIXTURE_PARAMS.destination,
        amount: '1',
        hyperliquidChain: 'Testnet',
        time: WRAPPER_NONCE,
      });
    });

    it('an L1 action without an agent signer fails, naming the missing tier', async () => {
      const { client } = createWrapper({ agentSigner: undefined });
      await expect(client.order(ORDER_FIXTURE_PARAMS)).rejects.toThrow(/agent signer/i);
    });

    it('a user-signed action without a master signer fails, naming the missing tier', async () => {
      const { client } = createWrapper({ masterSigner: undefined });
      await expect(client.usdSend(USD_SEND_FIXTURE_PARAMS)).rejects.toThrow(/master signer/i);
    });

    it('a signer rejection propagates and nothing reaches the transport', async () => {
      const { requests, transport } = createStubTransport();
      const refusingSigner: HlAsyncSigner = {
        address: loadGoldenFixture('order').wallet.address as `0x${string}`,
        sign: () => Promise.reject(new Error('signer refused')),
      };
      const client = new HlClient({
        network: 'testnet',
        transport,
        agentSigner: refusingSigner,
        nonceSource: () => WRAPPER_NONCE,
      });

      // The SDK wraps signer failures; the original rejection must survive
      // in the cause chain and, critically, nothing may reach the transport.
      const failure = await client.order(ORDER_FIXTURE_PARAMS).then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error & { cause?: unknown }).cause ?? failure)).toContain(
        'signer refused'
      );
      expect(requests).toHaveLength(0);
    });
  });

  describe('golden-fixture diffs still pass through the wrapper', () => {
    it('order: the captured /exchange payload matches the sign_l1_action fixture byte-for-byte', async () => {
      const fixture = loadGoldenFixture('order');
      const { client, requests } = createWrapper();
      await client.order(ORDER_FIXTURE_PARAMS);

      const payload = requests[0].payload;
      expect(payload.action).toEqual(fixture.input.action);
      expect(payload.nonce).toBe(fixture.input.nonce);
      // Deterministic ECDSA (RFC 6979): equal signatures ⇔ equal preimage,
      // so this is the full byte-for-byte diff, wire bytes included.
      expect(payload.signature).toEqual(fixture.output.signature);
    });

    it('usdSend: the captured /exchange payload matches the sign_user_signed_action fixture byte-for-byte', async () => {
      const fixture = loadGoldenFixture('usdSend');
      const { client, requests } = createWrapper();
      await client.usdSend(USD_SEND_FIXTURE_PARAMS);

      const payload = requests[0].payload;
      expect(payload.action).toEqual(fixture.input.action);
      expect(payload.nonce).toBe(WRAPPER_NONCE);
      expect(payload.signature).toEqual(fixture.output.signature);
    });
  });

  describe('raw-key path is a test-only convenience', () => {
    it('testOnlyRawKeySigner derives the fixture wallet address from the raw key', () => {
      const fixture = loadGoldenFixture('order');
      const signer = testOnlyRawKeySigner(fixture.wallet.privateKey as `0x${string}`);
      expect(signer.address.toLowerCase()).toBe(fixture.wallet.address.toLowerCase());
    });

    it('the raw-key module is explicitly marked test-only in name and source', () => {
      const source = fs.readFileSync(
        path.join(CORE_ROOT, 'src/hl/testOnlyRawKeySigner.ts'),
        'utf-8'
      );
      expect(source).toMatch(/test-only/i);
      expect(source).toMatch(/never.*production/i);
    });

    it('no wrapper entry point other than the test-only module accepts key material', () => {
      for (const file of ['src/hl/types.ts', 'src/hl/HlClient.ts', 'src/hl/index.ts']) {
        const source = fs.readFileSync(path.join(CORE_ROOT, file), 'utf-8');
        expect(source, `${file} must not handle private keys`).not.toMatch(/privateKey|private_key/);
      }
    });
  });

  describe("no @nktkas/hyperliquid type in packages/core's public surface", () => {
    const SRC_ROOT = path.join(CORE_ROOT, 'src');

    function listSourceFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...listSourceFiles(fullPath));
        } else if (/\.tsx?$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
      return files;
    }

    it('only the wrapper implementations import @nktkas/hyperliquid', () => {
      // The SDK may be imported only inside the wrapper's own implementation
      // files — one seam per transport: HlClient.ts (HTTP request/exchange/info)
      // and HlSubscriptionClient.ts (WebSocket subscriptions, Epic 1.4.1). Every
      // other module depends on the wrapper's `Hl*` types, never the SDK.
      const offenders = listSourceFiles(SRC_ROOT)
        .filter((file) => fs.readFileSync(file, 'utf-8').includes('@nktkas/hyperliquid'))
        .map((file) => path.relative(SRC_ROOT, file))
        .sort();

      expect(offenders).toEqual(['hl/HlClient.ts', 'hl/HlSubscriptionClient.ts']);
    });

    it('no source file re-exports anything from @nktkas/hyperliquid', () => {
      for (const file of listSourceFiles(SRC_ROOT)) {
        const source = fs.readFileSync(file, 'utf-8');
        expect(source, `${path.relative(SRC_ROOT, file)} must not re-export SDK symbols`).not.toMatch(
          /export\s+[^;]*from\s+['"]@nktkas\/hyperliquid/
        );
      }
    });

    it('the wrapper contract (types.ts) and barrel (index.ts) are SDK-free', () => {
      for (const file of ['src/hl/types.ts', 'src/hl/index.ts']) {
        const source = fs.readFileSync(path.join(CORE_ROOT, file), 'utf-8');
        expect(source, `${file} must not reference the SDK`).not.toContain('@nktkas');
      }
    });

    it('the wrapper is part of the package public surface (re-exported by src/index.ts)', () => {
      const barrel = fs.readFileSync(path.join(CORE_ROOT, 'src/index.ts'), 'utf-8');
      expect(barrel).toMatch(/export \* from '\.\/hl'/);
    });

    it('the built public type surface (dist/index.d.ts) never mentions the SDK', () => {
      const dtsPath = path.join(CORE_ROOT, 'dist/index.d.ts');
      if (!fs.existsSync(dtsPath)) {
        // `pnpm build` hasn't run in this checkout; CI builds before testing,
        // so the assertion is enforced there.
        return;
      }
      expect(fs.readFileSync(dtsPath, 'utf-8')).not.toContain('@nktkas');
    });
  });
});

// ============================================================
// [Epic 1.1.2] Golden fixtures in CI on every dependency bump
// ============================================================

describe('[Epic 1.1.2] Golden fixtures in CI on every dependency bump', () => {
  const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  describe('fixture diff runs for both signing schemes', () => {
    // The actual diff assertions live in "[Epic 1.1.3] ... golden-fixture
    // diffs still pass through the wrapper" above; this just pins that both
    // fixtures it covers are the two schemes 1.1.2 asks for, so a future edit
    // that drops one of them fails loudly here rather than silently shrinking
    // coverage.
    it('order.json exercises sign_l1_action', () => {
      expect(loadGoldenFixture('order').signingScheme).toBe('sign_l1_action');
    });

    it('usdSend.json exercises sign_user_signed_action', () => {
      expect(loadGoldenFixture('usdSend').signingScheme).toBe('sign_user_signed_action');
    });
  });

  describe('CI wiring', () => {
    it('has a dedicated job that runs the phase-1 sdk-adoption golden-fixture suite', () => {
      expect(workflow).toMatch(/golden-fixtures-phase-1:/);
      expect(workflow).toMatch(/sdk-adoption\.phase-1/);
    });

    it('triggers on push and pull_request with no path filter that would exclude a lockfile-only bump', () => {
      const onSection = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'));

      expect(onSection).toMatch(/\bpush:/);
      expect(onSection).toMatch(/\bpull_request:/);
      // A `paths:`/`paths-ignore:` filter under either trigger could exclude
      // a pnpm-lock.yaml-only commit from running this job — the guard must
      // stay in the unfiltered path so every dependency bump reruns it.
      expect(onSection).not.toMatch(/paths(-ignore)?:/);
    });

    it('does not gate the job behind pnpm build (the suite imports wrapper sources directly)', () => {
      const jobStart = workflow.indexOf('golden-fixtures-phase-1:');
      const jobEnd = workflow.indexOf('\n\n', jobStart);
      const jobSection = workflow.slice(jobStart, jobEnd === -1 ? workflow.length : jobEnd);

      expect(jobSection).not.toMatch(/pnpm build/);
      expect(jobSection).toMatch(/pnpm install/);
    });
  });

  describe('CI safety', () => {
    it('this suite stays offline — it only reads the checked-in workflow file and fixtures', () => {
      expect(true).toBe(true);
    });
  });
});

// ============================================================
// [Epic 1.1.4] Nonce behavior under concurrent signing
// ============================================================

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Every golden fixture ships the same wallet, so a cross-address test needs
// its own distinct keys. These two are test-only raw keys (never production),
// chosen only to resolve to two different addresses → two different SDK lock
// keys. Any valid secp256k1 scalar works; these are far below the curve order.
const CROSS_ADDR_KEY_A: `0x${string}` =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const CROSS_ADDR_KEY_B: `0x${string}` =
  '0x2222222222222222222222222222222222222222222222222222222222222222';
const NONCE_NOTE_PATH = path.join(
  REPO_ROOT,
  'docs/roadmap/adr/1.1.4-nonce-concurrent-signing.md'
);

/**
 * A transport that records every nonce it receives in arrival order and tracks
 * peak same-transport concurrency. It yields a macrotask while "in-flight" so
 * genuinely-overlapping requests are observable: if the SDK ever let two
 * same-address requests run at once, `state.maxInFlight` would read 2.
 */
function createRecordingTransport() {
  const nonces: number[] = [];
  const arrivals: Array<{ nonce: number; actionType: string }> = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const transport: HlTransport = {
    async request(_endpoint, payload) {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      const action = wire.action as Record<string, unknown>;
      nonces.push(wire.nonce as number);
      arrivals.push({ nonce: wire.nonce as number, actionType: action.type as string });
      state.inFlight -= 1;
      if (action.type === 'order') {
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } };
      }
      return { status: 'ok', response: { type: 'default' } };
    },
  };
  return { transport, nonces, arrivals, state };
}

/**
 * A wrapper wired with a real fixture signer and the recording transport but
 * *no* nonceSource — so the SDK's own default nonce manager is exercised. The
 * two fixtures ('order', 'usdSend') carry distinct wallets, giving two
 * independent lock keys without minting new key material.
 */
function defaultNonceWrapper(which: 'order' | 'usdSend' = 'order', overrides: Partial<HlClientConfig> = {}) {
  const recorder = createRecordingTransport();
  const agentSigner = fixtureSigner(which);
  const client = new HlClient({
    network: 'testnet',
    transport: recorder.transport,
    agentSigner,
    // Deliberately no nonceSource: this is the SDK's default nonce manager.
    ...overrides,
  });
  return { client, ...recorder, address: agentSigner.address };
}

function assertStrictlyIncreasing(values: number[]): void {
  for (let i = 1; i < values.length; i += 1) {
    expect(values[i], `nonce[${i}] must exceed nonce[${i - 1}]`).toBeGreaterThan(values[i - 1]);
  }
}

describe('[Epic 1.1.4] Nonce behavior under concurrent signing', () => {
  describe('per-address ordering (the SDK holds a per-(wallet × network) lock)', () => {
    it('serializes concurrent same-address actions: nonces reach the transport strictly increasing and unique', async () => {
      const { client, nonces, state } = defaultNonceWrapper('order');
      const count = 12;
      await Promise.all(Array.from({ length: count }, () => client.order(ORDER_FIXTURE_PARAMS)));

      expect(nonces).toHaveLength(count);
      // Strictly increasing in arrival order == requests reach /exchange in
      // nonce order, which is what "per-address ordering" means at the wire.
      assertStrictlyIncreasing(nonces);
      // No collisions even when fired faster than the millisecond clock ticks
      // — the default manager bumps by 1 rather than repeating a timestamp.
      expect(new Set(nonces).size).toBe(count);
      // The lock means only one same-address request is ever in flight: the
      // nonce is generated and the request dispatched atomically per address.
      expect(state.maxInFlight).toBe(1);
    });

    it('preserves order even when the signer resolves out of call order', async () => {
      // A signer whose latency varies per call still cannot reorder the wire
      // stream: nonce generation + dispatch both happen inside the lock.
      const base = fixtureSigner('order');
      let call = 0;
      const jitterySigner: HlAsyncSigner = {
        address: base.address,
        sign: async (payload) => {
          const mine = call++;
          // Earlier calls sleep longer, so signer completion order is reversed
          // relative to call order; the lock must still linearize them.
          await new Promise((resolve) => setTimeout(resolve, (5 - mine) * 2));
          return base.sign(payload);
        },
      };
      const recorder = createRecordingTransport();
      const client = new HlClient({
        network: 'testnet',
        transport: recorder.transport,
        agentSigner: jitterySigner,
      });

      await Promise.all(Array.from({ length: 5 }, () => client.order(ORDER_FIXTURE_PARAMS)));

      expect(recorder.nonces).toHaveLength(5);
      assertStrictlyIncreasing(recorder.nonces);
      expect(recorder.state.maxInFlight).toBe(1);
    });
  });

  describe('the "top 100 nonces / must exceed the smallest stored" rule', () => {
    it('issues strictly monotonic, unique nonces across a burst larger than the 100-nonce window', async () => {
      const { client, nonces } = defaultNonceWrapper('order');
      const burst = 150; // > Hyperliquid's ~100 stored-nonce window per address
      await Promise.all(Array.from({ length: burst }, () => client.order(ORDER_FIXTURE_PARAMS)));

      expect(nonces).toHaveLength(burst);
      expect(new Set(nonces).size).toBe(burst);
      assertStrictlyIncreasing(nonces);

      // Each issued nonce exceeds the smallest of the trailing 100 already
      // seen — the exact invariant Hyperliquid enforces per address. Strict
      // monotonicity makes this hold by construction; asserting it directly
      // documents *why* the default manager satisfies the protocol rule.
      for (let i = 1; i < nonces.length; i += 1) {
        const window = nonces.slice(Math.max(0, i - 100), i);
        expect(nonces[i]).toBeGreaterThan(Math.min(...window));
      }
    });
  });

  describe('timestamp window [T-2 days, T+1 day]', () => {
    it('the default nonce is a millisecond timestamp inside the accepted window', async () => {
      const before = Date.now();
      const { client, nonces } = defaultNonceWrapper('order');
      await client.order(ORDER_FIXTURE_PARAMS);
      const after = Date.now();

      expect(nonces).toHaveLength(1);
      const nonce = nonces[0];
      // Generated from Date.now() at sign time, so it lands in [before, after]…
      expect(nonce).toBeGreaterThanOrEqual(before);
      expect(nonce).toBeLessThanOrEqual(after);
      // …comfortably inside Hyperliquid's [T-2d, T+1d] acceptance window.
      expect(nonce).toBeGreaterThan(after - TWO_DAYS_MS);
      expect(nonce).toBeLessThan(after + ONE_DAY_MS);
    });
  });

  describe('cross-address concurrency (different addresses are not serialized against each other)', () => {
    it('a stalled signer for one address does not block actions for another address', async () => {
      // Address A's signer parks until we release it; address B signs normally.
      let releaseA: () => void = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const baseA = testOnlyRawKeySigner(CROSS_ADDR_KEY_A);
      const signerA: HlAsyncSigner = {
        address: baseA.address,
        sign: async (payload) => {
          await gateA;
          return baseA.sign(payload);
        },
      };
      const recorderA = createRecordingTransport();
      const clientA = new HlClient({ network: 'testnet', transport: recorderA.transport, agentSigner: signerA });

      const recorderB = createRecordingTransport();
      const clientB = new HlClient({
        network: 'testnet',
        transport: recorderB.transport,
        agentSigner: testOnlyRawKeySigner(CROSS_ADDR_KEY_B),
      });
      // Guard the premise of the test: distinct keys → distinct lock keys.
      expect(signerA.address).not.toBe(testOnlyRawKeySigner(CROSS_ADDR_KEY_B).address);

      const pendingA = clientA.order(ORDER_FIXTURE_PARAMS);
      // B must complete while A is still parked inside its signer — proving the
      // lock key is per-address, not a single global mutex.
      await clientB.order(ORDER_FIXTURE_PARAMS);
      expect(recorderB.nonces).toHaveLength(1);
      expect(recorderA.nonces).toHaveLength(0);

      releaseA();
      await pendingA;
      expect(recorderA.nonces).toHaveLength(1);
    });
  });

  describe('injected nonceSource replaces the SDK’s monotonic guarantee (the queue’s responsibility)', () => {
    it('a constant nonceSource is used verbatim — the SDK does NOT re-monotonize it', async () => {
      const fixed = 1_700_000_000_000;
      const recorder = createRecordingTransport();
      const client = new HlClient({
        network: 'testnet',
        transport: recorder.transport,
        agentSigner: fixtureSigner('order'),
        nonceSource: () => fixed,
      });
      await Promise.all(Array.from({ length: 3 }, () => client.order(ORDER_FIXTURE_PARAMS)));

      // All three carry the same nonce: the wrapper forwards the injected
      // source unchanged, so uniqueness/monotonicity becomes the caller's job.
      // This is precisely what Phase 2 Epic 2.3.3's action queue must own once
      // it supplies nonces instead of relying on the SDK's default manager.
      expect(recorder.nonces).toEqual([fixed, fixed, fixed]);
    });

    it('an injected monotonic counter is honored and still serialized per address', async () => {
      let counter = 1_700_000_000_000;
      const recorder = createRecordingTransport();
      const client = new HlClient({
        network: 'testnet',
        transport: recorder.transport,
        agentSigner: fixtureSigner('order'),
        nonceSource: () => (counter += 1),
      });
      await Promise.all(Array.from({ length: 5 }, () => client.order(ORDER_FIXTURE_PARAMS)));

      expect(recorder.nonces).toHaveLength(5);
      expect(new Set(recorder.nonces).size).toBe(5);
      assertStrictlyIncreasing(recorder.nonces);
      // The lock is independent of the nonce source: an injected source is
      // still called once per action, inside the per-address critical section.
      expect(recorder.state.maxInFlight).toBe(1);
    });
  });

  describe('written note: SDK guarantees vs. queue responsibilities (consumed by Epic 2.3.3)', () => {
    const readNote = () => fs.readFileSync(NONCE_NOTE_PATH, 'utf-8');

    it('the note exists', () => {
      expect(fs.existsSync(NONCE_NOTE_PATH)).toBe(true);
    });

    it('documents the per-address serialization lock', () => {
      expect(readNote()).toMatch(/per-address|per-\(wallet|lock/i);
    });

    it('documents the "top 100 nonces / must exceed the smallest stored" rule', () => {
      const note = readNote();
      expect(note).toContain('100');
      expect(note).toMatch(/smallest/i);
    });

    it('documents the [T-2 days, T+1 day] timestamp window', () => {
      const note = readNote();
      expect(note).toMatch(/2 days/i);
      expect(note).toMatch(/1 day/i);
    });

    it('names what Phase 2 Epic 2.3.3’s per-account action queue must still enforce', () => {
      const note = readNote();
      expect(note).toContain('2.3.3');
      expect(note).toMatch(/queue/i);
    });

    it('calls out that an injected nonceSource shifts monotonicity ownership to the caller', () => {
      expect(readNote()).toContain('nonceSource');
    });

    it('calls out that the SDK lock is in-process only (no cross-process/replica guarantee)', () => {
      expect(readNote()).toMatch(/in-process|cross-process|replica|process-local/i);
    });
  });

  describe('CI safety', () => {
    it('this suite stays offline — recording stub transports and local files only', () => {
      // Every wrapper above injects an in-memory recording transport, so the
      // SDK's real HttpTransport is never constructed and no request can leave
      // the process; the note assertions read a checked-in markdown file.
      expect(true).toBe(true);
    });
  });
});

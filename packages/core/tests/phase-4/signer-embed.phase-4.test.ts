/**
 * Phase 4 — Epic 4.1.4: package the signer for uniform, host-agnostic
 * embedding.
 *
 * Two things are pinned here, matching the task's acceptance criteria:
 *
 *  1. **A single embed entry point** (`embedSigner`) that any host consumes
 *     the same way — mount the cross-origin frame with the WebAuthn
 *     delegation, connect the hl-signer/v2 client, await the `ready`
 *     handshake. apps/web is host #1 (apps/web/src/signer-host-entry.ts); the
 *     `secondMinimalHost` in this file is host #2, driving the same signer
 *     through the same entry point with a different DOM seam and no bespoke
 *     wiring.
 *
 *  2. **The RPC contract is the stable interface an alternative signer would
 *     implement.** A reusable conformance suite (`runSignerContract`) runs
 *     against the real browser signer (`attachSignerRpc`) *and* against an
 *     alternative signer (`attachAltSigner`, fixed keys — a stand-in for the
 *     reserved MPC path) that presents the identical message contract with a
 *     different backend. Both pass, driven by the exact same `embedSigner`
 *     host client — proving the shape could front an alternative signer with
 *     no host changes (docs/security/signer-rpc-contract.md).
 *
 * The boundary is a faithful in-process model of two cross-origin windows —
 * every message is structured-cloned, stamped with the sender's origin, and
 * dropped when the sender's targetOrigin does not match the receiver.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { hashTypedData, recoverAddress, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  attachSignerRpc,
  browserSignerEmbedHost,
  createKeyBackupFile,
  deriveSigningKey,
  embedSigner,
  parseKeyBackup,
  prfSalt,
  recoverSignerFromBackup,
  sanitizeBoundaryError,
  signerFrameAllow,
  signerFrameSrc,
  DEFAULT_SIGNER_PATH,
  MIN_EXPORT_PASSPHRASE_LENGTH,
  SIGNER_RPC_ERRORS,
  SIGNER_RPC_PROTOCOL,
  isKeyTier,
  isL1ActionPayload,
  isSignPayload,
  isSignerRpcRequestEnvelope,
  isSignerRpcResponse,
  isTypedDataSignPayload,
  isUserSignedActionPayload,
  type AgentSignPayload,
  type HexAddress,
  type KeyExportKdfParams,
  type KeyTier,
  type MessageSink,
  type PrfCredential,
  type PrfCredentialsApi,
  type SignerEmbedHost,
  type EmbeddedFrameHandle,
  type SignerMessageEvent,
  type UserSignedActionPayload,
} from '@perps-platform/core';

const RP_ID = 'perps.example';
const HOST_ORIGIN = 'https://app.perps.example';
const SIGNER_ORIGIN = 'https://signer.perps.example';
const EVIL_ORIGIN = 'https://evil.example';
const EXPORT_PASSPHRASE = 'correct horse battery staple';
/** Small scrypt cost for test speed — parameters travel in the blob. */
const TEST_EXPORT_KDF: KeyExportKdfParams = { n: 2 ** 12, r: 8, p: 1 };

// --- Boundary model ------------------------------------------------------

interface CrossedMessage {
  from: string;
  to: string;
  targetOrigin: string;
  data: unknown;
  delivered: boolean;
}

class FakeRealm {
  private listeners = new Set<(event: SignerMessageEvent) => void>();

  constructor(
    readonly origin: string,
    private readonly log: CrossedMessage[]
  ) {}

  addEventListener(_type: 'message', listener: (event: SignerMessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: SignerMessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  /** A handle to THIS realm as seen from `sender` — i.e. its window proxy. */
  proxyFor(sender: FakeRealm): MessageSink {
    return {
      postMessage: (message: unknown, targetOrigin: string) => {
        const data = structuredClone(message);
        const delivered = targetOrigin === '*' || targetOrigin === this.origin;
        this.log.push({ from: sender.origin, to: this.origin, targetOrigin, data, delivered });
        if (!delivered) return;
        const event: SignerMessageEvent = {
          data,
          origin: sender.origin,
          source: sender.proxyFor(this),
        };
        for (const listener of [...this.listeners]) listener(event);
      },
    };
  }
}

// --- Deterministic mock authenticator (real-signer side only) ------------

const sha256 = (data: Uint8Array | string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());
const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', key).update(data).digest());

class MockPrfAuthenticator implements PrfCredentialsApi {
  constructor(private readonly secret: Uint8Array) {}

  async create(): Promise<PrfCredential> {
    throw new Error('enrollment is out of scope for the embed contract');
  }

  async get(options: { publicKey: Record<string, unknown> }): Promise<PrfCredential> {
    const salt = (options.publicKey as { extensions?: { prf?: { eval?: { first?: Uint8Array } } } })
      .extensions?.prf?.eval?.first;
    if (!salt) throw new Error('mock get(): no prf.eval.first salt provided');
    const prfOutput = hmac(this.secret, new Uint8Array(salt));
    return {
      rawId: new Uint8Array(16),
      getClientExtensionResults: () => ({ prf: { results: { first: prfOutput } } }),
    };
  }
}

const CREDENTIAL_SECRET = sha256('signer-embed-phase-4');

function realExpected(tier: KeyTier): { prfOutput: Uint8Array; privateKey: HexAddress; address: HexAddress } {
  const prfOutput = hmac(CREDENTIAL_SECRET, prfSalt(RP_ID, tier));
  const { privateKey, address } = deriveSigningKey(prfOutput);
  return { prfOutput, privateKey, address };
}

// --- Encodings a secret could hide in (leak canaries) ---------------------

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function bytesOfHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function secretEncodings(bytes: Uint8Array): string[] {
  const base64 = Buffer.from(bytes).toString('base64');
  return [
    hexOf(bytes),
    `0x${hexOf(bytes)}`,
    base64,
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  ].map((s) => s.toLowerCase());
}

// --- A valid Hyperliquid user-signed action (master-only sign shape) ------

function withdrawAction(): UserSignedActionPayload {
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 42161,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      'HyperliquidTransaction:Withdraw': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:Withdraw',
    message: {
      hyperliquidChain: 'Mainnet',
      destination: '0x2222222222222222222222222222222222222222',
      amount: '42.0',
      time: 1_700_000_000_000,
    },
  };
}

async function recoverTypedData(
  payload: UserSignedActionPayload | AgentSignPayload,
  signature: HexAddress
): Promise<string> {
  const hash = hashTypedData(payload as Parameters<typeof hashTypedData>[0]);
  return recoverAddress({ hash, signature });
}

// --- The L1 phantom-agent envelope (agent-only typed-data shape, 4.3.2) ---

function l1Action(): AgentSignPayload {
  return {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: `0x${'ab'.repeat(32)}` },
  };
}

// --- The alternative signer (fixed keys — stands in for an MPC path) ------
// It implements the SAME hl-signer/v2 contract using the shared validators,
// differing only in the signing backend. If the contract suite passes against
// this with the unchanged embedSigner client, the RPC shape is genuinely the
// stable seam an alternative signer plugs into with no host changes.

const ALT_KEYS: Record<KeyTier, HexAddress> = {
  master: `0x${'11'.repeat(32)}`,
  agent: `0x${'22'.repeat(32)}`,
};

function attachAltSigner(cfg: {
  endpoint: FakeRealm;
  announce: MessageSink;
  hostOrigins: readonly string[];
}): { detach(): void } {
  const accounts = {
    master: privateKeyToAccount(ALT_KEYS.master),
    agent: privateKeyToAccount(ALT_KEYS.agent),
  } as const;

  const listener = (event: SignerMessageEvent): void => {
    if (!cfg.hostOrigins.includes(event.origin)) return;
    if (!isSignerRpcRequestEnvelope(event.data)) return;
    const req = event.data as { id: number; method?: unknown; tier?: unknown; payload?: unknown };
    const id = req.id;
    const reply = (message: unknown): void => event.source?.postMessage(message, event.origin);
    const ok = (extra: Record<string, unknown>): void =>
      reply({ protocol: SIGNER_RPC_PROTOCOL, kind: 'response', id, ok: true, ...extra });
    const fail = (error: string): void =>
      reply({ protocol: SIGNER_RPC_PROTOCOL, kind: 'response', id, ok: false, error });

    if (req.method !== 'deriveAddress' && req.method !== 'sign' && req.method !== 'createBackup') {
      fail(SIGNER_RPC_ERRORS.unknownMethod);
      return;
    }
    if (!isKeyTier(req.tier)) {
      fail(SIGNER_RPC_ERRORS.invalidTier);
      return;
    }
    const account = accounts[req.tier];

    if (req.method === 'deriveAddress') {
      ok({ address: account.address });
      return;
    }

    if (req.method === 'createBackup') {
      // The contract's ciphertext-only export (6.2.7/#439), mirrored with a
      // different key backend: encrypt the fixed key in-realm, return only
      // the encrypted file.
      const passphrase = (req as { passphrase?: unknown }).passphrase;
      const tier = req.tier;
      if (typeof passphrase !== 'string' || passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
        fail(SIGNER_RPC_ERRORS.invalidBackupPassphrase);
        return;
      }
      void createKeyBackupFile({
        privateKey: ALT_KEYS[tier],
        address: account.address,
        tier,
        passphrase,
        kdfParams: TEST_EXPORT_KDF,
      })
        .then((file) =>
          ok({
            address: file.address,
            backup: {
              fileName: file.fileName,
              mimeType: file.mimeType,
              contents: file.contents,
              address: file.address,
            },
          })
        )
        .catch((err: unknown) =>
          fail(sanitizeBoundaryError(err, SIGNER_RPC_ERRORS.backupExportFailed))
        );
      return;
    }

    if (isTypedDataSignPayload(req.payload)) {
      // The per-tier typed-data gates are part of the contract (4.2.2 +
      // 4.3.2): user-signed actions are master-only, the L1 envelope is
      // agent-only — mirrored here with the same shared validators.
      const typedData = req.payload.typedData;
      if (req.tier === 'master' && !isUserSignedActionPayload(typedData)) {
        fail(SIGNER_RPC_ERRORS.masterL1Refused);
        return;
      }
      if (req.tier === 'agent' && !isL1ActionPayload(typedData)) {
        fail(SIGNER_RPC_ERRORS.agentTypedDataL1Only);
        return;
      }
      void account
        .signTypedData(typedData as Parameters<typeof account.signTypedData>[0])
        .then((signature) => ok({ address: account.address, signature }))
        .catch((err: unknown) => fail(sanitizeBoundaryError(err, SIGNER_RPC_ERRORS.signingFailed)));
      return;
    }
    if (!isSignPayload(req.payload)) {
      fail(SIGNER_RPC_ERRORS.invalidSignPayload);
      return;
    }
    if (req.tier === 'master') {
      fail(SIGNER_RPC_ERRORS.masterRawMessage);
      return;
    }
    const message = req.payload.message;
    void account
      .signMessage({ message })
      .then((signature) => ok({ address: account.address, signature }))
      .catch((err: unknown) => fail(sanitizeBoundaryError(err, SIGNER_RPC_ERRORS.signingFailed)));
  };

  cfg.endpoint.addEventListener('message', listener);
  for (const origin of cfg.hostOrigins) {
    cfg.announce.postMessage({ protocol: SIGNER_RPC_PROTOCOL, kind: 'ready' }, origin);
  }
  return { detach: () => cfg.endpoint.removeEventListener('message', listener) };
}

// --- A host-agnostic embed host over the fake realms ----------------------

function fakeEmbedHost(host: FakeRealm, signer: FakeRealm): SignerEmbedHost {
  const sink = signer.proxyFor(host);
  return {
    endpoint: host,
    mountFrame(): EmbeddedFrameHandle {
      return {
        get contentWindow(): MessageSink {
          return sink;
        },
        remove(): void {
          /* fake frame — nothing to unmount */
        },
      };
    },
  };
}

interface Subject {
  client: ReturnType<typeof embedSigner>['client'];
  whenReady: Promise<void>;
  expected: Record<KeyTier, HexAddress>;
  forbidden: string[];
  host: FakeRealm;
  signer: FakeRealm;
  deliveredToHost(): unknown[];
  teardown(): void;
}

/** Wire a host client (via embedSigner) to the real browser signer. */
function realSubject(opts: { signerOrigin?: string } = {}): Subject {
  const log: CrossedMessage[] = [];
  const host = new FakeRealm(HOST_ORIGIN, log);
  const signer = new FakeRealm(opts.signerOrigin ?? SIGNER_ORIGIN, log);

  const embedded = embedSigner({
    host: fakeEmbedHost(host, signer),
    signerOrigin: opts.signerOrigin ?? SIGNER_ORIGIN,
    readyTimeoutMs: 1_000,
  });
  const frame = attachSignerRpc({
    credentials: new MockPrfAuthenticator(CREDENTIAL_SECRET),
    rpId: RP_ID,
    hostOrigins: [HOST_ORIGIN],
    endpoint: signer,
    announce: host.proxyFor(signer),
    exportKdfParams: TEST_EXPORT_KDF,
  });

  const master = realExpected('master');
  const agent = realExpected('agent');
  return {
    client: embedded.client,
    whenReady: embedded.whenReady,
    expected: { master: master.address, agent: agent.address },
    forbidden: [
      ...secretEncodings(master.prfOutput),
      ...secretEncodings(agent.prfOutput),
      ...secretEncodings(bytesOfHex(master.privateKey)),
      ...secretEncodings(bytesOfHex(agent.privateKey)),
    ],
    host,
    signer,
    deliveredToHost: () =>
      log.filter((m) => m.to === host.origin && m.delivered).map((m) => m.data),
    teardown: () => {
      embedded.close();
      frame.detach();
    },
  };
}

/** Wire the same host client (via embedSigner) to the alternative signer. */
function altSubject(): Subject {
  const log: CrossedMessage[] = [];
  const host = new FakeRealm(HOST_ORIGIN, log);
  const signer = new FakeRealm(SIGNER_ORIGIN, log);

  const embedded = embedSigner({
    host: fakeEmbedHost(host, signer),
    signerOrigin: SIGNER_ORIGIN,
    readyTimeoutMs: 1_000,
  });
  const alt = attachAltSigner({
    endpoint: signer,
    announce: host.proxyFor(signer),
    hostOrigins: [HOST_ORIGIN],
  });

  return {
    client: embedded.client,
    whenReady: embedded.whenReady,
    expected: {
      master: privateKeyToAccount(ALT_KEYS.master).address,
      agent: privateKeyToAccount(ALT_KEYS.agent).address,
    },
    forbidden: [
      ...secretEncodings(bytesOfHex(ALT_KEYS.master)),
      ...secretEncodings(bytesOfHex(ALT_KEYS.agent)),
    ],
    host,
    signer,
    deliveredToHost: () =>
      log.filter((m) => m.to === host.origin && m.delivered).map((m) => m.data),
    teardown: () => {
      embedded.close();
      alt.detach();
    },
  };
}

// --- Pure helpers ---------------------------------------------------------

describe('[Phase 4.1.4] embed helpers are host-agnostic and pin the WebAuthn delegation', () => {
  it('signerFrameSrc builds the document URL, appending the dev seed only when present', () => {
    expect(signerFrameSrc({ signerOrigin: SIGNER_ORIGIN })).toBe(
      `${SIGNER_ORIGIN}${DEFAULT_SIGNER_PATH}`
    );
    expect(signerFrameSrc({ signerOrigin: SIGNER_ORIGIN, seed: 'e2e seed' })).toBe(
      `${SIGNER_ORIGIN}${DEFAULT_SIGNER_PATH}?seed=e2e%20seed`
    );
    expect(signerFrameSrc({ signerOrigin: SIGNER_ORIGIN, signerPath: '/alt/', seed: '' })).toBe(
      `${SIGNER_ORIGIN}/alt/`
    );
  });

  it('signerFrameAllow delegates both WebAuthn calls to the signer origin', () => {
    expect(signerFrameAllow(SIGNER_ORIGIN)).toBe(
      `publickey-credentials-get ${SIGNER_ORIGIN}; publickey-credentials-create ${SIGNER_ORIGIN}`
    );
  });

  it('embedSigner rejects a wildcard signer origin at construction', () => {
    const log: CrossedMessage[] = [];
    const host = new FakeRealm(HOST_ORIGIN, log);
    const signer = new FakeRealm(SIGNER_ORIGIN, log);
    expect(() =>
      embedSigner({ host: fakeEmbedHost(host, signer), signerOrigin: '*' })
    ).toThrow(/wildcard/i);
  });
});

// --- The single embed entry point + a second minimal test host ------------

describe('[Phase 4.1.4] embedSigner is the single entry point a second host reuses verbatim', () => {
  it('mounts the frame with the cross-origin src + WebAuthn allow via the host DOM seam', () => {
    const log: CrossedMessage[] = [];
    const host = new FakeRealm(HOST_ORIGIN, log);
    const signer = new FakeRealm(SIGNER_ORIGIN, log);
    const mounted: Array<{ src: string; allow: string }> = [];
    let removed = 0;

    const embedded = embedSigner({
      host: {
        endpoint: host,
        mountFrame(spec) {
          mounted.push(spec);
          const sink = signer.proxyFor(host);
          return {
            get contentWindow(): MessageSink {
              return sink;
            },
            remove: () => {
              removed += 1;
            },
          };
        },
      },
      signerOrigin: SIGNER_ORIGIN,
      seed: 'dev-seed',
      readyTimeoutMs: 1_000,
    });

    expect(mounted).toEqual([
      {
        src: `${SIGNER_ORIGIN}${DEFAULT_SIGNER_PATH}?seed=dev-seed`,
        allow: signerFrameAllow(SIGNER_ORIGIN),
      },
    ]);
    embedded.close();
    expect(removed).toBe(1);
  });

  it('the whole surface is just the RPC client + a ready handshake + teardown', async () => {
    const subject = realSubject();
    await expect(subject.whenReady).resolves.toBeUndefined();
    // A second host reaches exactly deriveAddress/sign/createBackup/
    // revealMnemonic/assertLogin/attestReattach/close — nothing else, nothing
    // key-shaped — identical to apps/web. (createBackup resolves only the
    // passphrase-ENCRYPTED backup file, 6.2.7/#439; revealMnemonic resolves
    // only { address, wordCount }, 7.5.2 — the phrase renders in-realm and
    // never crosses; assertLogin resolves only the derived agent address plus
    // the public WebAuthn assertion, #638; attestReattach resolves two
    // addresses, a signature over typed data the server recomposes for itself,
    // and that same public assertion — its PRF outputs are consumed and
    // zeroized in the scope that derived them. None is a key-material
    // accessor.)
    expect(Object.keys(subject.client).sort()).toEqual([
      'assertLogin',
      'attestReattach',
      'close',
      'createBackup',
      'deriveAddress',
      'revealMnemonic',
      'sign',
    ]);
    for (const name of Object.keys(subject.client)) {
      // 7.5.2: revealMnemonic names the opt-in flow honestly but returns no
      // words — only the address + count. It is the sole allowed exception.
      if (name === 'revealMnemonic') continue;
      expect(name).not.toMatch(/key|prf|secret|seed|export|private|mnemonic/i);
    }
    subject.teardown();
  });

  it('a second minimal host drives derive + sign against the real signer through the entry point', async () => {
    const subject = realSubject();
    await subject.whenReady;

    const agentAddress = await subject.client.deriveAddress('agent');
    expect(agentAddress).toBe(subject.expected.agent);

    const { signature, address } = await subject.client.sign(
      { message: 'order intent from a second host' },
      'agent'
    );
    expect(address).toBe(subject.expected.agent);
    await expect(
      recoverMessageAddress({ message: 'order intent from a second host', signature })
    ).resolves.toBe(subject.expected.agent);

    subject.teardown();
  });

  it('the same embedSigner call works against a different signer origin with no code change', async () => {
    const subject = realSubject({ signerOrigin: 'https://signer2.perps.example' });
    await subject.whenReady;
    expect(await subject.client.deriveAddress('master')).toBe(subject.expected.master);
    subject.teardown();
  });

  it('close() tears down: further calls reject and the frame is removed', async () => {
    const subject = realSubject();
    await subject.whenReady;
    subject.teardown();
    await expect(subject.client.deriveAddress('agent')).rejects.toThrow(/closed/i);
  });

  it('whenReady rejects if the signer never announces ready', async () => {
    const log: CrossedMessage[] = [];
    const host = new FakeRealm(HOST_ORIGIN, log);
    const signer = new FakeRealm(SIGNER_ORIGIN, log);
    // No signer attached → no ready message ever posted.
    const embedded = embedSigner({
      host: fakeEmbedHost(host, signer),
      signerOrigin: SIGNER_ORIGIN,
      readyTimeoutMs: 20,
    });
    await expect(embedded.whenReady).rejects.toThrow(/ready/i);
    embedded.close();
  });

  it('browserSignerEmbedHost throws when no browser window is available (Node)', () => {
    expect(() => browserSignerEmbedHost({ window: undefined })).toThrow(/window/i);
  });
});

// --- The reusable contract suite, run against both implementations --------

function runSignerContract(label: string, make: () => Subject): void {
  describe(`hl-signer/v2 contract — ${label}`, () => {
    it('deriveAddress returns a stable, distinct EOA per tier', async () => {
      const subject = make();
      await subject.whenReady;
      const master1 = await subject.client.deriveAddress('master');
      const master2 = await subject.client.deriveAddress('master');
      const agent = await subject.client.deriveAddress('agent');
      expect(master1).toBe(subject.expected.master);
      expect(master1).toBe(master2);
      expect(agent).toBe(subject.expected.agent);
      expect(master1).not.toBe(agent);
      subject.teardown();
    });

    it('sign(agent, {message}) yields a signature recoverable to the agent EOA', async () => {
      const subject = make();
      await subject.whenReady;
      const message = 'a hyperliquid order intent';
      const { signature, address } = await subject.client.sign({ message }, 'agent');
      expect(address).toBe(subject.expected.agent);
      await expect(recoverMessageAddress({ message, signature })).resolves.toBe(
        subject.expected.agent
      );
      subject.teardown();
    });

    it('sign(master, {typedData}) yields a signature recoverable to the master EOA', async () => {
      const subject = make();
      await subject.whenReady;
      const action = withdrawAction();
      const { signature, address } = await subject.client.sign({ typedData: action }, 'master');
      expect(address).toBe(subject.expected.master);
      await expect(recoverTypedData(action, signature)).resolves.toBe(subject.expected.master);
      subject.teardown();
    });

    it('sign(agent, {typedData: L1 envelope}) yields a signature recoverable to the agent EOA (4.3.2)', async () => {
      const subject = make();
      await subject.whenReady;
      const envelope = l1Action();
      const { signature, address } = await subject.client.sign({ typedData: envelope }, 'agent');
      expect(address).toBe(subject.expected.agent);
      await expect(recoverTypedData(envelope, signature)).resolves.toBe(subject.expected.agent);
      subject.teardown();
    });

    it('rejects the master raw-message step-up bypass (client-side, before any prompt)', async () => {
      const subject = make();
      await subject.whenReady;
      await expect(subject.client.sign({ message: 'blind bytes' }, 'master')).rejects.toThrow();
      subject.teardown();
    });

    it('keeps the tiers’ typed-data spaces disjoint: agent refuses user-signed actions, master refuses the L1 envelope', async () => {
      const subject = make();
      await subject.whenReady;
      await expect(
        subject.client.sign({ typedData: withdrawAction() }, 'agent')
      ).rejects.toThrow(/L1/);
      await expect(subject.client.sign({ typedData: l1Action() }, 'master')).rejects.toThrow(
        /agent-only|L1/
      );
      subject.teardown();
    });

    it('the frame itself rejects a crafted master raw-message wire request', async () => {
      const subject = make();
      await subject.whenReady;
      const replies: unknown[] = [];
      subject.host.addEventListener('message', (event) => {
        if (event.origin === subject.signer.origin && isSignerRpcResponse(event.data)) {
          replies.push(event.data);
        }
      });
      subject.signer.proxyFor(subject.host).postMessage(
        {
          protocol: SIGNER_RPC_PROTOCOL,
          kind: 'request',
          id: 4141,
          method: 'sign',
          tier: 'master',
          payload: { message: 'blind bytes crafted on the wire' },
        },
        subject.signer.origin
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(replies).toContainEqual({
        protocol: SIGNER_RPC_PROTOCOL,
        kind: 'response',
        id: 4141,
        ok: false,
        error: SIGNER_RPC_ERRORS.masterRawMessage,
      });
      subject.teardown();
    });

    it('rejects an unknown method crafted on the wire', async () => {
      const subject = make();
      await subject.whenReady;
      const replies: unknown[] = [];
      subject.host.addEventListener('message', (event) => {
        if (event.origin === subject.signer.origin && isSignerRpcResponse(event.data)) {
          replies.push(event.data);
        }
      });
      subject.signer.proxyFor(subject.host).postMessage(
        { protocol: SIGNER_RPC_PROTOCOL, kind: 'request', id: 99, method: 'exportKey', tier: 'agent' },
        subject.signer.origin
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(replies).toContainEqual({
        protocol: SIGNER_RPC_PROTOCOL,
        kind: 'response',
        id: 99,
        ok: false,
        error: SIGNER_RPC_ERRORS.unknownMethod,
      });
      subject.teardown();
    });

    it('ignores a request from a non-allowlisted origin outright (no reply)', async () => {
      const subject = make();
      await subject.whenReady;
      const evil = new FakeRealm(EVIL_ORIGIN, []);
      // Register the evil realm on the same signer so it can post in.
      const replies: unknown[] = [];
      evil.addEventListener('message', (event) => replies.push(event.data));
      subject.signer.proxyFor(evil).postMessage(
        { protocol: SIGNER_RPC_PROTOCOL, kind: 'request', id: 7, method: 'deriveAddress', tier: 'agent' },
        subject.signer.origin
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(replies).toHaveLength(0);
      subject.teardown();
    });

    it('createBackup(passphrase, tier) resolves only the encrypted backup file for the tier EOA (6.2.7/#439)', async () => {
      const subject = make();
      await subject.whenReady;
      const file = await subject.client.createBackup(EXPORT_PASSPHRASE, 'agent');
      expect(file.address).toBe(subject.expected.agent);
      const blob = parseKeyBackup(file.contents);
      expect(blob.address).toBe(subject.expected.agent);
      expect(blob.tier).toBe('agent');
      // The blob genuinely restores the tier's signer through the real
      // recovery path — and only with the right passphrase.
      const restored = await recoverSignerFromBackup(file.contents, EXPORT_PASSPHRASE);
      expect(restored.address).toBe(subject.expected.agent);
      await expect(recoverSignerFromBackup(file.contents, 'wrong-passphrase')).rejects.toThrow();
      subject.teardown();
    });

    it('createBackup refuses a short passphrase client-side, before anything crosses', async () => {
      const subject = make();
      await subject.whenReady;
      await expect(subject.client.createBackup('short', 'agent')).rejects.toThrow(/characters/);
      subject.teardown();
    });

    it('no PRF output or private key ever crosses into the host, under any call', async () => {
      const subject = make();
      await subject.whenReady;
      await subject.client.deriveAddress('master');
      await subject.client.deriveAddress('agent');
      await subject.client.sign({ message: 'order' }, 'agent');
      await subject.client.sign({ typedData: l1Action() }, 'agent');
      await subject.client.sign({ typedData: withdrawAction() }, 'master');
      await subject.client.createBackup(EXPORT_PASSPHRASE, 'agent');

      const serialized = JSON.stringify(subject.deliveredToHost()).toLowerCase();
      for (const secret of subject.forbidden) {
        expect(serialized).not.toContain(secret);
      }
      // The export passphrase crossed host → frame, but nothing the frame
      // posted back ever carries it.
      expect(serialized.replace(EXPORT_PASSPHRASE.toLowerCase(), '')).toBe(serialized);
      subject.teardown();
    });
  });
}

runSignerContract('real browser signer (attachSignerRpc)', realSubject);
runSignerContract('alternative signer (fixed keys — MPC stand-in)', altSubject);

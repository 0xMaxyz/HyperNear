/**
 * Every passkey ceremony in the signer frame waits for a tap INSIDE that
 * frame.
 *
 * iOS Safari and iOS Chrome (both WebKit) could not create or use a passkey at
 * all: the ceremony frame is mounted `0x0 visibility:hidden`, and WebKit
 * refuses `navigator.credentials.*` from a document that fails
 * `document.hasFocus()` — `NotAllowedError: The document is not focused.`
 * WebAuthn L3 adds a second gate, transient activation in the cross-origin
 * frame itself, which a parent's click never confers on a child. One tap in
 * the signer document satisfies both.
 *
 * What is pinned here is the CONTRACT around that tap, since the tap itself
 * lives in the signer program (apps/web/signer/entry.ts) and its rendering is
 * covered by a Playwright spec:
 *  - every ceremony method waits for it;
 *  - it is asked for only AFTER a request validates, so a malformed request
 *    still costs the user nothing;
 *  - a dismissal never reaches the authenticator, and arrives at the host as
 *    one static, classifiable failure;
 *  - the frame's prompt notification resizes its own frame and nobody else's.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  attachSignerRpc,
  browserSignerEmbedHost,
  embedSigner,
  isSignerRpcPrompt,
  prfSalt,
  SIGNER_RPC_ERRORS,
  SIGNER_RPC_PROTOCOL,
  type EmbeddedFrameHandle,
  type MessageSink,
  type PrfCredential,
  type PrfCredentialsApi,
  type SignerCeremonyRequest,
  type SignerEmbedHost,
  type SignerMessageEvent,
} from '../../src/index';
import { createHash, createHmac } from 'node:crypto';

const RP_ID = 'perps.example';
const HOST_ORIGIN = 'https://app.perps.example';
const SIGNER_ORIGIN = 'https://signer.perps.example';
const EVIL_ORIGIN = 'https://evil.example';

class FakeRealm {
  private listeners = new Set<(event: SignerMessageEvent) => void>();
  constructor(readonly origin: string) {}
  addEventListener(_t: 'message', l: (event: SignerMessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (event: SignerMessageEvent) => void): void {
    this.listeners.delete(l);
  }
  /** A handle to THIS realm as seen from `sender` — i.e. its window proxy. */
  proxyFor(sender: FakeRealm): MessageSink {
    return {
      postMessage: (message: unknown, targetOrigin: string) => {
        if (targetOrigin !== '*' && targetOrigin !== this.origin) return;
        const event: SignerMessageEvent = {
          data: structuredClone(message),
          origin: sender.origin,
          source: sender.proxyFor(this),
        };
        for (const l of [...this.listeners]) l(event);
      },
    };
  }
}

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', key).update(data).digest());
const SECRET = new Uint8Array(createHash('sha256').update('signer-gesture').digest());

/** Counts its own use, so "never reached the authenticator" is a real claim. */
class CountingAuthenticator implements PrfCredentialsApi {
  calls = 0;
  async create(): Promise<PrfCredential> {
    throw new Error('enrollment is out of scope here');
  }
  async get(options: { publicKey: Record<string, unknown> }): Promise<PrfCredential> {
    this.calls += 1;
    const salt = (options.publicKey as { extensions?: { prf?: { eval?: { first?: Uint8Array } } } })
      .extensions?.prf?.eval?.first;
    if (!salt) throw new Error('mock get(): no prf.eval.first salt provided');
    const second = (
      options.publicKey as { extensions?: { prf?: { eval?: { second?: Uint8Array } } } }
    ).extensions?.prf?.eval?.second;
    const results = {
      first: hmac(SECRET, new Uint8Array(salt)),
      ...(second ? { second: hmac(SECRET, new Uint8Array(second)) } : {}),
    };
    return {
      rawId: new Uint8Array(16),
      // The login ceremony forwards the public assertion to the server, so a
      // mock that omits it cannot reach the reply this file is about.
      response: {
        authenticatorData: new Uint8Array([1, 2, 3]),
        clientDataJSON: new Uint8Array([4, 5, 6]),
        signature: new Uint8Array([7, 8, 9]),
      },
      getClientExtensionResults: () => ({ prf: { results } }),
    };
  }
}

function fakeEmbedHost(host: FakeRealm, signer: FakeRealm, frame: EmbeddedFrameHandle) {
  const sink = signer.proxyFor(host);
  return {
    endpoint: host,
    mountFrame: () => ({ ...frame, get contentWindow(): MessageSink { return sink; } }),
  } satisfies SignerEmbedHost;
}

interface Harness {
  client: ReturnType<typeof embedSigner>['client'];
  whenReady: Promise<void>;
  credentials: CountingAuthenticator;
  gestures: SignerCeremonyRequest[];
  setVisible: ReturnType<typeof vi.fn>;
  signer: FakeRealm;
  host: FakeRealm;
  teardown(): void;
}

function harness(opts: { dismiss?: boolean } = {}): Harness {
  const host = new FakeRealm(HOST_ORIGIN);
  const signer = new FakeRealm(SIGNER_ORIGIN);
  const gestures: SignerCeremonyRequest[] = [];
  const setVisible = vi.fn();
  const credentials = new CountingAuthenticator();

  const embedded = embedSigner({
    host: fakeEmbedHost(host, signer, {
      contentWindow: null,
      remove: () => {},
      setVisible,
    }),
    signerOrigin: SIGNER_ORIGIN,
    readyTimeoutMs: 1_000,
  });

  const frame = attachSignerRpc({
    credentials,
    rpId: RP_ID,
    hostOrigins: [HOST_ORIGIN],
    endpoint: signer,
    announce: host.proxyFor(signer),
    requireGesture: async (request) => {
      gestures.push(request);
      if (opts.dismiss) throw new Error('the user closed the card');
    },
  });

  return {
    client: embedded.client,
    whenReady: embedded.whenReady,
    credentials,
    gestures,
    setVisible,
    signer,
    host,
    teardown: () => {
      embedded.close();
      frame.detach();
    },
  };
}

const L1_ACTION = {
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
  message: { source: 'b', connectionId: `0x${'11'.repeat(32)}` },
} as const;

/** A Hyperliquid user-signed action — the master tier's shape, refused on agent. */
const USER_SIGNED = {
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
    destination: '0x1234567890123456789012345678901234567890',
    amount: '1',
    time: 1_700_000_000_000,
  },
} as const;

describe('signer ceremonies wait for a gesture inside the signer document', () => {
  it('asks for the gesture before deriving, and names the ceremony', async () => {
    const h = harness();
    await h.whenReady;

    const address = await h.client.deriveAddress('agent');

    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(h.gestures).toEqual([{ method: 'deriveAddress', tier: 'agent' }]);
    expect(h.credentials.calls).toBe(1);
    h.teardown();
  });

  it('asks once per ceremony, on every method that prompts', async () => {
    const h = harness();
    await h.whenReady;

    await h.client.deriveAddress('agent');
    await h.client.sign({ message: 'an order intent' }, 'agent');
    await h.client.sign({ typedData: L1_ACTION }, 'agent');
    await h.client.assertLogin({ challenge: 'Y2hhbGxlbmdl' });

    expect(h.gestures.map((g) => g.method)).toEqual([
      'deriveAddress',
      'sign',
      'sign',
      'assertLogin',
    ]);
    expect(h.credentials.calls).toBe(4);
    h.teardown();
  });

  it('a dismissal never reaches the authenticator', async () => {
    const h = harness({ dismiss: true });
    await h.whenReady;

    await expect(h.client.deriveAddress('agent')).rejects.toThrow(
      SIGNER_RPC_ERRORS.gestureDismissed
    );
    expect(h.credentials.calls).toBe(0);
    h.teardown();
  });

  // The host classifies a failure by the DOMException name carried in the
  // message (`sanitizeBoundaryError`), and closing the confirmation is a
  // cancelled ceremony — so it must arrive named, not as a bare sentence that
  // lands in the catch-all the iOS bug already lived in.
  it('a dismissal arrives named AbortError, whatever the UI threw', async () => {
    const h = harness({ dismiss: true });
    await h.whenReady;

    const message = await h.client
      .sign({ message: 'x' }, 'agent')
      .then(() => 'resolved')
      .catch((err: unknown) => (err as Error).message);

    expect(message).toContain('AbortError');
    expect(message).toContain(SIGNER_RPC_ERRORS.gestureDismissed);
    // Nothing the UI threw with is echoed across the boundary.
    expect(message).not.toContain('the user closed the card');
    h.teardown();
  });

  // A request that could never sign must not cost a tap, for the same reason
  // it never cost a WebAuthn prompt: the validation is the cheap gate and it
  // stays in front.
  it('a request that fails validation never asks for a gesture', async () => {
    const h = harness();
    await h.whenReady;

    // Raw messages are agent-only; the master tier refuses them outright.
    await expect(h.client.sign({ message: 'x' }, 'master')).rejects.toThrow(
      /raw message signing is agent-only/
    );
    // The master tier's typed-data space excludes the L1 envelope.
    await expect(h.client.sign({ typedData: L1_ACTION }, 'master')).rejects.toThrow(
      /L1|phantom-agent/
    );
    // An agent asked for a user-signed action is refused before the ceremony.
    await expect(h.client.sign({ typedData: USER_SIGNED }, 'agent')).rejects.toThrow(
      /L1|agent/
    );

    expect(h.gestures).toEqual([]);
    expect(h.credentials.calls).toBe(0);
    h.teardown();
  });

  it('a frame with no requireGesture runs ceremonies straight away', async () => {
    const host = new FakeRealm(HOST_ORIGIN);
    const signer = new FakeRealm(SIGNER_ORIGIN);
    const credentials = new CountingAuthenticator();
    const embedded = embedSigner({
      host: fakeEmbedHost(host, signer, { contentWindow: null, remove: () => {} }),
      signerOrigin: SIGNER_ORIGIN,
      readyTimeoutMs: 1_000,
    });
    const frame = attachSignerRpc({
      credentials,
      rpId: RP_ID,
      hostOrigins: [HOST_ORIGIN],
      endpoint: signer,
      announce: host.proxyFor(signer),
    });

    await embedded.whenReady;
    await expect(embedded.client.deriveAddress('agent')).resolves.toMatch(/^0x/);
    expect(credentials.calls).toBe(1);

    embedded.close();
    frame.detach();
  });

  it('derives the same address whether or not a gesture gates it', async () => {
    // The gate must be a gate and nothing more — it sits in front of the
    // ceremony, never inside it, so the key it derives is unchanged.
    const gated = harness();
    await gated.whenReady;
    const withGesture = await gated.client.deriveAddress('master');
    gated.teardown();

    const expected = prfSalt(RP_ID, 'master');
    expect(expected).toBeInstanceOf(Uint8Array);
    expect(withGesture).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('the prompt notification resizes the frame', () => {
  const prompt = (active: boolean) => ({
    protocol: SIGNER_RPC_PROTOCOL,
    kind: 'prompt' as const,
    active,
  });

  it('is recognised only in its exact shape', () => {
    expect(isSignerRpcPrompt(prompt(true))).toBe(true);
    expect(isSignerRpcPrompt({ ...prompt(true), protocol: 'hl-signer/v1' })).toBe(false);
    expect(isSignerRpcPrompt({ protocol: SIGNER_RPC_PROTOCOL, kind: 'prompt' })).toBe(false);
    expect(isSignerRpcPrompt({ protocol: SIGNER_RPC_PROTOCOL, kind: 'ready' })).toBe(false);
    expect(isSignerRpcPrompt(null)).toBe(false);
  });

  it('shows and hides the frame the notification came from', async () => {
    const h = harness();
    await h.whenReady;

    h.host.proxyFor(h.signer).postMessage(prompt(true), HOST_ORIGIN);
    expect(h.setVisible).toHaveBeenLastCalledWith(true);

    h.host.proxyFor(h.signer).postMessage(prompt(false), HOST_ORIGIN);
    expect(h.setVisible).toHaveBeenLastCalledWith(false);
    h.teardown();
  });

  it('ignores a prompt from any origin but the signer', async () => {
    const h = harness();
    await h.whenReady;

    h.host.proxyFor(new FakeRealm(EVIL_ORIGIN)).postMessage(prompt(true), HOST_ORIGIN);

    expect(h.setVisible).not.toHaveBeenCalled();
    h.teardown();
  });

  it('stops listening once the embed is closed', async () => {
    const h = harness();
    await h.whenReady;
    h.teardown();

    h.host.proxyFor(h.signer).postMessage(prompt(true), HOST_ORIGIN);

    expect(h.setVisible).not.toHaveBeenCalled();
  });
});

describe('browserSignerEmbedHost frame visibility', () => {
  function fakeFrame() {
    const attrs: Record<string, string> = {};
    return {
      attrs,
      element: {
        src: '',
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        contentWindow: null,
        remove: () => {},
      },
    };
  }

  function windowWith(frame: ReturnType<typeof fakeFrame>) {
    return {
      document: {
        createElement: () => frame.element,
        body: { appendChild: () => {} },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }

  it('swaps between the mount style and the prompt style, and back', () => {
    const frame = fakeFrame();
    const host = browserSignerEmbedHost({
      window: windowWith(frame) as never,
      configureFrame: (f) => f.setAttribute('style', 'hidden-style'),
      configurePromptFrame: (f) => f.setAttribute('style', 'prompt-style'),
    });

    const handle = host.mountFrame({ src: 'https://signer.example/', allow: 'x' });
    expect(frame.attrs.style).toBe('hidden-style');

    handle.setVisible?.(true);
    expect(frame.attrs.style).toBe('prompt-style');

    handle.setVisible?.(false);
    expect(frame.attrs.style).toBe('hidden-style');
  });

  // The reveal frame is mounted visible and has nothing to toggle; a host that
  // says nothing about prompting must not be handed a resize it never asked
  // for, so the capability is simply absent.
  it('exposes no setVisible when the host configures no prompt style', () => {
    const frame = fakeFrame();
    const host = browserSignerEmbedHost({
      window: windowWith(frame) as never,
      configureFrame: (f) => f.setAttribute('style', 'visible-already'),
    });

    const handle = host.mountFrame({ src: 'https://signer.example/', allow: 'x' });
    expect(handle.setVisible).toBeUndefined();
    expect(frame.attrs.style).toBe('visible-already');
  });
});

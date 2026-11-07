// [#612] Epic 7.6 / task 7.6.5 — the external-dApp door of the master tier:
// the payload space the passkey wallet signs while acting as a WalletConnect
// signer. What is pinned here:
//
//  1. DISJOINTNESS, both directions. Every platform-internal shape (Hyperliquid
//     user-signed action, bridge-deposit permit, USDC transfer authorization,
//     L1 phantom-agent envelope) is REFUSED through the dApp door, and foreign
//     payloads stay refused on the internal door — so a connected dApp can
//     never obtain a signature that moves Hyperliquid funds or approves the
//     bridge, and a host page can never launder dApp traffic as a platform
//     action.
//  2. NEVER BLIND BYTES. `personal_sign` is admitted only for readable text —
//     a hex blob or a control-character payload is refused, so a step-up prompt
//     can never be spent on a digest the user could not read.
//  3. PINNED TRANSACTIONS. A transaction signs only when fully specified on an
//     allowlisted chain with a real recipient; the reviewed intent and the
//     signed intent are the same object, and the returned bytes are the
//     serialized signed transaction the host broadcasts verbatim.
//  4. ONE CEREMONY, ONE SIGNATURE, MASTER ONLY — enforced independently by the
//     client gate and by the frame, and the returned identity is pinned to the
//     enrolled master EOA.
import { describe, expect, it, vi } from 'vitest';
import {
  parseTransaction,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CCTP_EXTENSION_V2,
  connectSignerRpc,
  EXTERNAL_DAPP_CHAIN_IDS,
  MAX_EXTERNAL_DAPP_MESSAGE_LENGTH,
  USDC_AUTHORIZATION_NETWORKS,
  buildUsdcTransferAuthorization,
  planSponsoredCctpDeposit,
  createExternalDappSigner,
  isExternalDappMessage,
  isExternalDappRequest,
  isExternalDappTransaction,
  isExternalDappTypedData,
  isMasterSignablePayload,
  isSignRpcPayload,
  usdcAuthorizationNonceFromBytes,
  withExternalDappCeremony,
  type ExternalDappRequest,
  type ExternalDappTransaction,
  type HexAddress,
  type KeyTier,
  type SignRpcPayload,
} from '../../src/index';

const MASTER = privateKeyToAccount(`0x${'7'.repeat(64)}`);
const MASTER_ADDRESS = MASTER.address as HexAddress;
const SPENDER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as HexAddress;
const USDC = USDC_AUTHORIZATION_NETWORKS.mainnet.usdcAddress;

// A permit for a random dApp router: foreign (the platform gate pins the
// spender to the bridge), so it belongs on the dApp door.
const FOREIGN_PERMIT = {
  domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: USDC },
  types: {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'Permit',
  message: {
    owner: MASTER_ADDRESS,
    spender: SPENDER,
    value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    nonce: '0',
    deadline: '1900000000',
  },
} as const;

const HL_ACTION = {
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
    destination: MASTER_ADDRESS,
    amount: '1000',
    time: 1_753_300_000_000,
  },
} as const;

const L1_ENVELOPE = {
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
  message: { source: 'a', connectionId: `0x${'11'.repeat(32)}` },
} as const;

const TX: ExternalDappTransaction = {
  chainId: 42161,
  to: SPENDER,
  value: '0',
  data: '0x095ea7b3',
  nonce: 7,
  gas: '120000',
  maxFeePerGas: '100000000',
  maxPriorityFeePerGas: '1000000',
};

/** A stand-in signer frame that REALLY signs with the master key, per kind —
 * exactly what the frame's `withExternalDappCeremony` handler produces — so the
 * recovered signer of whatever crosses the seam can be asserted. */
function frameClient() {
  const calls: { payload: unknown; tier: string }[] = [];
  return {
    calls,
    client: {
      sign: async (payload: SignRpcPayload, tier: KeyTier) => {
        calls.push({ payload, tier });
        if (!('externalRequest' in payload)) throw new Error('expected an external-dApp payload');
      const request = payload.externalRequest;
        let signature: HexAddress;
        if (request.kind === 'message') {
          signature = (await MASTER.signMessage({ message: request.message })) as HexAddress;
        } else if (request.kind === 'typedData') {
          signature = (await MASTER.signTypedData(
            request.typedData as unknown as TypedDataDefinition,
          )) as HexAddress;
        } else {
          const tx = request.transaction;
          signature = (await MASTER.signTransaction({
            type: 'eip1559',
            chainId: tx.chainId,
            to: tx.to,
            value: BigInt(tx.value),
            data: tx.data,
            nonce: tx.nonce,
            gas: BigInt(tx.gas),
            maxFeePerGas: BigInt(tx.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          })) as HexAddress;
        }
        return { signature, address: MASTER_ADDRESS };
      },
    },
  };
}

/** A PRF-backed credential mock for the in-realm ceremony helper: a fixed PRF
 * output, so the ceremony derives a stable (non-master) key of its own. */
function prfCredentials() {
  return {
    get: vi.fn(async () => ({
      rawId: new Uint8Array(16),
      getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(7) } } }),
    })),
  } as never;
}

const CEREMONY_PARAMS = () => ({
  credentials: prfCredentials(),
  rpId: 'example.test',
  getChallenge: new Uint8Array(32),
});

describe('[Phase 7] external-dApp signing gate (7.6.5) — foreign payloads only', () => {
  it.each([
    ['a Hyperliquid user-signed action', HL_ACTION],
    ['the L1 phantom-agent envelope', L1_ENVELOPE],
  ])('refuses %s — the dApp door never reaches the platform signing space', (_label, payload) => {
    expect(isExternalDappTypedData(payload)).toBe(false);
    expect(isExternalDappRequest({ kind: 'typedData', typedData: payload })).toBe(false);
  });

  it('refuses the pinned USDC withdraw authorization (the platform withdraw shape)', () => {
    const platform = buildUsdcTransferAuthorization({
      network: 'mainnet',
      from: MASTER_ADDRESS,
      to: SPENDER,
      value: 1_000_000n,
      validBefore: 1_900_000_000n,
      nonce: usdcAuthorizationNonceFromBytes(new Uint8Array(32).fill(3)),
    });
    expect(isMasterSignablePayload(platform)).toBe(true);
    expect(isExternalDappTypedData(platform)).toBe(false);
  });

  it('refuses the TESTNET withdraw authorization too — widening the token registry widened both doors', () => {
    // ADR 7.9.10 added Circle's Sepolia USDC to USDC_AUTHORIZATION_NETWORKS.
    // That widens what the internal door accepts, so the external door must
    // refuse the same shape — the disjointness is what stops a connected dApp
    // obtaining a signature that moves the wallet's own USDC, and it has to
    // hold for every row, not just the one it was written against.
    const platform = buildUsdcTransferAuthorization({
      network: 'testnet' as 'mainnet',
      from: MASTER_ADDRESS,
      to: SPENDER,
      value: 1_000_000n,
      validBefore: 1_900_000_000n,
      nonce: usdcAuthorizationNonceFromBytes(new Uint8Array(32).fill(4)),
    });
    expect(platform.domain.chainId).toBe(421614);
    expect(isMasterSignablePayload(platform)).toBe(true);
    expect(isExternalDappTypedData(platform)).toBe(false);
  });

  it.each(['mainnet', 'testnet'] as const)(
    'refuses the sponsored-CCTP deposit authorization on %s — the ADR 7.9.10 widening does not leak here',
    (network) => {
      // ADR 7.9.10 admitted a SECOND EIP-3009 shape to the master tier: a
      // `ReceiveWithAuthorization` whose `to` is that network's
      // `CctpExtensionV2`. Because FiatToken requires `msg.sender == to`, the
      // extension is the only contract that can ever consume it — so this is
      // exactly the payload a connected dApp must not be able to obtain a
      // signature over, and the internal/external disjointness is what stops
      // it. The property is structural (`isExternalDappTypedData` refuses
      // everything `isMasterSignablePayload` recognizes), which is why every
      // widening of the internal door narrows this one by the same shape — but
      // it is asserted per shape so a future refactor of either gate fails here
      // rather than quietly opening the door.
      const authorization = planSponsoredCctpDeposit({
        network,
        amount: '25',
        from: MASTER_ADDRESS,
        hyperCoreRecipient: MASTER_ADDRESS,
        validBefore: 1_900_000_000n,
      }).authorization;
      expect(authorization.primaryType).toBe('ReceiveWithAuthorization');
      expect(authorization.message.to).toBe(CCTP_EXTENSION_V2[network]);
      expect(isMasterSignablePayload(authorization)).toBe(true);
      expect(isExternalDappTypedData(authorization)).toBe(false);
      expect(isExternalDappRequest({ kind: 'typedData', typedData: authorization })).toBe(false);
      expect(isSignRpcPayload({ externalRequest: { kind: 'typedData', typedData: authorization } })).toBe(
        false,
      );
    },
  );

  it('admits foreign typed data (a dApp permit whose spender is not the bridge)', () => {
    expect(isMasterSignablePayload(FOREIGN_PERMIT)).toBe(false);
    expect(isExternalDappTypedData(FOREIGN_PERMIT)).toBe(true);
  });

  it('refuses typed data that names no struct for its primaryType — an opaque blob is not a reviewable request', () => {
    expect(
      isExternalDappTypedData({ domain: {}, types: {}, primaryType: 'Order', message: {} })
    ).toBe(false);
  });

  it('refuses a Hyperliquid-shaped domain even when the strict platform gate would also reject it', () => {
    const malformed = {
      ...HL_ACTION,
      message: {},
      types: { 'HyperliquidTransaction:Withdraw': [{ name: 'amount', type: 'string' }] },
    };
    expect(isExternalDappTypedData(malformed)).toBe(false);
  });
});

describe('[Phase 7] external-dApp signing gate (7.6.5) — messages are read, never blind bytes', () => {
  it('admits a readable SIWE-style message', () => {
    expect(
      isExternalDappMessage('app.uniswap.org wants you to sign in with your Ethereum account')
    ).toBe(true);
  });

  it.each([
    ['a hex blob (a digest, not a sentence)', `0x${'ab'.repeat(32)}`],
    ['an empty message', ''],
    ['whitespace only', '   \n '],
    ['a control-character payload', 'ok\u0007bad'],
    ['an oversized wall of text', 'x'.repeat(MAX_EXTERNAL_DAPP_MESSAGE_LENGTH + 1)],
  ])('refuses %s', (_label, message) => {
    expect(isExternalDappMessage(message)).toBe(false);
    expect(isExternalDappRequest({ kind: 'message', message })).toBe(false);
  });
});

describe('[Phase 7] external-dApp signing gate (7.6.5) — transactions are fully pinned', () => {
  it('admits a fully specified Arbitrum EIP-1559 transaction', () => {
    expect(isExternalDappTransaction(TX)).toBe(true);
    expect(EXTERNAL_DAPP_CHAIN_IDS).toContain(42161);
  });

  it.each([
    ['an unsupported chain', { chainId: 1 }],
    ['a contract creation (no recipient)', { to: undefined as unknown as HexAddress }],
    ['the zero address', { to: '0x0000000000000000000000000000000000000000' as HexAddress }],
    ['an unspecified nonce', { nonce: undefined as unknown as number }],
    ['an unspecified gas limit', { gas: undefined as unknown as string }],
    ['a zero gas limit', { gas: '0' }],
    ['unspecified fees', { maxFeePerGas: undefined as unknown as string }],
    ['a priority fee above the max fee', { maxPriorityFeePerGas: '999999999999' }],
    ['a non-decimal value', { value: '0x10' }],
    ['odd-length calldata', { data: '0x123' as HexAddress }],
  ])('refuses %s — the host can never fill in what the user reviewed', (_label, patch) => {
    expect(isExternalDappTransaction({ ...TX, ...patch })).toBe(false);
  });
});

describe('[Phase 7] external-dApp signing (7.6.5) — the RPC payload shape', () => {
  it('is a valid sign payload only when the request itself passes the gate', () => {
    expect(isSignRpcPayload({ externalRequest: { kind: 'transaction', transaction: TX } })).toBe(
      true
    );
    expect(
      isSignRpcPayload({ externalRequest: { kind: 'typedData', typedData: HL_ACTION } })
    ).toBe(false);
    expect(isSignRpcPayload({ externalRequest: { kind: 'nonsense' } })).toBe(false);
  });
});

describe('[Phase 7] external-dApp ceremony (7.6.5) — one prompt, one signature', () => {
  it('signs a message, typed data, and a transaction as the master EOA', async () => {
    const { client } = frameClient();
    const signer = createExternalDappSigner({ client, masterAddress: MASTER_ADDRESS });

    const message = 'app.uniswap.org wants you to sign in';
    const messageSig = await signer.signRequest({ kind: 'message', message });
    expect(
      (await recoverMessageAddress({ message, signature: messageSig })).toLowerCase()
    ).toBe(MASTER_ADDRESS.toLowerCase());

    const typedSig = await signer.signRequest({ kind: 'typedData', typedData: FOREIGN_PERMIT });
    const recoveredTyped = await recoverTypedDataAddress({
      ...(FOREIGN_PERMIT as unknown as TypedDataDefinition),
      signature: typedSig,
    });
    expect(recoveredTyped.toLowerCase()).toBe(MASTER_ADDRESS.toLowerCase());

    const serialized = await signer.signRequest({ kind: 'transaction', transaction: TX });
    const parsed = parseTransaction(serialized);
    expect(parsed.to?.toLowerCase()).toBe(TX.to.toLowerCase());
    expect(parsed.nonce).toBe(TX.nonce);
    expect(parsed.chainId).toBe(42161);
    expect(parsed.data).toBe(TX.data);
    expect(parsed.gas).toBe(BigInt(TX.gas));
  });

  it('the signed transaction recovers to the master EOA — the bytes broadcast are the bytes approved', async () => {
    const { client } = frameClient();
    const signer = createExternalDappSigner({ client, masterAddress: MASTER_ADDRESS });
    const serialized = await signer.signRequest({ kind: 'transaction', transaction: TX });
    const expected = await MASTER.signTransaction({
      type: 'eip1559',
      chainId: TX.chainId,
      to: TX.to,
      value: BigInt(TX.value),
      data: TX.data,
      nonce: TX.nonce,
      gas: BigInt(TX.gas),
      maxFeePerGas: BigInt(TX.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(TX.maxPriorityFeePerGas),
    });
    expect(serialized).toBe(expected);
  });

  it('the in-realm ceremony signs at most once — a second dApp request needs a second prompt', async () => {
    await expect(
      withExternalDappCeremony(CEREMONY_PARAMS(), async (ctx) => {
        await ctx.signRequest({ kind: 'message', message: 'first' });
        return ctx.signRequest({ kind: 'message', message: 'second' });
      })
    ).rejects.toThrow(/already consumed/i);
  });

  it("the in-realm ceremony signs as the ceremony's own derived EOA and validates the payload", async () => {
    const message = 'app.gmx.io wants you to sign in';
    const { address, signature } = await withExternalDappCeremony(
      CEREMONY_PARAMS(),
      async (ctx) => ({ address: ctx.address, signature: await ctx.signRequest({ kind: 'message', message }) })
    );
    expect((await recoverMessageAddress({ message, signature })).toLowerCase()).toBe(
      address.toLowerCase()
    );

    await expect(
      withExternalDappCeremony(CEREMONY_PARAMS(), (ctx) =>
        ctx.signRequest({ kind: 'message', message: `0x${'ab'.repeat(32)}` })
      )
    ).rejects.toThrow(/foreign payloads/i);
  });

  it('refuses a platform payload before any prompt is spent', async () => {
    const { client, calls } = frameClient();
    const signer = createExternalDappSigner({ client, masterAddress: MASTER_ADDRESS });
    await expect(
      signer.signRequest({ kind: 'typedData', typedData: HL_ACTION } as ExternalDappRequest)
    ).rejects.toThrow(/external-dApp signing accepts only foreign payloads/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a signature attributed to a different EOA — nothing reaches the dApp', async () => {
    const foreign = privateKeyToAccount(`0x${'8'.repeat(64)}`);
    const signer = createExternalDappSigner({
      client: {
        sign: async () => ({
          signature: `0x${'11'.repeat(65)}` as HexAddress,
          address: foreign.address as HexAddress,
        }),
      },
      masterAddress: MASTER_ADDRESS,
    });
    await expect(signer.signRequest({ kind: 'message', message: 'hello' })).rejects.toThrow(
      /different EOA/i
    );
  });

});

describe('[Phase 7] external-dApp signing (7.6.5) — the client gate, before anything crosses', () => {
  function rpcHarness() {
    const posted: unknown[] = [];
    const client = connectSignerRpc({
      signer: { postMessage: (message: unknown) => posted.push(message) },
      signerOrigin: 'https://signer.example.test',
      endpoint: { addEventListener: () => {}, removeEventListener: () => {} },
      timeoutMs: 50,
    });
    return { client, posted };
  }

  it('refuses an external request on the agent tier — the session key never signs for a dApp', async () => {
    const { client, posted } = rpcHarness();
    await expect(
      client.sign({ externalRequest: { kind: 'message', message: 'hello' } }, 'agent')
    ).rejects.toThrow(/master tier only/i);
    expect(posted).toHaveLength(0);
    client.close();
  });

  it('refuses a platform-shaped external request — no prompt is spent on a laundered payload', async () => {
    const { client, posted } = rpcHarness();
    await expect(
      client.sign(
        { externalRequest: { kind: 'typedData', typedData: HL_ACTION } } as never,
        'master'
      )
    ).rejects.toThrow(/invalid sign payload/i);
    expect(posted).toHaveLength(0);
    client.close();
  });

  it('posts a valid master-tier external request across the boundary', async () => {
    const { client, posted } = rpcHarness();
    void client.sign({ externalRequest: { kind: 'transaction', transaction: TX } }, 'master').catch(() => {});
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      method: 'sign',
      tier: 'master',
      payload: { externalRequest: { kind: 'transaction' } },
    });
    client.close();
  });
});

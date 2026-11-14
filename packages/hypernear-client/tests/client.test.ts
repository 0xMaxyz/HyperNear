import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { baseEncode } from 'near-api-js';
import { getAddress, hashTypedData, keccak256, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  hlPayloadDigest,
  HyperNearClient,
  HyperNearContractError,
  HyperNearDigestMismatchError,
  HyperNearMpcSignError,
  HyperNearRelayRefusedError,
  HyperNearUnsupportedActionError,
  NearMasterSigner,
  ownerIntentTypedData,
  OWNER_EXECUTE_DEPOSIT,
  REGISTER_LEG_DEPOSIT,
  type OwnerIntent,
} from '../src';
import { CONFIG, fakeSignOut, hlPayload, HL_TYPES, LEG0, LEG1, mockBackend, OWNER, USDC_TESTNET } from './helpers';

const sendAsset = (o: Record<string, unknown> = {}) => ({ type: 'sendAsset', destination: LEG1, sourceDex: 'spot', destinationDex: 'spot', token: USDC_TESTNET, amount: '1', fromSubAccount: '', nonce: 5, ...o });

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`../../../contract/tests/vectors/${name}`, import.meta.url), 'utf8'));
// well-known PUBLIC web3 test key (same as the contract vectors): never funded
const ownerAccount = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');

describe('ownerIntentTypedData', () => {
  it('matches the contract vectors (digest and viem signature) for every intent type', async () => {
    const v = vectors('owner_intents.json');
    expect(ownerAccount.address.toLowerCase()).toBe(v.owner);
    const kinds = new Set<string>();
    for (const c of v.cases) {
      const td = ownerIntentTypedData({ chainTag: v.chainTag, contractId: v.contractId, owner: v.owner, nonce: c.nonce, intent: c.intent });
      kinds.add(c.intent.type);
      expect(hashTypedData(td as never)).toBe(c.digest);
      expect(await ownerAccount.signTypedData(td as never)).toBe(c.signature);
    }
    expect(kinds.size).toBe(8); // approveAgent, withdraw, usdClassTransfer, setPolicy, freeze, cancelOrders, setTee, payTee
  });
});

describe('hlPayloadDigest', () => {
  it('matches the contract HL vectors for every action type', () => {
    const v = vectors('hl_actions.json');
    for (const c of v.cases) {
      expect(hlPayloadDigest(hlPayload(c.action, c.hyperliquidChain) as never)).toBe(c.digest);
    }
    expect(new Set(v.cases.map((c: any) => c.action.type)).size).toBe(Object.keys(HL_TYPES).length);
  });
});

function setup(o: { mode: 'agent' | 'owner'; sign?: Parameters<typeof mockBackend>[0]['sign']; nonce?: number }) {
  const m = mockBackend({
    views: {
      get_config: () => CONFIG,
      get_owner: () => (o.nonce === undefined ? null : { nonce: o.nonce }),
      get_leg: (a) => (a.leg === 0 ? LEG0 : a.leg === 1 ? LEG1 : null),
    },
    sign: o.sign ?? (() => fakeSignOut(lastPayload!)),
  });
  let lastPayload: any;
  const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
  const signOwnerIntent = vi.fn(async (td: any) => ownerAccount.signTypedData(td));
  const signer = new NearMasterSigner({ client, owner: OWNER, leg: 0, mode: o.mode, signOwnerIntent }, LEG0);
  const sign = (p: any) => {
    lastPayload = p;
    return signer.sign(p);
  };
  return { ...m, client, signer, sign, signOwnerIntent };
}

describe('NearMasterSigner, agent mode', () => {
  it('usdSend -> rebalance, returns r||s||v', async () => {
    const t = setup({ mode: 'agent' });
    const sig = await t.sign(hlPayload({ type: 'usdSend', destination: LEG1, amount: '1.5', time: 1700000000000 }));
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      method: 'rebalance',
      args: { owner: OWNER, from_leg: 0, to_address: LEG1, amount: '1.5', hl_time: 1700000000000 },
    });
    expect(t.calls[0].opts?.deposit ?? 0n).toBe(0n); // function-call keys cannot attach deposits
    expect(sig).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}1c`);
  });

  it('usdClassTransfer toPerp:true -> agent_usd_class_transfer', async () => {
    const t = setup({ mode: 'agent' });
    await t.sign(hlPayload({ type: 'usdClassTransfer', amount: '2', toPerp: true, nonce: 5 }));
    expect(t.calls[0]).toMatchObject({ method: 'agent_usd_class_transfer', args: { owner: OWNER, leg: 0, amount: '2', to_perp: true, hl_nonce: 5 } });
  });

  it('sendAsset spot USDC -> rebalance_spot (the unified-account move)', async () => {
    const t = setup({ mode: 'agent' });
    await t.sign(hlPayload(sendAsset({ amount: '2.5', nonce: 77 })));
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: 'rebalance_spot', args: { owner: OWNER, from_leg: 0, to_address: LEG1, amount: '2.5', hl_nonce: 77 } });
    expect(t.calls[0].opts?.deposit ?? 0n).toBe(0n);
  });

  it.each([
    ['sendAsset from a perp dex', sendAsset({ sourceDex: '' })],
    ['sendAsset to a perp dex', sendAsset({ destinationDex: '' })],
    ['sendAsset from a sub-account', sendAsset({ fromSubAccount: LEG0 })],
    ['sendAsset of another token', sendAsset({ token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90' })],
    ['sendAsset to a checksummed destination', sendAsset({ destination: getAddress(LEG1) })],
    ['perp -> spot', { type: 'usdClassTransfer', amount: '2', toPerp: false, nonce: 5 }],
    ['withdraw', { type: 'withdraw3', destination: OWNER, amount: '2', time: 5 }],
    ['approveAgent', { type: 'approveAgent', agentAddress: LEG1, agentName: 'x', nonce: 5 }],
    ['checksummed destination', { type: 'usdSend', destination: getAddress(LEG1), amount: '1', time: 5 }],
    ['7 decimals', { type: 'usdSend', destination: LEG1, amount: '0.0000001', time: 5 }],
    ['zero amount', { type: 'usdSend', destination: LEG1, amount: '0.0', time: 5 }],
  ])('refuses %s before any NEAR call', async (_n, action) => {
    const t = setup({ mode: 'agent' });
    await expect(t.sign(hlPayload(action as any))).rejects.toBeInstanceOf(HyperNearUnsupportedActionError);
    expect(t.calls).toHaveLength(0);
  });

  it('refuses a payload for another domain chain id or HL network', async () => {
    const t = setup({ mode: 'agent' });
    const a = { type: 'usdSend', destination: LEG1, amount: '1', time: 5 };
    await expect(t.sign(hlPayload(a, 'Testnet', 0xa4b1))).rejects.toThrow(/0x66eee/);
    await expect(t.sign(hlPayload(a, 'Mainnet'))).rejects.toThrow(/hyperliquidChain/);
    expect(t.calls).toHaveLength(0);
  });

  it('refuses an unknown primary type', async () => {
    const t = setup({ mode: 'agent' });
    const p = hlPayload({ type: 'usdSend', destination: LEG1, amount: '1', time: 5 });
    await expect(t.sign({ ...p, primaryType: 'HyperliquidTransaction:SpotSend' })).rejects.toBeInstanceOf(HyperNearUnsupportedActionError);
  });
});

describe('NearMasterSigner, owner mode', () => {
  it('usdClassTransfer -> owner_execute with the owner nonce, a valid owner signature and a storage deposit', async () => {
    const t = setup({ mode: 'owner', nonce: 7 });
    await t.sign(hlPayload({ type: 'usdClassTransfer', amount: '1', toPerp: false, nonce: 99 }));
    const intent: OwnerIntent = { type: 'usdClassTransfer', leg: 0, amount: '1', toPerp: false, hlNonce: 99 };
    expect(t.calls[0]).toMatchObject({ method: 'owner_execute', args: { owner: OWNER, nonce: 7, intent } });
    expect(t.calls[0].opts?.deposit).toBe(OWNER_EXECUTE_DEPOSIT);
    const td = t.signOwnerIntent.mock.calls[0][0];
    expect(td).toEqual(ownerIntentTypedData({ chainTag: 'near-testnet', contractId: 'leash.testnet', owner: OWNER, nonce: 7, intent }));
    expect((await recoverTypedDataAddress({ ...(td as any), signature: t.calls[0].args.signature })).toLowerCase()).toBe(OWNER);
  });

  it('new owner: nonce 0', async () => {
    const t = setup({ mode: 'owner' });
    await t.sign(hlPayload({ type: 'withdraw3', destination: OWNER, amount: '2.5', time: 3 }));
    expect(t.calls[0].args).toMatchObject({ nonce: 0, intent: { type: 'withdraw', leg: 0, amount: '2.5', hlTime: 3 } });
  });

  it('approveAgent lowercases the agent (address type: same hash)', async () => {
    const t = setup({ mode: 'owner', nonce: 1 });
    await t.sign(hlPayload({ type: 'approveAgent', agentAddress: getAddress(LEG1), agentName: 'bot', nonce: 4 }));
    expect(t.calls[0].args.intent).toEqual({ type: 'approveAgent', leg: 0, agent: LEG1, agentName: 'bot', hlNonce: 4 });
  });

  it.each([
    ['withdraw to someone else', { type: 'withdraw3', destination: LEG1, amount: '1', time: 1 }],
    ['withdraw to the checksummed owner', { type: 'withdraw3', destination: getAddress(OWNER), amount: '1', time: 1 }],
    ['usdSend', { type: 'usdSend', destination: LEG1, amount: '1', time: 1 }],
  ])('refuses %s before signing or calling', async (_n, action) => {
    const t = setup({ mode: 'owner', nonce: 1 });
    await expect(t.sign(hlPayload(action as any))).rejects.toBeInstanceOf(HyperNearUnsupportedActionError);
    expect(t.calls).toHaveLength(0);
    expect(t.signOwnerIntent).not.toHaveBeenCalled();
  });

  it('needs signOwnerIntent', () => {
    const { backend } = mockBackend({});
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend });
    expect(() => new NearMasterSigner({ client, owner: OWNER, leg: 0, mode: 'owner' }, LEG0)).toThrow(HyperNearUnsupportedActionError);
  });
});

describe('NearMasterSigner errors', () => {
  it('null result (MPC sign failed) -> HyperNearMpcSignError', async () => {
    const t = setup({ mode: 'agent', sign: () => null });
    await expect(t.sign(hlPayload({ type: 'usdSend', destination: LEG1, amount: '1', time: 5 }))).rejects.toBeInstanceOf(HyperNearMpcSignError);
  });

  it('contract signed another digest -> HyperNearDigestMismatchError', async () => {
    const t = setup({ mode: 'agent', sign: () => fakeSignOut(hlPayload({ type: 'usdSend', destination: LEG1, amount: '9', time: 5 })) });
    await expect(t.sign(hlPayload({ type: 'usdSend', destination: LEG1, amount: '1', time: 5 }))).rejects.toBeInstanceOf(HyperNearDigestMismatchError);
  });

  it('contract panic -> HyperNearContractError', async () => {
    const m = mockBackend({ views: { get_config: () => CONFIG }, fail: () => 'Smart contract panicked: daily cap exceeded' });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    const s = new NearMasterSigner({ client, owner: OWNER, leg: 0, mode: 'agent' }, LEG0);
    await expect(s.sign(hlPayload({ type: 'usdSend', destination: LEG1, amount: '1', time: 5 }))).rejects.toThrow(/daily cap exceeded/);
  });
});

describe('HyperNearClient', () => {
  it('NearMasterSigner.create uses the registered leg, else derives it', async () => {
    const m = mockBackend({
      views: {
        get_config: () => CONFIG,
        get_leg: (a) => (a.leg === 0 ? LEG0 : null),
        derived_public_key: () => `secp256k1:${baseEncode(new Uint8Array(64).fill(1))}`,
      },
    });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    expect((await NearMasterSigner.create({ client, owner: OWNER, leg: 0, mode: 'agent' })).address).toBe(LEG0);
    const derived = await NearMasterSigner.create({ client, owner: OWNER, leg: 5, mode: 'agent' });
    expect(derived.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(m.views.at(-1)).toMatchObject({
      contractId: 'v1.signer-prod.testnet',
      method: 'derived_public_key',
      args: { path: `${OWNER}/leg5`, predecessor: 'leash.testnet', domain_id: 0 },
    });
  });

  it('deriveLegAddress = keccak of the 64-byte key', async () => {
    const raw = new Uint8Array(64).fill(2);
    const key = `secp256k1:${baseEncode(raw)}`;
    const m = mockBackend({ views: { get_config: () => CONFIG, derived_public_key: () => key } });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    expect(await client.deriveLegAddress(OWNER, 0)).toBe(`0x${keccak256(raw).slice(-40)}`);
  });

  it('registerLeg is idempotent', async () => {
    let registered: Hex | null = null;
    const m = mockBackend({
      views: { get_leg: () => registered },
      sign: () => {
        registered = LEG0;
        return LEG0 as never;
      },
    });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    expect(await client.registerLeg(OWNER, 0)).toBe(LEG0);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ method: 'register_leg', args: { owner: OWNER, leg: 0 }, opts: { deposit: REGISTER_LEG_DEPOSIT } });
    expect(await client.registerLeg(OWNER, 0)).toBe(LEG0);
    expect(m.calls).toHaveLength(1);
  });

  it('registerLeg treats "already registered" (a race) as success', async () => {
    let calls = 0;
    const m = mockBackend({
      views: { get_leg: () => (calls++ === 0 ? null : LEG0) },
      fail: () => 'Smart contract panicked: leg already registered',
    });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    expect(await client.registerLeg(OWNER, 0)).toBe(LEG0);
  });

  it('registerLeg surfaces other failures', async () => {
    const m = mockBackend({ views: { get_leg: () => null }, fail: () => 'attach 5 mNEAR for storage' });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    await expect(client.registerLeg(OWNER, 0)).rejects.toBeInstanceOf(HyperNearContractError);
  });

  it('relaySubmit refuses an owner without that leg registered, sends otherwise', async () => {
    const m = mockBackend({ views: { get_leg: (a) => (a.leg === 0 ? LEG0 : null) }, sign: () => null });
    const client = new HyperNearClient({ contractId: 'leash.testnet', backend: m.backend });
    const sig = '0x00' as Hex;
    await expect(
      client.relaySubmit({ owner: OWNER, nonce: 0, intent: { type: 'withdraw', leg: 3, amount: '1', hlTime: 1 } }, sig)
    ).rejects.toBeInstanceOf(HyperNearRelayRefusedError);
    expect(m.calls).toHaveLength(0);
    await client.relaySubmit({ owner: OWNER, nonce: 0, intent: { type: 'freeze', frozen: true } }, sig); // checks leg 0
    expect(m.calls[0]).toMatchObject({ method: 'owner_execute', opts: { deposit: OWNER_EXECUTE_DEPOSIT } });
  });

  it('getOwnerNonce is 0 for an unknown owner', async () => {
    const m = mockBackend({ views: { get_owner: () => null } });
    expect(await new HyperNearClient({ contractId: 'x', backend: m.backend }).getOwnerNonce(OWNER)).toBe(0);
  });
});

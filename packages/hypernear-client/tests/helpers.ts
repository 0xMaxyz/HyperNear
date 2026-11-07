import type { HlSignPayload } from '@perps-platform/core';
import { hlPayloadDigest, type NearBackend, type SignOut } from '../src';

const chain = { name: 'hyperliquidChain', type: 'string' };
/** HL action type -> [primaryType, fields], as hyperliquid-python-sdk signing.py defines them. */
export const HL_TYPES: Record<string, [string, { name: string; type: string }[]]> = {
  approveAgent: ['HyperliquidTransaction:ApproveAgent', [chain, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }]],
  usdSend: ['HyperliquidTransaction:UsdSend', [chain, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }]],
  withdraw3: ['HyperliquidTransaction:Withdraw', [chain, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }]],
  usdClassTransfer: ['HyperliquidTransaction:UsdClassTransfer', [chain, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' }]],
};

/** The payload shape the HL SDK hands a signer for a user-signed action. */
export function hlPayload(
  action: { type: string } & Record<string, unknown>,
  hyperliquidChain = 'Testnet',
  chainId = 0x66eee
): HlSignPayload {
  const [primaryType, fields] = HL_TYPES[action.type];
  const { type: _t, ...rest } = action;
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: {
      [primaryType]: fields,
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
    primaryType,
    message: { ...rest, hyperliquidChain },
  };
}

export const OWNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' as const;
export const LEG0 = '0xfc5f38a75535cc6a864bb5ba14d9c7f29eecacac' as const;
export const LEG1 = '0x8056c4fa3aad69cf04c2ade906c58489e76c9986' as const;

export interface Recorded {
  contractId: string;
  method: string;
  args: any;
  opts?: { deposit?: bigint; gasTgas?: number };
}

/** A NEAR backend that records calls. `sign` decides what the contract "returns" for a signing call. */
export function mockBackend(o: {
  views?: Record<string, (args: any) => unknown>;
  sign?: (r: Recorded) => SignOut | null;
  fail?: (r: Recorded) => string | undefined;
}) {
  const calls: Recorded[] = [];
  const views: Recorded[] = [];
  const backend: NearBackend = {
    async view<T>(contractId: string, method: string, args: Record<string, unknown>) {
      views.push({ contractId, method, args });
      const f = o.views?.[method];
      if (!f) throw new Error(`unexpected view ${method}`);
      return f(args) as T;
    },
    async call<T>(contractId: string, method: string, args: Record<string, unknown>, opts?: Recorded['opts']) {
      const r = { contractId, method, args, opts };
      calls.push(r);
      const msg = o.fail?.(r);
      if (msg) {
        const { HyperNearContractError } = await import('../src');
        throw new HyperNearContractError(`${method} failed: ${msg}`);
      }
      return { txHash: `tx${calls.length}`, value: (o.sign ? o.sign(r) : null) as T };
    },
  };
  return { backend, calls, views };
}

export const CONFIG = { admin: 'leash.testnet', mpc_contract: 'v1.signer-prod.testnet', hl_mainnet: false, chain_tag: 'near-testnet' };

/** A SignOut whose payload is the payload's real digest (what a correct contract returns). */
export function fakeSignOut(payload: HlSignPayload, recovery_id = 1): SignOut {
  return { payload: hlPayloadDigest(payload as never).slice(2), big_r: `03${'11'.repeat(32)}`, s: '22'.repeat(32), recovery_id, action: null };
}

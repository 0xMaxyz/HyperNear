import { concat, hashDomain, hashStruct, keccak256, type Hex, type TypedDataDomain } from 'viem';

interface PayloadLike {
  domain: TypedDataDomain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const DEFAULT_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/**
 * EIP-712 digest of a Hyperliquid sign payload. Built from viem's parts because viem's `hashTypedData`
 * rejects the ":" in `HyperliquidTransaction:*` struct names on some versions.
 */
export function hlPayloadDigest(payload: PayloadLike): Hex {
  const { EIP712Domain, ...types } = payload.types;
  return keccak256(
    concat([
      '0x1901',
      hashDomain({ domain: payload.domain, types: { EIP712Domain: EIP712Domain ?? DEFAULT_DOMAIN_TYPE } } as never),
      hashStruct({ data: payload.message, primaryType: payload.primaryType, types } as never),
    ])
  );
}

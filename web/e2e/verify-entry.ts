// Bundled by shots.mjs (esbuild): recovers the signer of a request body with the same builders the page signs with.
import { recoverTypedDataAddress, type Hex } from 'viem';
import { commandTypedData, ownerIntentTypedData } from '../src/hypernear';

type TD = { domain: object; types: object; primaryType: string; message: object };
const recover = (td: TD, signature: Hex) => recoverTypedDataAddress({ ...(td as object), signature } as never).then((a) => a.toLowerCase());

export const intentSigner = (b: any, chainTag: any, contractId: string) =>
  recover(ownerIntentTypedData({ chainTag, contractId, owner: b.owner, nonce: b.nonce, intent: b.intent }), b.sig);
export const commandSigner = (b: any, chainTag: any, contractId: string) => recover(commandTypedData(chainTag, contractId, b.command), b.sig);

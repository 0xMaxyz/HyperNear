// Bundled by mock-agent.mjs (esbuild) so the mock checks signatures with the same builders the page uses.
import { recoverTypedDataAddress, type Hex } from 'viem';
import { commandTypedData, ownerIntentTypedData } from '../src/hypernear';

type TD = { domain: object; types: object; primaryType: string; message: object };
const recover = (td: TD, signature: Hex) => recoverTypedDataAddress({ ...(td as object), signature } as never).then((a) => a.toLowerCase());

export async function intentSigner(b: any, chainTag: any, contractId: string) {
  return recover(ownerIntentTypedData({ chainTag, contractId, owner: b.owner, nonce: b.nonce, intent: b.intent }), b.sig);
}
export async function commandSigner(b: any, chainTag: any, contractId: string) {
  return recover(commandTypedData(chainTag, contractId, b.command), b.sig);
}

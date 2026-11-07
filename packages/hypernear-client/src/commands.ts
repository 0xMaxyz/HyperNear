// Owner-signed commands for the agent service (off-chain): EIP-712 `Command` under the same HyperNear domain as the
// owner intents, with its own primary type, so a command can never be replayed as an on-chain intent or back.
import { recoverTypedDataAddress, type Hex } from 'viem';
import { hypernearDomain, type ChainTag, type OwnerIntentTypedData } from './intents';

export type CommandAction = 'openHedge' | 'closeHedge';

export interface Command {
  owner: Hex;
  action: CommandAction;
  coin: string;
  /** decimal string ("0.5"); "0" when the action takes none (closeHedge) */
  ratio: string;
  /** unix seconds; the agent service refuses expiries more than 60 s ahead */
  expiry: number;
  /** any unused uint64 (e.g. Date.now()); the service keeps a replay cache */
  nonce: number;
}

export const COMMAND_TYPES = {
  Command: [
    { name: 'owner', type: 'address' },
    { name: 'action', type: 'string' },
    { name: 'coin', type: 'string' },
    { name: 'ratio', type: 'string' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/** Typed data for viem / Privy `signTypedData` (add `EIP712Domain: HYPERNEAR_DOMAIN_TYPE` for raw eth_signTypedData_v4). */
export function commandTypedData(chainTag: ChainTag, contractId: string, c: Command): OwnerIntentTypedData {
  return {
    domain: hypernearDomain(chainTag, contractId),
    types: COMMAND_TYPES,
    primaryType: 'Command',
    message: { ...c, owner: c.owner.toLowerCase() },
  };
}

/** Convenience for clients: a command expiring in `ttlSec` (default 30 s), nonce = now in ms. */
export function newCommand(owner: Hex, action: CommandAction, coin: string, ratio = '0', ttlSec = 30, nowMs = Date.now()): Command {
  return { owner: owner.toLowerCase() as Hex, action, coin, ratio, expiry: Math.floor(nowMs / 1000) + ttlSec, nonce: nowMs };
}

export async function recoverCommandSigner(chainTag: ChainTag, contractId: string, c: Command, signature: Hex): Promise<Hex> {
  const td = commandTypedData(chainTag, contractId, c);
  return (await recoverTypedDataAddress({ ...(td as never), signature })).toLowerCase() as Hex;
}

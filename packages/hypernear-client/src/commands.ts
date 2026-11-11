// Owner-signed commands for the agent service (off-chain): EIP-712 `Command` under the same HyperNear domain as the
// owner intents, with its own primary type, so a command can never be replayed as an on-chain intent or back.
import { recoverTypedDataAddress, type Hex } from 'viem';
import { hypernearDomain, type ChainTag, type OwnerIntentTypedData } from './intents';

/** The decision layer's actions (agent/src/decide.ts ACTIONS); accepting a proposal signs one of these. */
export type DecisionAction = 'hold' | 'close_both' | 'reduce_hedge' | 'add_hedge' | 'take_profit';

/** setDecisionMode: the mode ('off' | 'propose' | 'auto') goes in `coin`, ratio "0". prepareAgents: coin "", ratio "0".
 * reject: dismisses a proposal, coin = the proposal's coin.
 * startStrategy: coin "", specHash = specHash(spec) of the spec sent beside the command;
 * pauseStrategy / stopStrategy: coin = the strategy id. ratio "0" for all three.
 * placeOrder / cancelOrder: coin "", ratio "0", specHash = specHash(spec) of the order or cancel spec sent beside the command
 * (agent/src/order.ts), so the owner signs exactly the order that runs.
 * startSession: coin "", ratio "0", specHash = specHash(SessionSpec) sent beside the command (owner only, never a session key).
 * endSession: coin = the session key's address, ratio "0", zero specHash; signed by the owner or by that session key.
 * modifyOrder: coin "", ratio "0", specHash = specHash({leg, coin, oid, limitPx}): moves one resting limit order to a new price.
 * placeOrder / cancelOrder / modifyOrder may also be signed by a live session key of `owner` (session.ts). */
export type CommandAction = 'openHedge' | 'closeHedge' | DecisionAction | 'setDecisionMode' | 'prepareAgents' | 'reject' | 'startStrategy' | 'pauseStrategy' | 'stopStrategy' | 'placeOrder' | 'cancelOrder' | 'modifyOrder' | 'startSession' | 'endSession' | 'continue_strategy' | 'pause_strategy' | 'adjust_strategy';

export interface Command {
  owner: Hex;
  action: CommandAction;
  /** coin, or the mode for setDecisionMode */
  coin: string;
  /** decimal string ("0.5"); "0" when the action takes none (closeHedge) */
  ratio: string;
  /** unix seconds; the agent service refuses expiries more than 60 s ahead */
  expiry: number;
  /** any unused uint64 (e.g. Date.now()); the service keeps a replay cache */
  nonce: number;
  /** bytes32: the spec's hash for the spec-bearing actions (SPEC_ACTIONS), ZERO_SPEC_HASH for every other one; openHedge may carry a hedge spec's hash */
  specHash: Hex;
}

/** specHash of every non-strategy command. */
export const ZERO_SPEC_HASH = `0x${'0'.repeat(64)}` as Hex;

export const COMMAND_TYPES = {
  Command: [
    { name: 'owner', type: 'address' },
    { name: 'action', type: 'string' },
    { name: 'coin', type: 'string' },
    { name: 'ratio', type: 'string' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'specHash', type: 'bytes32' },
  ],
} as const;

/** Typed data for viem / Privy `signTypedData` (add `EIP712Domain: HYPERNEAR_DOMAIN_TYPE` for raw eth_signTypedData_v4). */
export function commandTypedData(chainTag: ChainTag, contractId: string, c: Command): OwnerIntentTypedData {
  return {
    domain: hypernearDomain(chainTag, contractId),
    types: COMMAND_TYPES,
    primaryType: 'Command',
    message: { ...c, owner: c.owner.toLowerCase(), specHash: c.specHash.toLowerCase() },
  };
}

/** Convenience for clients: a command expiring in `ttlSec` (default 30 s), nonce = now in ms; specHash only for startStrategy. */
export function newCommand(owner: Hex, action: CommandAction, coin: string, ratio = '0', ttlSec = 30, nowMs = Date.now(), specHash: Hex = ZERO_SPEC_HASH): Command {
  return { owner: owner.toLowerCase() as Hex, action, coin, ratio, expiry: Math.floor(nowMs / 1000) + ttlSec, nonce: nowMs, specHash: specHash.toLowerCase() as Hex };
}

export async function recoverCommandSigner(chainTag: ChainTag, contractId: string, c: Command, signature: Hex): Promise<Hex> {
  const td = commandTypedData(chainTag, contractId, c);
  return (await recoverTypedDataAddress({ ...(td as object), signature } as never)).toLowerCase() as Hex;
}

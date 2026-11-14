// One USDC move between two legs of the same owner, signed through the contract with the NEAR agent's function-call key
// (`rebalance` for a default-mode leg, `rebalance_spot` for a unified one). The guard top-up and the owner's rebalance both use it,
// so cap, cooldown and the own-legs-only destination rule are the contract's, not ours.
import type { Hex } from 'viem';
import { NearMasterSigner, type HyperNearClient } from '@hypernear/client';
import { USDC_TOKEN } from './funds.ts';
import type { Legs } from './legs.ts';
import { hlClient } from './market.ts';

export type Transfer = 'usdSend' | 'sendAsset';

export async function sendBetweenLegs(o: {
  legs: Legs;
  agentClient: HyperNearClient;
  owner: Hex;
  from: { leg: number; address: Hex };
  to: Hex;
  amount: string;
  transfer: Transfer;
  onNearTx?: (tx: { method: string; txHash: string }) => void;
}): Promise<unknown> {
  const master = await NearMasterSigner.create({ client: o.agentClient, owner: o.owner, leg: o.from.leg, mode: 'agent', legAddress: o.from.address, onNearTx: o.onNearTx });
  const hl = hlClient(o.legs.network, { master });
  return o.transfer === 'sendAsset'
    ? hl.sendAsset({ destination: o.to, sourceDex: 'spot', destinationDex: 'spot', token: USDC_TOKEN[o.legs.network], amount: o.amount })
    : hl.usdSend({ destination: o.to, amount: o.amount });
}

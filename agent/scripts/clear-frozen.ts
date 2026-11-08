// Clears the resting orders of a FROZEN owner with no agent server at all: anyone with a NEAR account can do it, because
// the contract's `cancel_orders` is permissionless while the owner is frozen and only signs Hyperliquid cancels for the
// owner's registered legs (a cancel cannot move funds).
//   NEAR_ACCOUNT_ID=you.testnet NEAR_PRIVATE_KEY=ed25519:... node agent/scripts/clear-frozen.ts 0x<owner>
// Optional: NEAR_NETWORK (testnet | mainnet; default testnet), NEAR_CONTRACT_ID (default leash-spike-1107.testnet), NEAR_RPC_URL.
// Any NEAR account works (it only pays gas, about 0.001 NEAR per call). The key is read from the environment and never printed.
// For an owner who is NOT frozen, the owner signs a `cancelOrders` intent instead (see packages/hypernear-client).
import type { Hex } from 'viem';
import { DEFAULT_RPC, HyperNearClient, nearAccount } from '@hypernear/client';
import { hlClient } from '../src/market.ts';
import { clearFrozen } from '../src/sweep.ts';

const owner = process.argv[2]?.toLowerCase() as Hex | undefined;
const { NEAR_ACCOUNT_ID: account, NEAR_PRIVATE_KEY: key } = process.env;
if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('usage: clear-frozen.ts 0x<owner address>');
if (!account || !key) throw new Error('set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY (any NEAR account; it pays gas)');
const network = process.env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const contractId = process.env.NEAR_CONTRACT_ID ?? 'leash-spike-1107.testnet';
const rpc = process.env.NEAR_RPC_URL ?? DEFAULT_RPC[network];

const client = new HyperNearClient({ contractId, network, rpcUrl: rpc, sender: nearAccount(account, key, rpc) });
const legs = await clearFrozen(owner, { client, hl: hlClient(network), network });
for (const l of legs) {
  console.log(`leg ${l.leg} ${l.address}: ${l.found} open, ${l.cancelled} cancelled${l.skipped ? `, ${l.skipped} spot skipped` : ''}${l.txHashes.length ? `, txs ${l.txHashes.join(' ')}` : ''}${l.hl.length ? `, HL ${l.hl.join(',')}` : ''}${l.error ? `, ERROR ${l.error}` : ''}`);
}
const failed = legs.filter((l) => l.error || l.hl.some((h) => h !== 'ok'));
console.log(failed.length ? `${failed.length} leg(s) failed` : `done: ${legs.reduce((a, l) => a + l.cancelled, 0)} orders cancelled`);
process.exit(failed.length ? 1 : 0);

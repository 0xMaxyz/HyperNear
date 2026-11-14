// Frozen-account sweep: after a freeze the agents are revoked, but orders already on the book stay. The contract's
// `cancel_orders` (permissionless while the owner is frozen) signs HL L1 cancels for a leg; this reads each leg's open
// orders from HL info (public, no key), asks the contract to sign the cancels, and posts them. Used by the server after a
// relayed freeze and, with no server at all, by agent/scripts/clear-frozen.ts. A failure on one leg never stops the others.
import type { Hex } from 'viem';
import { postL1, type CancelBatch, type HlCancel, type HlExchangeResponse, type HyperNearClient } from '@hypernear/client';
import { HL_API_URLS, hlExchangeFetch, type HlClient } from '@perps-platform/core';

/** What happened to one leg's book. */
export interface LegSweep {
  leg: number;
  address: Hex;
  /** open orders found on the leg (perp orders we could address, plus `skipped`) */
  found: number;
  /** orders that are not perp orders (spot): not cancelled here */
  skipped: number;
  /** orders HL answered "success" for */
  cancelled: number;
  /** NEAR transactions of the cancel_orders calls (16 cancels each at most) */
  txHashes: string[];
  /** one entry per batch: 'ok' or why HL or the post failed */
  hl: string[];
  error?: string;
}

export interface SweepPorts {
  /** The owner's registered legs. */
  legs(owner: Hex): Promise<{ leg: number; address: Hex }[]>;
  /** Open orders as HL cancel entries (asset index, oid); `skipped` counts the ones with no perp asset index. */
  openOrders(address: Hex): Promise<{ cancels: HlCancel[]; skipped: number }>;
  /** client.cancelFrozen: contract-signed cancels, batched by 16; `onBatch` runs as each batch is signed. */
  cancelFrozen(args: { owner: Hex; leg: number; cancels: HlCancel[]; onBatch: (b: CancelBatch) => Promise<void> }): Promise<unknown>;
  post(out: CancelBatch['out']): Promise<HlExchangeResponse>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "success" statuses of an HL cancel answer. */
function successes(r: HlExchangeResponse): number {
  return r.status === 'ok' ? (r.response?.data?.statuses ?? []).filter((s) => s === 'success').length : 0;
}

export async function sweepFrozen(owner: Hex, ports: SweepPorts): Promise<LegSweep[]> {
  const out: LegSweep[] = [];
  for (const { leg, address } of await ports.legs(owner)) {
    const r: LegSweep = { leg, address, found: 0, skipped: 0, cancelled: 0, txHashes: [], hl: [] };
    out.push(r);
    try {
      const { cancels, skipped } = await ports.openOrders(address);
      r.found = cancels.length + skipped;
      r.skipped = skipped;
      if (!cancels.length) continue;
      await ports.cancelFrozen({
        owner,
        leg,
        cancels,
        onBatch: async (b) => {
          r.txHashes.push(b.txHash);
          try {
            const res = await ports.post(b.out);
            r.cancelled += successes(res);
            r.hl.push(res.status === 'ok' ? 'ok' : `err: ${res.response}`);
          } catch (e) {
            r.hl.push(`post failed: ${msg(e)}`); // the next batch is still signed and posted
          }
        },
      });
    } catch (e) {
      r.error = msg(e);
    }
  }
  return out;
}

/** The event the server emits (and the dry run replays): one entry per leg, never thrown. */
export const sweptEvent = (owner: Hex, legs: LegSweep[], ms: number, error?: string) => ({
  owner,
  trigger: 'freeze' as const,
  legs,
  cancelled: legs.reduce((a, l) => a + l.cancelled, 0),
  ms,
  ...(error ? { error } : {}),
});

/** Real ports: NEAR calls through `client` (any NEAR account's key; the contract only checks that the owner is frozen). */
export function livePorts(o: { client: HyperNearClient; hl: Pick<HlClient, 'meta' | 'openOrders'>; network: 'mainnet' | 'testnet'; maxLegs?: number }): SweepPorts {
  let assets: Promise<Map<string, number>> | undefined;
  const assetOf = () => (assets ??= o.hl.meta().then((m) => new Map(m.universe.map((u, i) => [u.name, i] as const))));
  return {
    async legs(owner) {
      const addrs = await Promise.all([...Array(o.maxLegs ?? 8).keys()].map((i) => o.client.getLeg(owner, i)));
      return addrs.flatMap((address, leg) => (address ? [{ leg, address }] : []));
    },
    async openOrders(address) {
      const [orders, map] = await Promise.all([o.hl.openOrders({ user: address }), assetOf()]);
      const cancels: HlCancel[] = [];
      let skipped = 0;
      for (const x of orders) {
        const a = map.get(x.coin);
        if (a === undefined) skipped++;
        else cancels.push({ a, o: x.oid });
      }
      return { cancels, skipped };
    },
    cancelFrozen: (args) => o.client.cancelFrozen(args),
    post: (out) => postL1(out, o.network, hlExchangeFetch(HL_API_URLS[o.network])),
  };
}

/** For the script and the live test: refuses an owner that is not frozen, then sweeps every registered leg. */
export async function clearFrozen(owner: Hex, o: Parameters<typeof livePorts>[0]): Promise<LegSweep[]> {
  const st = await o.client.getOwner(owner);
  if (!st) throw new Error(`owner ${owner} is unknown to the contract`);
  if (!st.frozen) throw new Error(`owner ${owner} is not frozen: cancel_orders only works on a frozen owner (an unfrozen owner signs a cancelOrders intent)`);
  return sweepFrozen(owner, livePorts(o));
}

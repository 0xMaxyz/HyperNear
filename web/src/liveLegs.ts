// Live account data for the owner's legs straight from Hyperliquid (positions, open orders, fills), merged over the polled agent view.
// The agent view (every 10 s, 30 s while the socket is live) stays the source for everything only the agent knows; a pushed clearinghouse
// state replaces a leg's polled one only when it is newer, so a slow poll never overwrites a fresher push. Fees, funding, history labels
// and order details are computed by the agent, so a live fill or order change only makes the page refetch them (debounced).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerView } from './api';
import { hubFor, type SocketState } from './hlSocket';

type Clearinghouse = OwnerView['snapshot']['legs'][number]['clearinghouse'];
export interface LiveLeg {
  /** Hyperliquid's own time of the state */
  at: number;
  ch: Clearinghouse;
}
export interface Live {
  state: SocketState;
  legs: Record<string, LiveLeg>;
  /** last live fill / order change (ms); 0 if none yet */
  eventAt: number;
}

const REFETCH_DEBOUNCE_MS = 400;

export function useLiveLegs(view: OwnerView | undefined): Live {
  const network = view?.config?.hlNetwork ?? 'testnet';
  // the dry run has no network: recorded data and polling only
  const enabled = Boolean(view) && !view?.dryRun;
  const addresses = (view?.snapshot.legs ?? []).map((l) => l.address.toLowerCase()).join(',');
  const [state, setState] = useState<SocketState>('idle');
  const [legs, setLegs] = useState<Record<string, LiveLeg>>({});
  const [eventAt, setEventAt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!enabled || !addresses) {
      setState('idle');
      return;
    }
    const hub = hubFor(network);
    const offState = hub.onState(setState);
    setState(hub.state);
    const bump = () => {
      if (timer.current) return; // joins the refetch already scheduled, so a steady stream cannot postpone it forever
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setEventAt(Date.now());
      }, REFETCH_DEBOUNCE_MS);
    };
    const offs = addresses.split(',').flatMap((user) => {
      let lastOrders: string | undefined;
      return [
        hub.subscribe({ type: 'clearinghouseState', user }, (d) => {
          const c = (d as { clearinghouseState?: Clearinghouse & { time?: number } }).clearinghouseState;
          if (c) setLegs((l) => ({ ...l, [user]: { at: c.time ?? Date.now(), ch: c } }));
        }),
        // the first openOrders message is the snapshot; a later one counts only when the orders differ from the last one
        hub.subscribe({ type: 'openOrders', user }, (d) => {
          const sig = JSON.stringify(((d as { orders?: { oid: number; sz: string; limitPx: string }[] }).orders ?? []).map((o) => [o.oid, o.sz, o.limitPx]));
          if (lastOrders !== undefined && sig !== lastOrders) bump();
          lastOrders = sig;
        }),
        hub.subscribe({ type: 'userFills', user }, (d) => !(d as { isSnapshot?: boolean }).isSnapshot && bump()),
      ];
    });
    return () => {
      offs.forEach((f) => f());
      offState();
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [enabled, network, addresses]);

  return useMemo(() => ({ state: enabled ? state : ('idle' as SocketState), legs, eventAt }), [enabled, state, legs, eventAt]);
}

/** The polled view with newer pushed leg states on top; `snapshot.at` moves forward on a live fill so the pages that refetch on it do. */
export function overlayLive(view: OwnerView | undefined, live: Live): OwnerView | undefined {
  if (!view || (live.state !== 'live' && live.eventAt === 0)) return view;
  const base = view.snapshot.at;
  const legs = view.snapshot.legs.map((l) => {
    const p = live.legs[l.address.toLowerCase()];
    // both sides carry Hyperliquid's own `time`; the agent's snapshot clock is only the fallback
    const polledAt = (l.clearinghouse as { time?: number }).time ?? base;
    return p && p.at > polledAt ? { ...l, clearinghouse: p.ch } : l;
  });
  return { ...view, snapshot: { ...view.snapshot, legs, at: Math.max(base, live.eventAt) } };
}

export function useOverlay(view: OwnerView | undefined, live: Live): OwnerView | undefined {
  return useMemo(() => overlayLive(view, live), [view, live]);
}

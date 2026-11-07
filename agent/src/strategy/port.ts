// What a runner needs from Hyperliquid, as one small interface (a fake in tests, the leg's agent key live).
import type { Hex } from 'viem';
import { RelayRejectionError } from '@perps-platform/core';
import type { Legs } from '../legs.ts';
import { position, roundPx } from '../market.ts';

export interface CoinInfo {
  asset: number;
  szDecimals: number;
  mid: number;
}

export interface PlaceRequest {
  asset: number;
  isBuy: boolean;
  px: string;
  sz: string;
  reduceOnly: boolean;
  /** Alo: post-only (grid); Ioc: take what the book gives within the price (twap) */
  tif?: 'Alo' | 'Ioc';
}

export interface TradingPort {
  info(coin: string): Promise<CoinInfo>;
  openOids(): Promise<Set<string>>;
  filledOids(): Promise<Set<string>>;
  /** Signed position size of the coin on the leg. */
  position(coin: string): Promise<number>;
  /** Account value (USD) of the leg. */
  equity(): Promise<number>;
  setLeverage(asset: number, leverage: number): Promise<void>;
  /** Post-only limit order; `error` carries the exchange's refusal (e.g. it would have crossed). */
  place(o: PlaceRequest): Promise<{ oid?: string; error?: string; fill?: { sz: number; px: number } }>;
  cancel(asset: number, oids: string[]): Promise<void>;
  /** Reduce-only IOC that closes the coin's position. */
  flatten(coin: string): Promise<void>;
  /** Dead-man switch: exchange cancels all orders at `timeMs`; undefined removes it. Throws if the exchange refuses. */
  armDeadman(timeMs?: number): Promise<void>;
}

/** The live port: the leg's own HL API wallet (agent key) trades; reads need no key. */
export async function hlPort(legs: Legs, owner: Hex, leg: number, slippage = 0.03): Promise<TradingPort> {
  const user = await legs.client.getLeg(owner, leg);
  if (!user) throw new Error(`leg ${leg} of ${owner} is not registered`);
  const hl = legs.tradingClient(owner, leg);
  const port: TradingPort = {
    async info(coin) {
      const [meta, mids] = await Promise.all([hl.meta(), hl.allMids()]);
      const asset = meta.universe.findIndex((u) => u.name === coin);
      if (asset < 0) throw new Error(`no market ${coin}`);
      return { asset, szDecimals: meta.universe[asset]!.szDecimals, mid: Number(mids[coin]) };
    },
    async openOids() {
      return new Set((await hl.openOrders({ user })).map((o) => String(o.oid)));
    },
    async filledOids() {
      return new Set((await hl.userFills({ user })).map((f) => String(f.oid)));
    },
    async position(coin) {
      return Number(position(await hl.clearinghouseState({ user }), coin)?.szi ?? 0);
    },
    async equity() {
      return Number((await hl.clearinghouseState({ user })).marginSummary.accountValue);
    },
    async setLeverage(asset, leverage) {
      await hl.updateLeverage({ asset, isCross: true, leverage });
    },
    async place(o) {
      try {
        const res = await hl.limitOrderOpen({ asset: o.asset, isBuy: o.isBuy, price: o.px, size: o.sz, tif: o.tif ?? 'Alo', reduceOnly: o.reduceOnly });
        const st = res.response.data.statuses[0] as Record<string, any> | undefined;
        if (!st || 'error' in st) return { error: st ? String(st.error) : 'no status' };
        const f = st.filled as { totalSz: string; avgPx: string } | undefined;
        return { oid: String((st.resting ?? st.filled).oid), ...(f && { fill: { sz: Number(f.totalSz), px: Number(f.avgPx) } }) };
      } catch (e) {
        // core throws the exchange's verdict (e.g. a post-only order that would have crossed): an order outcome, not a fault
        if (e instanceof RelayRejectionError) return { error: e.reason };
        throw e;
      }
    },
    async cancel(asset, oids) {
      if (!oids.length) return;
      try {
        await hl.batchCancel({ cancels: oids.map((o) => ({ a: asset, o: Number(o) })) });
      } catch (e) {
        if (!(e instanceof RelayRejectionError)) throw e;
        // one order filled or vanished since we listed them: HL rejects the batch; cancel the rest one by one
        for (const o of oids) {
          await hl.cancelOrder({ asset, oid: Number(o) }).catch((err) => {
            if (!(err instanceof RelayRejectionError)) throw err;
          });
        }
      }
    },
    async flatten(coin) {
      const szi = await port.position(coin);
      if (szi === 0) return;
      const { asset, szDecimals, mid } = await port.info(coin);
      const isBuy = szi < 0;
      await hl.limitOrderOpen({
        asset,
        isBuy,
        price: roundPx(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals),
        size: Math.abs(szi).toFixed(szDecimals),
        tif: 'Ioc',
        reduceOnly: true,
      });
    },
    async armDeadman(timeMs) {
      await hl.scheduleCancel(timeMs === undefined ? {} : { time: timeMs });
    },
  };
  return port;
}

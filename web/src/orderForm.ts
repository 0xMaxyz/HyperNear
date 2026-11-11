// The ticket's fields -> one OrderSpec, or the first thing wrong with them in plain words. The agent validates again (agent/src/order.ts)
// and its reasons are shown too; this only keeps obviously empty or malformed input from being signed.
import { floorSize, roundPx, type OrderSpec, type OrderType } from './trading';

export interface OrderForm {
  leg: number;
  coin: string;
  side: 'buy' | 'sell';
  type: OrderType;
  size: string;
  reduceOnly: boolean;
  leverage: string;
  isCross: boolean;
  /** leave the margin mode and leverage as the leg already has them (when it holds the coin) */
  keepLeverage: boolean;
  limitPx: string;
  triggerPx: string;
  tif: 'Gtc' | 'Ioc' | 'Alo';
  tpPx: string;
  slPx: string;
  minutes: string;
  trailBy: 'pct' | 'px';
  trailValue: string;
  activationPx: string;
}

export const emptyForm = (leg = 0, coin = 'BTC'): OrderForm => ({
  leg, coin, side: 'buy', type: 'market', size: '', reduceOnly: false, leverage: '3', isCross: true, keepLeverage: false, limitPx: '', triggerPx: '', tif: 'Gtc', tpPx: '', slPx: '', minutes: '30', trailBy: 'pct', trailValue: '5', activationPx: '',
});

export const TYPE_LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stopMarket: 'Stop market',
  stopLimit: 'Stop limit',
  takeMarket: 'Take profit market',
  takeLimit: 'Take profit limit',
  bracket: 'Take profit and stop loss',
  twap: 'TWAP',
  trailing: 'Trailing stop',
};
/** types that only ever close an existing position */
export const CLOSING_TYPES: OrderType[] = ['bracket', 'trailing'];
const DEC = /^\d+(\.\d+)?$/;

const px = (label: string, v: string, szDecimals: number): string | { error: string } => {
  if (!DEC.test(v) || Number(v) <= 0) return { error: `${label} must be a positive number` };
  return roundPx(Number(v), szDecimals) === String(Number(v)) ? String(Number(v)) : { error: `${label} ${v} is not a price Hyperliquid accepts here, try ${roundPx(Number(v), szDecimals)}` };
};

export function buildSpec(f: OrderForm, szDecimals: number): { spec: OrderSpec } | { error: string } {
  const spec: OrderSpec = { leg: f.leg, coin: f.coin, side: f.side, type: f.type };
  const need = (label: string, v: string) => {
    const r = px(label, v, szDecimals);
    return typeof r === 'string' ? r : (void (err = r.error), '');
  };
  let err = '';
  if (f.type !== 'bracket') {
    if (!DEC.test(f.size) || Number(f.size) <= 0) return { error: 'Enter a size above 0' };
    const s = floorSize(Number(f.size), szDecimals);
    if (Number(s) !== Number(f.size)) return { error: `${f.coin} sizes go to ${szDecimals} decimals: ${s}` };
    spec.size = String(Number(f.size));
  }
  const closing = f.reduceOnly || CLOSING_TYPES.includes(f.type);
  if (f.reduceOnly && !CLOSING_TYPES.includes(f.type)) spec.reduceOnly = true;
  if (!closing) {
    if (!f.keepLeverage) {
      if (!/^\d+$/.test(f.leverage) || Number(f.leverage) < 1) return { error: 'Leverage must be a whole number, 1 or more' };
      spec.leverage = Number(f.leverage);
      spec.isCross = f.isCross;
    }
  }
  switch (f.type) {
    case 'limit':
      spec.limitPx = need('Limit price', f.limitPx);
      spec.tif = f.tif;
      break;
    case 'stopMarket':
    case 'takeMarket':
      spec.triggerPx = need('Trigger price', f.triggerPx);
      break;
    case 'stopLimit':
    case 'takeLimit':
      spec.triggerPx = need('Trigger price', f.triggerPx);
      if (!err) spec.limitPx = need('Limit price', f.limitPx);
      break;
    case 'bracket':
      if (!f.tpPx && !f.slPx) return { error: 'Set a take-profit price, a stop-loss price, or both' };
      if (f.tpPx) spec.tpPx = need('Take-profit price', f.tpPx);
      if (f.slPx && !err) spec.slPx = need('Stop-loss price', f.slPx);
      break;
    case 'twap':
      if (!/^\d+$/.test(f.minutes)) return { error: 'TWAP minutes must be a whole number from 5 to 1440' };
      spec.minutes = Number(f.minutes);
      spec.randomize = true;
      break;
    case 'trailing':
      if (f.trailBy === 'pct') {
        if (!DEC.test(f.trailValue) || Number(f.trailValue) <= 0 || Number(f.trailValue) >= 100) return { error: 'Trail percentage must be above 0 and below 100' };
        spec.trailPct = String(Number(f.trailValue));
      } else spec.trailPx = need('Trail distance', f.trailValue);
      if (f.activationPx && !err) spec.activationPx = need('Activation price', f.activationPx);
      break;
    default:
  }
  return err ? { error: err } : { spec };
}

/** One sentence saying what signing will do, for the line above the button. */
export function describeSpec(s: OrderSpec, mid: number): string {
  const what = `${s.side === 'buy' ? 'Buy' : 'Sell'} ${s.size ?? ''} ${s.coin}`.replace('  ', ' ');
  const lev = s.leverage ? ` at ${s.leverage}x ${s.isCross === false ? 'isolated' : 'cross'}` : '';
  const notional = s.size ? ` (about $${(Number(s.size) * Number(s.limitPx ?? s.triggerPx ?? mid)).toFixed(2)})` : '';
  const on = `on leg ${s.leg}${lev}`;
  switch (s.type) {
    case 'market': return `${what} at market${s.reduceOnly ? ', reduce only' : ''} ${on}${notional}.`;
    case 'limit': return `${what} at ${s.limitPx} (${s.tif})${s.reduceOnly ? ', reduce only' : ''} ${on}${notional}.`;
    case 'stopMarket': return `${what} at market if the price reaches ${s.triggerPx} ${on}${notional}.`;
    case 'takeMarket': return `${what} at market once the price reaches ${s.triggerPx} ${on}${notional}.`;
    case 'stopLimit': case 'takeLimit': return `${what} at ${s.limitPx} once the price reaches ${s.triggerPx} ${on}${notional}.`;
    case 'bracket': return `Close the whole ${s.coin} position on leg ${s.leg}${s.tpPx ? ` at ${s.tpPx} for profit` : ''}${s.tpPx && s.slPx ? ' or' : ''}${s.slPx ? ` at ${s.slPx} to stop the loss` : ''}. Hyperliquid resizes it with the position.`;
    case 'twap': return `${what} gradually over ${s.minutes} minutes ${on}${notional}.`;
    case 'trailing': return `${what} when the price falls ${s.trailPct ? `${s.trailPct}%` : `${s.trailPx}`} from its best${s.activationPx ? ` after it reaches ${s.activationPx}` : ''}, reduce only ${on}${notional}.`;
  }
}

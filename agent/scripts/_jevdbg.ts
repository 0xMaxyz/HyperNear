import { jevClient } from '../src/jev.ts';
import { jevAskStrategy } from '../src/strategy/decideClients.ts';
import { STRATEGY_FACTOR_KEYS } from '../src/strategy/decide.ts';
let bytes = 0;
const facts = { strategy: 'twap', pnl: 'large loss: over half the loss limit', budget: 'used up', fillRate: 'normal', slicesLeft: 'many left', liqDistance: 'near: 3% to 10%', price: 'inside the limit price', vol: 'normal' };
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  try {
    const p = await jevAskStrategy(jevClient(20000, (n) => (bytes = n)))(facts, STRATEGY_FACTOR_KEYS);
    console.log('ok', Date.now() - t, 'ms', bytes, 'bytes', JSON.stringify(p));
  } catch (e) {
    console.log('fail', Date.now() - t, 'ms', bytes, 'bytes', (e as Error).message);
  }
}

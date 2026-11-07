import { noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { compactFacts, FACTOR_KEYS, FACTOR_QUESTIONS, JEV_MODEL, type FactorKey, type FactorProbs, type Facts } from './decide.ts';

/**
 * api.typesafe.ai (behind Cloudflare) hangs every second request that reuses a keep-alive connection
 * (measured from ci32: alternating ~0.7 s OK / timeout; the SDK's default retries hide this as 10 s to 2 min calls).

 * `Connection: close` on every request fixes it: 8/8 back-to-back calls at ~0.7 s.
 * Separate problem, also from ci32: a request whose JSON body is larger than about 1.4 KB hangs until timeout
 * (option descriptions of 45 chars OK, 50 chars hang). Keep option descriptions short.
 */
export function jevClient(timeoutMs = 10_000, onBodyBytes?: (n: number) => void): TypeSafeClient {
  return new TypeSafeClient({
    timeout: timeoutMs,
    retry: { maxRetries: 0 },
    fetch: (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('connection', 'close');
      if (onBodyBytes && typeof init.body === 'string') onBodyBytes(init.body.length);
      return fetch(url, { ...init, headers });
    },
  });
}

/** proposeAction's `ask`: all factor questions in one Jev request, compact facts (request size, see above). */
export function jevAsk(jev: TypeSafeClient = jevClient()) {
  return async (facts: Facts, order: FactorKey[]): Promise<FactorProbs> => {
    const res = await jev.systemOne({
      state: compactFacts(facts),
      questions: Object.fromEntries(order.map((k) => [k, noul(FACTOR_QUESTIONS[k])])),
      model: JEV_MODEL,
    });
    const a = res.answers as unknown as Record<FactorKey, { noul: number }>;
    return Object.fromEntries(FACTOR_KEYS.map((k) => [k, a[k].noul])) as FactorProbs;
  };
}

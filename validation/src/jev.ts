import { TypeSafeClient } from '@typesafe-ai/sdk';

/**
 * api.typesafe.ai (behind Cloudflare) hangs every second request that reuses a keep-alive connection
 * (measured from ci32: alternating ~0.7 s OK / timeout; the SDK's default retries hide this as 10 s to 2 min calls).
 * `Connection: close` on every request fixes it: 8/8 back-to-back calls at ~0.7 s.
 */
export function jevClient(timeoutMs = 10_000): TypeSafeClient {
  return new TypeSafeClient({
    timeout: timeoutMs,
    retry: { maxRetries: 0 },
    fetch: (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('connection', 'close');
      return fetch(url, { ...init, headers });
    },
  });
}

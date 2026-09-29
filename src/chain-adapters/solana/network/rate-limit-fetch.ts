/**
 * `fetch` for a web3.js `Connection` with `disableRetryOnRateLimit: true`: retries a 429 with the
 * same schedule web3.js uses (500 ms doubling, 4 retries, ≈ 7.5 s), but without its
 * `console.error` on every attempt, which the public devnet RPC turns into constant noise (and
 * Next's dev overlay into errors). The last 429 is returned, so callers still see the failure.
 */

const RETRIES = 4;
const FIRST_DELAY_MS = 500;

type Fetch = typeof fetch;

export function rateLimitRetryingFetch(
  inner: Fetch = (...args) => fetch(...args),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Fetch {
  return async (input, init) => {
    let delay = FIRST_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      const response = await inner(input, init);
      if (response.status !== 429 || attempt === RETRIES) return response;
      await sleep(delay);
      delay *= 2;
    }
  };
}

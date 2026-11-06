/**
 * The catalog read's redirects — every hop re-checks the origin.
 *
 * `fetch` follows redirects on its own, and it carries the request's
 * headers along: the session token would ride to a host nobody
 * checked, over cleartext if the hop chose it. So the read follows
 * redirects BY HAND — one hop at a time, and each hop is checked
 * against the same rule the router's own URL is checked against
 * (https, or cleartext to this machine).
 *
 * The URL is built HERE, from the endpoint, and never travels as a
 * bare string into the client: the endpoint's URL is the router's
 * own, and the hops are the guard's answers.
 *
 * The hop's URL is kept whole — its query and its fragment are the
 * router's answer, not a base the catalog path is appended to.
 */
import type { RouterEndpoint } from './adapter.ts';
import { routerUrl, tokenSafeOrigin } from './router-url.ts';

/** The statuses that carry a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The hops a read may follow before the answer is a loop. */
const MAX_HOPS = 5;

/** The hop's URL — the guard's own answer, and the URL comes back WHOLE:
 *  a redirect's query and fragment are the router's answer, not a base
 *  the catalog path is appended to. A hop that leaves the guard is an
 *  error, and the error names the host the token would have crossed
 *  to. */
function hopUrl(raw: string): string {
  const target = URL.parse(raw);
  if (!target || !tokenSafeOrigin(target)) {
    throw new Error(
      `the catalog read cannot carry the session token to ${raw} — https or a loopback router ` +
        `(http://127.0.0.1:<port>) only; a plain-http host would carry it cleartext`
    );
  }
  return raw;
}

/** The redirect's target — resolved against the hop it came from. */
function redirectTarget(from: string, location: string): string {
  return new URL(location, from).toString();
}

/** The catalog's answer — the router's, or the one a redirect points
 *  at. Every hop is checked before the token rides it, and the whole
 *  read shares ONE timeout. */
export async function fetchTokenSafe(
  endpoint: RouterEndpoint,
  limit: number,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let current = `${routerUrl(endpoint.url)}/v1/models?limit=${limit}`;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const url = `${hopUrl(current)}`;
    const res = await fetch(url, { headers, signal, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    await res.text();
    current = `${redirectTarget(current, location)}`;
  }
  throw new Error(`the router redirected more than ${MAX_HOPS} times`);
}

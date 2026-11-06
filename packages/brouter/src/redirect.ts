/**
 * The catalog read's redirects — every hop re-checks the origin.
 *
 * `fetch` follows redirects on its own, and it carries the request's
 * headers along: the session token would ride to a host nobody
 * checked, over cleartext if the hop chose it. So the read follows
 * redirects by HAND — one hop at a time, and each hop is checked
 * against the same rule the router's own URL is checked against
 * (https, or cleartext to this machine).
 *
 * The hop's URL is kept whole — its query and its fragment are the
 * router's answer, not a base the catalog path is appended to.
 */
import { tokenSafeOrigin } from './router-url.ts';

/** The statuses that carry a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The hops a read may follow before the answer is a loop. */
const MAX_HOPS = 5;

/** The redirect's target — resolved against the hop it came from, and
 *  checked against the guard: a hop may not carry the session token to
 *  a host the router's own URL could not name. */
function redirectTarget(from: string, location: string): string {
  const target = new URL(location, from);
  if (!tokenSafeOrigin(target)) {
    throw new Error(
      `the router redirected to ${target.origin} — a redirect may not carry the session token ` +
        `to a host the guard does not know (https or a loopback router only)`
    );
  }
  return target.toString();
}

/** The catalog's answer — the router's, or the one a redirect points
 *  at. Every hop is checked before the token rides it, and the whole
 *  read shares ONE timeout. */
export async function fetchTokenSafe(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const res = await fetch(current, { headers, signal, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (location === null) return res;
    await res.text();
    current = redirectTarget(current, location);
  }
  throw new Error(`the router redirected more than ${MAX_HOPS} times`);
}

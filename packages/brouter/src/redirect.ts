/**
 * The catalog read's redirect — the session token rides NO hop.
 *
 * `fetch` follows redirects on its own, and it carries the request's
 * headers along: the session token would ride to a host nobody
 * checked, over cleartext if the hop chose it. The guard checks the
 * FIRST url only, so a redirect would carry the token past it.
 *
 * The read asks ONE url — the router's own /v1/models — and a
 * redirect names ANOTHER url. So the read refuses the redirect
 * instead of following it: `redirect: 'manual'`, and a redirect is an
 * error that names its target. The token crosses to the router and
 * nowhere else, and the rule the debt plane states holds for every
 * request the read makes — there is only one.
 */
import type { RouterEndpoint } from './adapter.ts';
import { routerUrl } from './router-url.ts';

/** The statuses that carry a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The catalog's answer — the router's own. A redirect is refused, not
 *  followed: the session token would ride to a host the guard never
 *  checked, and a read that cannot check a hop does not make it. */
export async function fetchTokenSafe(
  endpoint: RouterEndpoint,
  limit: number,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const url = `${routerUrl(endpoint.url)}/v1/models?limit=${limit}`;
  const res = await fetch(url, { headers, signal, redirect: 'manual' });
  if (REDIRECT_STATUSES.has(res.status)) {
    const location = res.headers.get('location') ?? '';
    throw new Error(
      `the router answered ${res.status} with a redirect to ${location} — the catalog read does not ` +
        `follow redirects: the session token would ride to a host the guard never checked`
    );
  }
  return res;
}

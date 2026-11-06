/**
 * The endpoint's URL — the credential's crossing point.
 *
 * The router's URL comes from the router's own state file OR from the
 * operator's `--url` flag, and the SESSION TOKEN rides it: `x-api-key`
 * and `Authorization: Bearer` in the catalog read, the proxy's own key
 * header in the model call. Every endpoint bro builds goes through here,
 * so the token's crossing point is checked in ONE place.
 *
 * The rule is the debt plane's rule (packages/debt/src/collectors.ts):
 * a token crosses over https, or cleartext to this machine. A router is
 * a local process; a remote one speaks https.
 */

/** The hosts a session token may cross to in cleartext: this machine only.
 *  The debt plane's rule, verbatim (packages/debt/src/collectors.ts) — a
 *  Set, not a pattern: a nested quantifier is a denial-of-service waiting
 *  for a caller, and the host list is three names long. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL's origin may carry the session token: https anywhere,
 *  cleartext only to this machine. */
function tokenSafeOrigin(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** The URL without its trailing slashes — the endpoint's own form.
 *  A loop, not a pattern: the scanner that reads these files flags a
 *  regex as unsafe, and a trailing slash is not worth a pattern. */
function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') {
    end -= 1;
  }
  return text.slice(0, end);
}

/** The router's URL, checked against the credential it carries.
 *
 *  The base carries a PATH and nothing else: the catalog read appends
 *  `/v1/models` to it, so a query or a fragment left in place would
 *  land in the middle of that path — the read would ask for
 *  `/?trace=1/v1/models`. */
export function routerUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null) {
    throw new Error(`the router's url "${raw}" is not a valid URL`);
  }
  if (!tokenSafeOrigin(url)) {
    throw new Error(
      `the router's url ${raw} cannot carry the session token — https or a loopback router ` +
        `(http://127.0.0.1:<port>) only; a plain-http host would carry it cleartext`
    );
  }
  url.search = '';
  url.hash = '';
  return withoutTrailingSlashes(url.toString());
}

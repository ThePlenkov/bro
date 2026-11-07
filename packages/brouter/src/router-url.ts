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

/** The URL as an error may show it: the origin and the path, never the
 *  credentials and never the query — a refused url can carry a
 *  password, and a log is a place a password must not land. */
function urlForError(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** The router's URL, checked against the credential it carries.
 *
 *  The base carries a PATH and nothing else: the catalog read appends
 *  `/v1/models` to it, so a query or a fragment left in place would
 *  land in the middle of that path — the read would ask for
 *  `/?trace=1/v1/models`. */
export function routerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`the router's url is not a valid URL`);
  }
  if (url.username || url.password) {
    // a url with credentials in it: the token would ride to a host that
    // asks for a password, and the password would land in every log
    // that prints the refusal
    throw new Error(`the router's url carries credentials — a router url never carries a password`);
  }
  if (!tokenSafeOrigin(url)) {
    throw new Error(
      `the router's url ${urlForError(url)} cannot carry the session token — https or a loopback router ` +
        `(http://127.0.0.1:<port>) only; a plain-http host would carry it cleartext`
    );
  }
  url.search = '';
  url.hash = '';
  return withoutTrailingSlashes(url.toString());
}

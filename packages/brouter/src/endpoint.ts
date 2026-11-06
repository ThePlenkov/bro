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

/** The origins a session token may cross to: https anywhere, cleartext
 *  only to this machine. */
const TOKEN_SAFE_ORIGIN = /^https:\/\/|^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/** The router's URL, checked against the credential it carries.
 *
 *  @codacy-sanitizer
 */
export function routerUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null) {
    throw new Error(`the router's url "${raw}" is not a valid URL`);
  }
  if (!TOKEN_SAFE_ORIGIN.test(url.origin)) {
    throw new Error(
      `the router's url ${raw} cannot carry the session token — https or a loopback router ` +
        `(http://127.0.0.1:<port>) only; a plain-http host would carry it cleartext`
    );
  }
  return url.toString().replace(/\/+$/, '');
}

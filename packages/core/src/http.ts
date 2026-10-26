/** Bounded loopback probes — `node:http`, not fetch (bro-uwoss). An
 *  aborted undici fetch to a dead endpoint rejects its promise on time
 *  yet keeps the connect machinery ref'd until undici's internal
 *  ~10s connectTimeout, pinning the CALLER's event loop (and exit).
 *  `req.destroy()` at the deadline frees the pending connect *at* the
 *  deadline — the caller fails at timeoutMs AND can exit at timeoutMs. */
import { request } from 'node:http';

const MAX_JSON_BODY = 4 * 1024 * 1024;

/** GET `url` and parse a JSON body; `undefined` on any failure —
 *  connect refusal, non-2xx, bad JSON, oversize body, or the deadline.
 *  The deadline covers the whole call: connect + response body. */
export function getJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  return new Promise(resolve => {
    const done = (v: unknown | undefined): void => {
      clearTimeout(timer);
      resolve(v);
    };
    const req = request(url, { method: 'GET' }, res => {
      let body = '';
      // the cap is bytes — .length counts UTF-16 code units and would
      // undercount a multibyte body past the limit
      let bodyBytes = 0;
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        body += d;
        bodyBytes += Buffer.byteLength(d);
        if (bodyBytes > MAX_JSON_BODY) {
          req.destroy();
        }
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          done(undefined);
          return;
        }
        try {
          done(JSON.parse(body));
        } catch {
          done(undefined);
        }
      });
      res.on('error', () => done(undefined));
    });
    // ref'd on purpose: callers await, so the loop holds until the
    // deadline anyway — the win is destroy() freeing it AT the deadline
    const timer = setTimeout(() => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', () => done(undefined));
    req.end();
  });
}

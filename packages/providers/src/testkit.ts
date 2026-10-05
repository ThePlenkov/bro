/** Test seam — a scripted FetchFn for the wire clients, shared by the
 *  providers and judge suites. Each queued `{status, body}` is served
 *  in order (the last repeats); `calls` records url + init so tests
 *  assert on the request that went out. */
import type { FetchFn } from './http.ts'

export interface Call {
  url: string
  init: { headers?: Record<string, string>; body?: string }
}

export function fakeFetch(
  ...queue: Array<{ status: number; body: unknown }>
): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call['init'] })
    const next = queue[Math.min(calls.length - 1, queue.length - 1)]!
    return {
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as Response
  }) as FetchFn
  return { fetch, calls }
}

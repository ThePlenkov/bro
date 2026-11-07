/** Shared serve-test plumbing — one fake deps/listen/auth set for every
 *  /v1/* suite (conductor, provider proxy, …). */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServeHandler, type ServeDeps } from './serve.ts'

const fakeConn = {
  name: 'native',
  capabilities: () => ({ supervisor: 'none' as const }),
}

export function serveDeps(over: Partial<ServeDeps> = {}): ServeDeps {
  return {
    snapshot: async () => ({}),
    agents: async () => ({
      backends: [{ conn: fakeConn as never, agents: [] }],
      occupancy: { occupied: 0, maxConcurrent: 3 },
      sessions: [],
      discovered: [],
      degraded: [],
    }),
    queue: async () => ({}),
    ticks: async () => ({}),
    mailbox: async () => ({}),
    find: async () => ({ degraded: [] }),
    spawn: async () => {
      throw new Error('unused')
    },
    stop: async () => {
      throw new Error('unused')
    },
    connectors: () => ['native'],
    ...over,
  }
}

export const testToken = 'test-session-token'
export const authHeaders = { authorization: `Bearer ${testToken}` }

export async function listen(
  d: ServeDeps,
  token = testToken
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createServer(createServeHandler(d, { dir: '/repo', startedAt: 't0' }, token))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

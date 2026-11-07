/** `bro mcp` e2e — the built CLI as a stdio MCP server: initialize →
 *  tools/list → tools/call over newline JSON-RPC, capability gating,
 *  and `mcp.planes` allowlist/disable semantics end to end. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  e2eEnv,
  FAKE_BEAD,
  initRepo,
  inside,
  installFakeBd,
  runCli,
} from './testrepo.ts'

interface RpcReply {
  id: number
  result?: { tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean }
  error?: { message: string }
}

/** One stdio session: initialize, initialized, then one request per
 *  line — replies keyed by id. */
function mcpSession(cwd: string, env: Record<string, string>, calls: string[]): RpcReply[] {
  const frames = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ...calls,
  ].join('\n')
  const res = runCli(['mcp'], { cwd, input: `${frames}\n`, env })
  assert.equal(res.code, 0, `bro mcp exited ${res.code} — stderr: ${res.stderr}`)
  return res.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RpcReply)
}

const toolCall = (id: number, name: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  })

describe('bro mcp', () => {
  test('stdio handshake — initialize, tools/list generated from descriptors, tools/call dispatches', () => {
    const { root, main } = initRepo('bro-mcp-e2e-')
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-1', title: 'the work item' }])
    const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
    inside(main, root, () => {
      const replies = mcpSession(
        main,
        env,
        [
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
          toolCall(3, 'bro_debt_summary'),
          toolCall(4, 'bro_work_list'),
          toolCall(5, 'bro_bogus_plane'),
        ]
      )
      const init = replies.find((r) => r.id === 1)
      assert.ok(init?.result !== undefined, 'initialize must answer')
      const list = replies.find((r) => r.id === 2)
      const names = (list?.result?.tools ?? []).map((t) => t.name)
      // every tool is bro_<plane>_<op> — generation, not convention
      for (const n of names) {
        assert.match(n, /^bro_[a-z]+_[a-z]+$/, `tool name ${n}`)
      }
      // the bead's named reads land as tools
      assert.ok(names.includes('bro_debt_next'), `tools: ${names.join(',')}`)
      assert.ok(names.includes('bro_debt_summary'))
      assert.ok(names.includes('bro_learn_probe'), `tools: ${names.join(',')}`)
      assert.ok(names.includes('bro_agents_fleet'), `tools: ${names.join(',')}`)
      // fake bd is up → work/queue/learn reads are served
      assert.ok(names.includes('bro_work_list'), `tools: ${names.join(',')}`)
      assert.ok(names.includes('bro_work_ready'))
      assert.ok(names.includes('bro_queue_next'))
      assert.ok(names.includes('bro_learn_list'))

      // tools/call — a real read through the facade
      const summary = replies.find((r) => r.id === 3)
      assert.ok(summary?.result !== undefined, 'summary must answer')
      const text = summary?.result?.content?.[0]?.text ?? ''
      const parsed = JSON.parse(text) as { open_count?: number }
      assert.equal(typeof parsed.open_count, 'number')

      // work.list returns the seeded bead as a WorkItem
      const work = replies.find((r) => r.id === 4)
      const items = JSON.parse(work?.result?.content?.[0]?.text ?? '[]') as { id: string }[]
      assert.ok(items.some((i) => i.id === 'fx-1'), `work list: ${JSON.stringify(items)}`)

      // unknown tool → { error } result, never a crash
      const bad = replies.find((r) => r.id === 5)
      assert.equal(bad?.result?.isError, true)
      const badBody = JSON.parse(bad?.result?.content?.[0]?.text ?? '{}') as { error?: string }
      assert.match(badBody.error ?? '', /unknown tool/)
    })
  })

  test('mcp.planes [] disables every plane; an allowlist narrows exposure', () => {
    const { root, main } = initRepo('bro-mcp-e2e-off-')
    const { binDir, db } = installFakeBd(root, [])
    const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
    inside(main, root, () => {
      writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ mcp: { planes: [] } }))
      const off = mcpSession(
        main,
        env,
        [JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })]
      )
      const offTools = off.find((r) => r.id === 2)?.result?.tools ?? []
      assert.deepEqual(offTools, [])

      writeFileSync(
        join(main, 'bro.config.json'),
        JSON.stringify({ mcp: { planes: ['debt'] } })
      )
      const narrow = mcpSession(
        main,
        env,
        [JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })]
      )
      const names = (narrow.find((r) => r.id === 2)?.result?.tools ?? []).map((t) => t.name)
      assert.ok(names.length > 0)
      assert.ok(names.every((n) => n.startsWith('bro_debt_')), `tools: ${names.join(',')}`)
    })
  })

  test('bro mcp --tools prints the generated tools/list and exits', () => {
    const { root, main } = initRepo('bro-mcp-e2e-list-')
    const { binDir, db } = installFakeBd(root, [])
    inside(main, root, () => {
      const res = runCli(['mcp', '--tools'], {
        cwd: main,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db },
      })
      assert.equal(res.code, 0, res.stderr)
      const tools = JSON.parse(res.stdout) as { name: string; inputSchema: unknown }[]
      assert.ok(Array.isArray(tools))
      const names = tools.map((t) => t.name)
      assert.ok(names.includes('bro_debt_list'), `tools: ${names.join(',')}`)
      for (const t of tools) {
        assert.ok(t.inputSchema !== undefined, `${t.name} carries an inputSchema`)
      }
    })
  })
})

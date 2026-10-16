import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  busProbe,
  busSocketPath,
  gitCommonDir,
  scrubEnv,
  startBusBrokerAt,
  testGit,
  type BusBroker,
} from '@broject/core'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { agentTurnPlane } from './acp-events.ts'

// in-process git + the BRO_* badge read must never inherit the OUTER
// session's pins — same scrub rule every fixture suite carries
after(scrubEnv())

/** mkdtemp + git init — the bus socket and the archive both anchor on
 *  the repo's common dir. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-acpev-'))
  testGit(['init', '-q', dir])
  return dir
}

const toolOpen = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-1',
  title: 'Read src/foo.ts',
  kind: 'read',
  status: 'in_progress',
} as SessionUpdate

const toolDone = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tc-1',
  status: 'completed',
  content: [{ type: 'terminal', terminalId: 'term-9' }],
} as unknown as SessionUpdate

const chunk = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'hello' },
} as SessionUpdate

const subagent = {
  sessionUpdate: 'subagent_update',
  sessionId: 'child-1',
  title: 'researcher',
} as SessionUpdate

const usage = (used: number) =>
  ({ sessionUpdate: 'usage_update', used, size: 200_000 }) as SessionUpdate

function readArchive(dir: string, agentId: string): Array<Record<string, unknown>> {
  const common = gitCommonDir(dir)!
  const file = join(common, 'bro', 'agents', `${agentId}.events.jsonl`)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function probeAgent(dir: string) {
  const res = await busProbe(busSocketPath(dir)!, {
    filter: { topics: ['agent'] },
    windowMs: 50,
  })
  return res.events
}

describe('agentTurnPlane', () => {
  test('a badged turn publishes normalized agent events in order and archives every update', async () => {
    const dir = repo()
    const broker: BusBroker = await startBusBrokerAt(busSocketPath(dir)!)
    try {
      process.env.BRO_AGENT_ID = 'native-t1'
      process.env.BRO_BEAD_ID = 'bro-x1'
      const plane = agentTurnPlane({ cwd: dir, by: "acp provider 'kilo'", sessionId: 'sess-1' })
      plane.start()
      plane.update(chunk) // text deltas archive only — never the bus
      plane.update(toolOpen)
      plane.update(toolDone)
      plane.update(subagent)
      plane.update(usage(100))
      plane.update(usage(200)) // inside the throttle window — coalesced
      plane.stop('end_turn', { replyLen: 5 })
      await plane.drain()

      const events = await probeAgent(dir)
      assert.deepEqual(
        events.map((e) => `${e.kind}:${(e.payload as { phase?: string }).phase ?? ''}`),
        ['turn:start', 'tool_call:open', 'tool_call:finish', 'subagent:open', 'usage:', 'usage:', 'turn:stop']
      )
      for (const e of events) {
        assert.equal(e.key, 'native-t1')
        assert.equal(e.cause, 'bro-x1')
        assert.equal(e.source, "acp provider 'kilo'")
        assert.equal(e.topic, 'agent')
      }
      const finish = events.find((e) => e.kind === 'tool_call' && (e.payload as { phase?: string }).phase === 'finish')
      assert.deepEqual(
        { ...(finish!.payload as object) },
        {
          phase: 'finish',
          toolCallId: 'tc-1',
          status: 'completed',
          terminalId: 'term-9',
        }
      )
      // the pending usage counter flushed at stop — the newest wins
      const usages = events.filter((e) => e.kind === 'usage')
      assert.deepEqual(usages.map((e) => (e.payload as { used: number }).used), [100, 200])

      const rows = readArchive(dir, 'native-t1')
      assert.equal(rows[0]!.kind, 'turn')
      assert.equal(rows[0]!.phase, 'start')
      const updates = rows.filter((r) => r.kind === 'update')
      assert.equal(updates.length, 6) // chunk + tool open + tool done + sub + 2 usage
      assert.equal((updates[0]!.update as SessionUpdate).sessionUpdate, 'agent_message_chunk')
      const last = rows.at(-1)!
      assert.equal(last.kind, 'turn')
      assert.equal(last.phase, 'stop')
      assert.equal(last.stopReason, 'end_turn')
    } finally {
      await broker.close()
    }
  })

  test('unbadged turns key acp:<sessionId> and never write an archive', async () => {
    const dir = repo()
    const broker = await startBusBrokerAt(busSocketPath(dir)!)
    try {
      delete process.env.BRO_AGENT_ID
      delete process.env.BRO_BEAD_ID
      const plane = agentTurnPlane({ cwd: dir, by: 'conductor:kilo', sessionId: 'sess-9' })
      plane.start()
      plane.update(usage(50))
      plane.stop('end_turn')
      await plane.drain()
      const events = await probeAgent(dir)
      assert.equal(events.length, 3)
      for (const e of events) {
        assert.equal(e.key, 'acp:sess-9')
        assert.equal(e.source, 'conductor:kilo')
        assert.equal(e.cause, undefined)
      }
      const common = gitCommonDir(dir)!
      assert.equal(existsSync(join(common, 'bro', 'agents')), false)
    } finally {
      await broker.close()
    }
  })

  test('mid-flight tool_call repeats stay off the bus; first-seen terminal publishes finish', async () => {
    const dir = repo()
    const broker = await startBusBrokerAt(busSocketPath(dir)!)
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' })
      plane.start()
      plane.update(toolOpen)
      // a repeated non-terminal tool_call for the same id is churn
      plane.update({ ...toolOpen, title: 'Read src/foo.ts (still)' } as SessionUpdate)
      // a terminal tool_call_update for an id never opened still lands finish
      plane.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-other',
        status: 'failed',
      } as SessionUpdate)
      plane.stop('end_turn')
      await plane.drain()
      const events = await probeAgent(dir)
      assert.deepEqual(
        events.map((e) => [e.kind, (e.payload as Record<string, unknown>).phase, (e.payload as Record<string, unknown>).toolCallId].join('/')),
        ['turn/start/', 'tool_call/open/tc-1', 'tool_call/finish/tc-other', 'turn/stop/']
      )
    } finally {
      await broker.close()
    }
  })

  test('usage events throttle — one per window plus the pending flush at stop', async () => {
    const dir = repo()
    const broker = await startBusBrokerAt(busSocketPath(dir)!)
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' })
      plane.start()
      for (const u of [1, 2, 3, 4, 5]) plane.update(usage(u))
      plane.stop('end_turn')
      await plane.drain()
      const usages = (await probeAgent(dir)).filter((e) => e.kind === 'usage')
      assert.deepEqual(usages.map((e) => (e.payload as { used: number }).used), [1, 5])
    } finally {
      await broker.close()
    }
  })

  test('outside a repo every call is a no-op — telemetry never fails a turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-acpev-norepo-'))
    const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' })
    plane.start()
    plane.update(chunk)
    plane.update(toolOpen)
    plane.stop('end_turn')
    await plane.drain()
  })

  test('an unsafe BRO_AGENT_ID badge degrades to the session key, never a path escape', async () => {
    const dir = repo()
    const broker = await startBusBrokerAt(busSocketPath(dir)!)
    try {
      process.env.BRO_AGENT_ID = '../escape'
      delete process.env.BRO_BEAD_ID
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 'sess-x' })
      plane.start()
      plane.stop('end_turn')
      await plane.drain()
      const events = await probeAgent(dir)
      assert.equal(events[0]!.key, 'acp:sess-x')
      const common = gitCommonDir(dir)!
      assert.equal(existsSync(join(common, 'bro', 'agents')), false)
    } finally {
      await broker.close()
    }
  })
})

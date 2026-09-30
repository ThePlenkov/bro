import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bdActor,
  connectors,
  facade,
  facadeAuth,
  isOwnClaim,
  parallelWorkLines,
  promptContextLines,
  registerConnector,
  sessionStartLines,
  stopGateContributions,
} from './connectors.ts'
import type { Connector } from './connectors.ts'
import type { TaskStore } from './tasks.ts'

const withRepo = (remote: string | null, fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-conn-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    if (remote !== null) {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
    }
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fakeTasks = (tag: string): ((ctx: { dir: string }) => TaskStore) =>
  () => ({ tag }) as unknown as TaskStore

/** Scripted bd — `list` cats $FAKE_BD_LIST_FILE (written by withClaimRepo). */
const FAKE_BD = `#!/bin/sh
case "$1" in
  list) cat "$FAKE_BD_LIST_FILE" ;;
  *) : ;;
esac
`

/** Tmp git repo + scripted bd + a `.task` claim marker — the beads
 *  connector's claim-scoped probes (parallelWork, stopGate) run against
 *  it. BEADS_ACTOR pins the actor so ownership checks are hermetic. */
function withClaimRepo(
  opts: { claims?: string[]; list?: string },
  fn: (dir: string) => void | Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-conn-claim-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'bd'), FAKE_BD)
  chmodSync(join(bin, 'bd'), 0o755)
  writeFileSync(join(dir, 'list.json'), opts.list ?? '[]')
  // snapshot → set → restore keeps probe env hermetic (PATH finds the
  // scripted bd; BEADS_ACTOR pins the actor so git config doesn't leak in)
  const saved: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    FAKE_BD_LIST_FILE: process.env.FAKE_BD_LIST_FILE,
    BEADS_ACTOR: process.env.BEADS_ACTOR,
  }
  const run = async (): Promise<void> => {
    execFileSync('git', ['init', '-q', dir])
    if (opts.claims !== undefined) {
      const hooks = join(dir, '.git', 'bro', 'hooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(join(hooks, 's1.task'), ['2026-01-01', ...opts.claims].join('\n'))
    }
    process.env.PATH = `${bin}:${saved.PATH}`
    process.env.FAKE_BD_LIST_FILE = join(dir, 'list.json')
    process.env.BEADS_ACTOR = 'test-agent'
    await fn(dir)
  }
  return run().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })
}

const CLAIMED_LIST =
  '[' +
  '{"id":"b1","status":"in_progress","title":"held elsewhere","assignee":"other-agent"},' +
  '{"id":"b2","status":"in_progress","title":"mine","assignee":"test-agent"}' +
  ']'

describe('connectors', () => {
  test('beads is registered built-in and provides tasks', () => {
    assert.ok(connectors().some((c) => c.name === 'beads'))
    const store = facade('tasks', { dir: process.cwd() }, { connector: 'beads' })
    assert.equal(typeof store.list, 'function')
  })

  test('duplicate connector names are skipped', () => {
    const before = connectors().length
    registerConnector({ name: 'beads' })
    assert.equal(connectors().length, before)
  })

  test('registerConnector adds providers; prefer picks by name', () => {
    registerConnector({ name: 'acme-tasks', tasks: fakeTasks('acme') })
    const store = facade(
      'tasks',
      { dir: process.cwd() },
      { prefer: { tasks: 'acme-tasks' } }
    ) as unknown as { tag: string }
    assert.equal(store.tag, 'acme')
  })

  test('named connector lacking the facade throws', () => {
    registerConnector({ name: 'acme-bare' })
    assert.throws(
      () => facade('tasks', { dir: process.cwd() }, { connector: 'acme-bare' }),
      /connector "acme-bare" does not provide "tasks"/
    )
  })

  test('remote match beats registry order', () => {
    registerConnector({
      name: 'acme-remote',
      matchRemote: (url) => url.includes('acme.example'),
      tasks: fakeTasks('remote'),
    })
    withRepo('git@acme.example:o/r.git', (dir) => {
      const store = facade('tasks', { dir }) as unknown as { tag: string }
      assert.equal(store.tag, 'remote')
    })
    // an unrelated remote does not trigger the match — registry order wins
    withRepo('git@github.com:o/r.git', (dir) => {
      const store = facade('tasks', { dir }) as unknown as { tag: string }
      assert.notEqual(store.tag, 'remote')
    })
  })

  test('an origin change mid-process re-resolves the pick', () => {
    registerConnector({
      name: 'acme-remote2',
      matchRemote: (url) => url.includes('acme2.example'),
      tasks: fakeTasks('remote2'),
    })
    withRepo('git@github.com:o/r.git', (dir) => {
      const first = facade('tasks', { dir }) as unknown as { tag?: string }
      assert.notEqual(first.tag, 'remote2')
      execFileSync('git', [
        '-C',
        dir,
        'remote',
        'set-url',
        'origin',
        'git@acme2.example:o/r.git',
      ])
      const second = facade('tasks', { dir }) as unknown as { tag: string }
      assert.equal(second.tag, 'remote2')
    })
  })

  test('no remote → registry order still resolves', () => {
    withRepo(null, (dir) => {
      const store = facade('tasks', { dir })
      assert.equal(typeof store.list, 'function')
    })
  })

  test('ambiguous providers warn once across auth + facade resolution', () => {
    // beads + acme-tasks both serve 'tasks'; no remote match → the pick
    // is memoized, so ensureAuth's probe and the command's facade() call
    // print the ambiguity notice a single time
    const errs: string[] = []
    const orig = console.error
    console.error = (m: unknown) => errs.push(String(m))
    try {
      withRepo(null, (dir) => {
        facadeAuth('tasks', { dir })
        facade('tasks', { dir })
      })
    } finally {
      console.error = orig
    }
    assert.equal(errs.filter((l) => l.includes('all provide "tasks"')).length, 1)
  })

  test('hook collectors are fail-open and return arrays', async () => {
    registerConnector({
      name: 'acme-wedged',
      hooks: () => {
        throw new Error('wedged')
      },
    })
    registerConnector({
      name: 'acme-ctx',
      hooks: () => ({
        sessionStart: () => ['acme: 2 assigned'],
        parallelWork: () => ['acme: plane-mq claimed'],
      }),
    })
    const dir = process.cwd()
    assert.ok((await sessionStartLines({ dir })).includes('acme: 2 assigned'))
    assert.ok((await parallelWorkLines({ dir })).includes('acme: plane-mq claimed'))
  })

  test('facadeAuth returns the serving connector\'s remediation line', () => {
    registerConnector({
      name: 'acme-auth',
      tasks: fakeTasks('acme'),
      auth: () => 'acme: run `acme login`',
    })
    const dir = process.cwd()
    assert.equal(
      facadeAuth('tasks', { dir }, { connector: 'acme-auth' }),
      'acme: run `acme login`'
    )
    // beads has no auth probe — nothing to demand
    assert.equal(facadeAuth('tasks', { dir }, { connector: 'beads' }), null)
    // no provider surfaces as the message, not a throw
    assert.equal(typeof facadeAuth('reviews', { dir }, { connector: 'acme-bare' }), 'string')
  })

  test('facadeAuth names the plugin when auth breaks the sync contract', () => {
    registerConnector({
      name: 'acme-async-auth',
      tasks: fakeTasks('acme'),
      // plugin bug on purpose — a Promise is truthy and would print as
      // "[object Promise]" if facadeAuth trusted the declared type
      auth: (async () => null) as unknown as Connector['auth'],
    })
    registerConnector({
      name: 'acme-weird-auth',
      tasks: fakeTasks('acme'),
      auth: (() => 42) as unknown as Connector['auth'],
    })
    const dir = process.cwd()
    assert.match(
      facadeAuth('tasks', { dir }, { connector: 'acme-async-auth' }) ?? '',
      /connector "acme-async-auth": auth probe must be sync — got a Promise/
    )
    assert.match(
      facadeAuth('tasks', { dir }, { connector: 'acme-weird-auth' }) ?? '',
      /connector "acme-weird-auth": auth probe must be sync — got number/
    )
  })

  test('probes may be async; a rejected probe starves only itself', async () => {
    registerConnector({
      name: 'acme-async',
      hooks: () => ({
        sessionStart: async () => ['acme: async line'],
        promptSubmit: async (_ctx, prompt) =>
          prompt.includes('JIRA-1') ? ['acme: JIRA-1 in progress'] : [],
        stopGate: async () => [
          { aspect: 'jira', block: 'acme: JIRA-1 open', passive: 'acme: jira busy' },
        ],
      }),
    })
    registerConnector({
      name: 'acme-rejecting',
      hooks: () => ({
        sessionStart: () => Promise.reject(new Error('offline')),
        promptSubmit: () => Promise.reject(new Error('offline')),
        stopGate: () => Promise.reject(new Error('offline')),
      }),
    })
    const dir = process.cwd()
    assert.ok((await sessionStartLines({ dir })).includes('acme: async line'))
    assert.ok(
      (await promptContextLines({ dir }, 'look at JIRA-1')).includes('acme: JIRA-1 in progress')
    )
    assert.deepEqual(await promptContextLines({ dir }, 'no refs here'), [])
    const gates = await stopGateContributions({ dir })
    assert.ok(
      gates.some((g) => g.aspect === 'jira' && g.block === 'acme: JIRA-1 open')
    )
  })

  test('bdActor prefers BEADS_ACTOR over git config', () => {
    const prev = process.env.BEADS_ACTOR
    process.env.BEADS_ACTOR = 'env-agent'
    try {
      assert.equal(bdActor(process.cwd()), 'env-agent')
    } finally {
      if (prev === undefined) delete process.env.BEADS_ACTOR
      else process.env.BEADS_ACTOR = prev
    }
  })
})

describe('isOwnClaim', () => {
  const mine = new Set(['b1'])

  test('a marker id counts as own only when the store assignee matches', () => {
    assert.equal(isOwnClaim({ id: 'b1', assignee: 'me' }, mine, 'me'), true)
    assert.equal(isOwnClaim({ id: 'b1', assignee: 'other' }, mine, 'me'), false)
    assert.equal(isOwnClaim({ id: 'b2', assignee: 'me' }, mine, 'me'), false)
  })

  test('unverifiable rows keep the marker — fail-open', () => {
    assert.equal(isOwnClaim({ id: 'b1' }, mine, 'me'), true)
    assert.equal(isOwnClaim({ id: 'b1', assignee: 'x' }, mine, ''), true)
  })
})

describe('beads claim ownership', () => {
  // b1 is in the marker (bro work enter attempted) but held by another
  // actor; b2 is genuinely claimed by this session's actor.
  const opts = { claims: ['b1', 'b2'], list: CLAIMED_LIST }

  test('parallelWork still surfaces a refused marker claim', async () => {
    await withClaimRepo(opts, async (dir) => {
      const beads = (await parallelWorkLines({ dir, sessionId: 's1' })).find((l) =>
        l.startsWith('claimed beads:')
      )
      assert.match(beads ?? '', /\bb1\b/)
      assert.doesNotMatch(beads ?? '', /\bb2\b/)
    })
  })

  test('stopGate blocks only on verified own claims; refused stays passive', async () => {
    await withClaimRepo(opts, async (dir) => {
      const task = (await stopGateContributions({ dir, sessionId: 's1' })).filter(
        (g) => g.aspect === 'task'
      )
      const block = task.find((g) => g.block)
      const passive = task.find((g) => g.passive)
      assert.match(block?.block ?? '', /\bb2\b/)
      assert.doesNotMatch(block?.block ?? '', /\bb1\b/)
      assert.match(passive?.passive ?? '', /\bb1\b/)
    })
  })
})

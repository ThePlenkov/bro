import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectors,
  facade,
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

  test('no remote → registry order still resolves', () => {
    withRepo(null, (dir) => {
      const store = facade('tasks', { dir })
      assert.equal(typeof store.list, 'function')
    })
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
})

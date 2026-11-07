/** Command telemetry e2e — every CLI invocation journals one
 *  {event:'cmd'} row to <git-common>/bro/hooks/perf/commands.jsonl on
 *  process exit, and `bro telemetry` rolls it up next to the hook
 *  probe rows. Runs the built CLI so process.on('exit') really fires. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli, type CliResult } from './testrepo.ts'

const commandsFile = (main: string): string =>
  join(main, '.git', 'bro', 'hooks', 'perf', 'commands.jsonl')

const rows = (main: string): Array<Record<string, unknown>> =>
  existsSync(commandsFile(main))
    ? readFileSync(commandsFile(main), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []

describe('command telemetry', () => {
  test('a successful command journals one cmd row with its name + ms', () => {
    const { root, main } = initRepo('bro-telemetry-')
    inside(main, root, () => {
      const r: CliResult = runCli(['plugins'], { cwd: main })
      assert.equal(r.code, 0)
      const cmds = rows(main).filter((x) => x.event === 'cmd')
      assert.equal(cmds.length, 1)
      assert.equal(cmds[0]!.connector, 'plugins')
      assert.equal(cmds[0]!.probe, 'run')
      assert.equal(typeof cmds[0]!.ms, 'number')
      assert.equal(cmds[0]!.failed, undefined)
    })
  })

  test('a failing command marks the row failed — surfaces in the bad count', () => {
    const { root, main } = initRepo('bro-telemetry-')
    inside(main, root, () => {
      const r = runCli(['no-such-command'], { cwd: main })
      assert.notEqual(r.code, 0)
      const cmds = rows(main).filter((x) => x.event === 'cmd')
      assert.equal(cmds.length, 1)
      assert.equal(cmds[0]!.connector, 'no-such-command')
      assert.equal(cmds[0]!.failed, true)
    })
  })

  test('meta commands and BRO_TELEMETRY=0 journal nothing', () => {
    const { root, main } = initRepo('bro-telemetry-')
    inside(main, root, () => {
      runCli(['--version'], { cwd: main })
      runCli(['plugins'], { cwd: main, env: { BRO_TELEMETRY: '0' } })
      assert.equal(rows(main).length, 0)
    })
  })

  test('bro telemetry rolls commands into the perf report', () => {
    const { root, main } = initRepo('bro-telemetry-')
    inside(main, root, () => {
      runCli(['plugins'], { cwd: main })
      const r = runCli(['telemetry'], { cwd: main })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /cmd run plugins/)
      // telemetry's own row lands at ITS exit — after the report prints
      assert.equal(rows(main).filter((x) => x.event === 'cmd').length, 2)
    })
  })
})

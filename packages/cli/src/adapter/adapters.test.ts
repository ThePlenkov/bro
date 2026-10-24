/**
 * The bundled adapters must load, register their surfaces, and speak
 * their host's event vocabulary.
 *
 * These tests run against the *generated* artifacts under plugins/ —
 * the files a host actually loads. A bundle that splits into a chunk,
 * loses its default export, or drops the ownership sentinel breaks the
 * install silently: the host loads a file that registers nothing.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

interface LoadedAdapter {
  default: (pi: unknown) => void
  adapter?: { id: string; kind: string }
}

/** A host stub that records what the adapter registers. */
function hostStub(): {
  pi: unknown
  events: string[]
  commands: string[]
  tools: string[]
} {
  const events: string[] = []
  const commands: string[] = []
  const tools: string[] = []
  const pi = {
    on: (name: string) => events.push(name),
    registerCommand: (name: string) => commands.push(name),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    sendMessage: () => {},
  }
  return { pi, events, commands, tools }
}

async function loadAdapter(rel: string): Promise<LoadedAdapter> {
  const path = join(repoRoot, rel)
  assert.ok(existsSync(path), `${rel} is missing — run npm run gen:plugins`)
  return (await import(path)) as LoadedAdapter
}

/** The lifecycle events every adapter in this lineage registers. */
const LINEAGE_EVENTS = [
  'session_start',
  'session_before_compact',
  'session_compact',
  'before_agent_start',
  'tool_result',
  'turn_end',
  'session_shutdown',
]

/** Assert the surfaces every adapter registers, and the lifecycle
 *  events the lineage shares. The stop gate is the host's own — it is
 *  the one event whose name differs, so it is asserted separately. */
function assertLineageSurfaces(
  events: string[],
  commands: string[],
  tools: string[]
): void {
  for (const event of LINEAGE_EVENTS) {
    assert.ok(events.includes(event), `the adapter does not register ${event}`)
  }
  assert.deepEqual(commands, ['bro'])
  assert.deepEqual(tools, ['bro_status'])
}

test('the pi adapter loads, registers its surfaces, and speaks pi events', async () => {
  const mod = await loadAdapter('plugins/pi/bro/bro.ts')
  const { pi, events, commands, tools } = hostStub()
  mod.default(pi)

  assertLineageSurfaces(events, commands, tools)

  // pi's lifecycle vocabulary — the settle gate is pi's own
  assert.ok(events.includes('agent_before_settle'))
  // omp's vocabulary must NOT leak into pi's adapter
  assert.ok(!events.includes('session_stop'))

  assert.deepEqual(mod.adapter, { id: 'bro', kind: 'pi-extension' })
})

test('the omp adapter loads, registers its surfaces, and speaks omp events', async () => {
  const mod = await loadAdapter('plugins/omp/bro/bro.ts')
  const { pi, events, commands, tools } = hostStub()
  mod.default(pi)

  assertLineageSurfaces(events, commands, tools)

  // omp's own vocabulary — the native stop gate is session_stop
  assert.ok(events.includes('session_stop'))
  // pi's settle gate is pi's own — it must not leak into omp's adapter
  assert.ok(!events.includes('agent_before_settle'))

  assert.deepEqual(mod.adapter, { id: 'bro', kind: 'omp-extension' })
})

test('the omp adapter registers the mode bridges on omp events', async () => {
  const mod = await loadAdapter('plugins/omp/bro/bro.ts')
  const { pi, events } = hostStub()
  mod.default(pi)

  // the bridges are the reason bro is on omp at all — Plan, Goal and
  // Vibe each get bro's durable state
  assert.ok(events.includes('plan_review_requested'))
  assert.ok(events.includes('goal_updated'))
  assert.ok(events.includes('before_subagent_spawn'))
})

test('the omp guard hook blocks a force push and nothing else', async () => {
  const mod = await loadAdapter('plugins/omp/bro/hooks/pre/permission.ts')
  const handlers = new Map<string, (event: unknown) => unknown>()
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) }
  mod.default(pi)

  const guard = handlers.get('tool_call')
  assert.ok(guard, 'the guard registers no tool_call handler')

  const call = (command: unknown): unknown =>
    guard({ toolName: 'bash', input: { command } })

  // the rule: a force push rewrites the branch history bro's occupancy
  // plane depends on
  const blocked = call('git push --force origin main') as { block?: boolean } | undefined
  assert.equal(blocked?.block, true, 'a force push must be blocked')

  const short = call('git push -f origin main') as { block?: boolean } | undefined
  assert.equal(short?.block, true, 'the -f form must be blocked too')

  // the review-found bypass forms must be blocked too: git global
  // options before push, and the leading-`+` refspec
  const withGlobalOpt = call('git -C /repo push --force') as { block?: boolean } | undefined
  assert.equal(withGlobalOpt?.block, true, 'git -C <dir> push --force must be blocked')
  const withConfig = call('git -c key=val push -f') as { block?: boolean } | undefined
  assert.equal(withConfig?.block, true, 'git -c k=v push -f must be blocked')
  const plusRef = call('git push origin +main') as { block?: boolean } | undefined
  assert.equal(plusRef?.block, true, 'a leading-+ refspec is a force push')
  const behindSeparator = call('git push -f origin main; echo done') as { block?: boolean } | undefined
  assert.equal(behindSeparator?.block, true, 'a separator after the flag hides nothing')
  // the review-found forms: a grouped short cluster, a force inside a
  // shell's command string, and an env-prefixed invocation
  const grouped = call('git push -fu origin main') as { block?: boolean } | undefined
  assert.equal(grouped?.block, true, 'a grouped short cluster (-fu) is a force push')
  const nested = call("bash -c 'git push -f'") as { block?: boolean } | undefined
  assert.equal(nested?.block, true, 'a force in a shell -c string is a force')
  const prefixed = call('A=b git push -f') as { block?: boolean } | undefined
  assert.equal(prefixed?.block, true, 'env assignments do not hide the push')

  // a normal push, and the safe force form, are not the rule
  assert.equal(call('git push origin main'), undefined)
  assert.equal(call('git push --force-with-lease origin main'), undefined)
  // a quoted example is text, not a command — the tokenizer keeps it
  // in one word, and one word that is not `git` pushes nothing
  assert.equal(call('echo "git push --force"'), undefined)
  // a force flag in ANOTHER segment must not trip the guard — the
  // old [^\n]* pattern matched across shell separators
  assert.equal(call('echo --force && git push origin main'), undefined)
  // another tool, and another command, are not the rule
  assert.equal(guard({ toolName: 'read', input: { command: 'git push --force' } }), undefined)
  assert.equal(call('git commit --amend'), undefined)
  // a non-string command is not a command — it must not be stringified
  // into a truthy value that hides the real shape
  assert.equal(call({ nested: 'git push --force' }), undefined)
  assert.equal(call(undefined), undefined)
})

test('the shipped adapters carry the ownership sentinel', async () => {
  // `bro plugins install` refuses to overwrite a foreign file that
  // holds the slot — the sentinel is how bro recognizes its own, and
  // the bundler re-emits it as a banner (rolldown drops module
  // leading comments).
  for (const rel of ['plugins/pi/bro/bro.ts', 'plugins/omp/bro/bro.ts']) {
    const text = readFileSync(join(repoRoot, rel), 'utf8')
    assert.ok(text.includes('bro-adapter'), `${rel} lost the bro-adapter sentinel`)
  }
})

test('the shipped adapters resolve no sibling module', async () => {
  // a host loads the file with no node_modules — a relative import
  // would fail at load time, silently, in the host's session
  for (const rel of ['plugins/pi/bro/bro.ts', 'plugins/omp/bro/bro.ts']) {
    const text = readFileSync(join(repoRoot, rel), 'utf8')
    const relative = [...text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)].map((m) => m[1] ?? '')
    assert.deepEqual(relative, [], `${rel} imports a sibling module: ${relative.join(', ')}`)
  }
})

test('the omp adapter defers to the checkout the session runs in', async () => {
  const mod = await loadAdapter('plugins/omp/bro/bro.ts')
  const base = mkdtempSync(join(tmpdir(), 'bro-dev-omp-'))
  const priorCwd = process.cwd()
  try {
    const repo = join(base, 'repo')
    mkdirSync(join(repo, 'plugins', 'omp', 'bro'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'cli', 'src', 'adapter'), { recursive: true })
    const marker = join(base, 'local-ran')
    writeFileSync(
      join(repo, 'plugins', 'omp', 'bro', 'bro.ts'),
      `import { writeFileSync } from 'node:fs'\nexport default () => { writeFileSync(${JSON.stringify(marker)}, 'ran') }\n`
    )
    writeFileSync(join(repo, 'packages', 'cli', 'src', 'adapter', 'core.ts'), '')
    process.chdir(repo)
    const { pi, events, commands } = hostStub()
    mod.default(pi)
    // the installed copy wired nothing — the local bundle owns the host
    assert.equal(events.length, 0)
    assert.equal(commands.length, 0)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(readFileSync(marker, 'utf8'), 'ran')
  } finally {
    process.chdir(priorCwd)
    rmSync(base, { recursive: true, force: true })
  }
})

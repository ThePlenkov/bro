/**
 * `bro <verb> [noun|ref] [--flags]` — verb-first dispatch over the
 * registered doc types. Plugin lookup wins argv[0]; when no plugin
 * matches, the word is tried as a doc verb against every type's adapter
 * (adapter methods are the registry — see core/docs.ts).
 *
 *   bro list [tasks] [--status=open]     standard: list|show|new|set|rm
 *   bro show bro-n5t                     ref → type inference (idPrefix)
 *   bro close bro-n5t --reason=done      custom verb, same arg shape
 *   bro … --global                       scope flag → global store
 *   bro exec -- --raw bd args            escape hatch per doc type
 *
 * Flag convention for doc verbs: `--key=value` or boolean `--key`.
 * `--k v` pairs are NOT consumed (a value would eat the ref).
 */
import {
  docTypeNamed,
  docVerbs,
  gitTry,
  STANDARD_VERBS,
  verbMethod,
  type DocCtx,
  type DocFlags,
  type DocType,
  type Scope,
} from '@bro/core'
import { PLUGINS } from './plugins.ts'
import { storeDoc } from './doctypes/store.ts'
import { taskDoc } from './doctypes/task.ts'

const BUILTIN_DOCS: DocType[] = [taskDoc, storeDoc]
const EXTRA_DOCS: DocType[] = []

/** Runtime registration — external plugin loaders and tests. */
export function registerDocType(type: DocType): void {
  EXTRA_DOCS.push(type)
}

/** All registered doc types — builtins, plugin `docs` fields, and
 *  runtime registrations. */
export function docTypes(): DocType[] {
  return [...BUILTIN_DOCS, ...PLUGINS.flatMap((p) => p.docs ?? []), ...EXTRA_DOCS]
}

/** Parse argv for doc verbs: `--key=value`, boolean `--key`, scope
 *  flags, and `--` ending flag parsing (rest is raw positional). */
export function docArgs(argv: string[]): {
  positional: string[]
  flags: DocFlags
  scope: Scope
} {
  const positional: string[] = []
  const flags: DocFlags = {}
  let scope: Scope = 'project'
  let raw = false
  for (const a of argv) {
    if (raw) {
      positional.push(a)
    } else if (a === '--') {
      raw = true
    } else if (a === '--global') {
      scope = 'global'
    } else if (a === '--project') {
      scope = 'project'
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        flags[a.slice(2)] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags, scope }
}

interface Bound {
  type: DocType
  adapter: ReturnType<DocType['adapter']>
  method: (...args: never[]) => unknown
}

/** The doc-type a verb + first positional resolves to. Positionals may
 *  be `[noun, ref…]` or `[ref…]`; a missing noun falls back to `task`
 *  (the dominant type), then to a unique supporter of the verb. */
function resolveType(
  supporting: Bound[],
  positional: string[],
  cmd: string
): { bound: Bound; rest: string[] } | undefined {
  const named =
    positional[0] !== undefined
      ? supporting.find((b) => docTypeNamed(b.type, positional[0]!))
      : undefined
  if (named) {
    return { bound: named, rest: positional.slice(1) }
  }
  // 'store' is a noun even when store lacks this verb — `bro close
  // store` must say "not supported on store", not silently read
  // 'store' as a task ref and go hunting for it in beads
  const knownNoun =
    positional[0] !== undefined
      ? docTypes().find((t) => docTypeNamed(t, positional[0]!))
      : undefined
  if (knownNoun) {
    die(`bro ${cmd} is not supported on ${knownNoun.name}`)
  }
  const rest = positional
  // ref-shaped first arg — infer the type by prefix, else task, else
  // the only type that can serve the verb at all
  const inferred =
    (positional[0] !== undefined &&
      supporting.find((b) => b.type.idPrefix && positional[0]!.startsWith(b.type.idPrefix))) ||
    supporting.find((b) => b.type.name === 'task') ||
    (supporting.length === 1 ? supporting[0] : undefined)
  return inferred ? { bound: inferred, rest } : undefined
}

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(2)
}

function needRef(ref: string | undefined, verb: string): string {
  if (!ref) {
    die(`bro ${verb} needs a ref — \`bro ${verb} <id>\``)
  }
  return ref
}

function printResult(type: DocType, verb: string, result: unknown): void {
  if (result === undefined || result === null) {
    return
  }
  const render = type.render ?? ((d: unknown) => JSON.stringify(d))
  if (Array.isArray(result) || (result as Iterable<unknown>)[Symbol.iterator] !== undefined) {
    for (const d of result as Iterable<unknown>) {
      console.log(render(d))
    }
    return
  }
  if (verb === 'get' || verb === 'show') {
    const describe = type.describe ?? ((d: unknown) => JSON.stringify(d, null, 2))
    console.log(describe(result))
    return
  }
  console.log(render(result))
}

/**
 * Try `cmd` as a doc verb. Returns false when no registered type
 * exposes it — the caller falls through to "unknown command".
 */
export async function runDocVerb(cmd: string, argv: string[]): Promise<boolean> {
  const { positional, flags, scope } = docArgs(argv)
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
  const ctx: DocCtx = { root, scope }
  const supporting = docTypes()
    .map((t) => {
      const adapter = t.adapter(ctx)
      const method = verbMethod(adapter, cmd)
      return method ? ({ type: t, adapter, method } as Bound) : undefined
    })
    .filter((b): b is Bound => b !== undefined)
  if (supporting.length === 0) {
    return false
  }
  const hit = resolveType(supporting, positional, cmd)
  if (!hit) {
    die(
      `bro ${cmd} needs a noun — ` +
        supporting.map((b) => b.type.name).join('|') +
        ` (e.g. \`bro ${cmd} ${supporting[0]!.type.name} …\`)`
    )
  }
  const { bound, rest } = hit
  const { type, adapter } = bound
  if (scope === 'global' && !(type.scopes ?? ['project']).includes('global')) {
    die(`--global is not supported on ${type.name}`)
  }

  const role = STANDARD_VERBS[cmd]
  let result: unknown
  switch (role) {
    case 'list':
      result = [...(adapter.list?.(flags) ?? [])]
      break
    case 'get':
      result = adapter.get?.(needRef(rest[0], cmd)) ?? die(`${type.name} "${rest[0]}" not found`)
      break
    case 'create':
      result = adapter.create?.({ ...flags, title: rest.join(' ') }, flags)
      break
    case 'update':
      result = adapter.update?.(needRef(rest[0], cmd), flags)
      break
    case 'remove':
      adapter.remove?.(needRef(rest[0], cmd))
      break
    default:
      // custom verb — ref is a convenience head; `positional` carries
      // the full tail so passthrough verbs (exec) lose nothing
      result = await (bound.method as (
        ref: string | undefined,
        flags: DocFlags,
        positional: string[]
      ) => unknown)(rest[0], flags, rest)
  }
  printResult(type, cmd, result)
  return true
}

/** Verb names external plugins must not take — plugin lookup wins
 *  argv[0], so a plugin named `list` would shadow every doc type's
 *  list. Computed from builtin docs before external plugins load. */
export function reservedDocVerbs(root = process.cwd()): Set<string> {
  const ctx: DocCtx = { root, scope: 'project' }
  const verbs = new Set(Object.keys(STANDARD_VERBS))
  for (const t of docTypes()) {
    for (const v of docVerbs(t.adapter(ctx))) {
      verbs.add(v)
    }
  }
  return verbs
}

/** Verb/noun lines for `bro --help` — discovered, not hardcoded. */
export function docUsageLines(): string[] {
  const root = process.cwd()
  const ctx: DocCtx = { root, scope: 'project' }
  const verbs = new Set<string>()
  const nouns: string[] = []
  for (const t of docTypes()) {
    for (const v of docVerbs(t.adapter(ctx))) {
      verbs.add(v)
    }
    nouns.push(t.name)
  }
  return [
    `  doc verbs: ${[...verbs].join(' ')}`,
    `  doc nouns: ${nouns.join(' ')}   (e.g. \`bro list tasks\`, \`bro show <id>\`, \`bro init store --global\`)`,
  ]
}

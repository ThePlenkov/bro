/**
 * `bro <noun> <verb> [ref…] [--flags]` — gh-style noun-first dispatch
 * over the registered doc types. Verbs live inside their noun's
 * namespace: `bro store init` and `bro task exec` never collide, and a
 * plugin doc type's custom verbs are free by construction. Adapter
 * methods are the verb registry (see core/docs.ts).
 *
 *   bro task list [--status=open]       standard: list|show|new|set|rm
 *   bro task show bro-n5t               the noun namespaces the verb
 *   bro store init --global             scope flag → global store
 *   bro task exec -- <raw bd args>      escape hatch per doc type
 *   bro <noun>                          bare noun = `list` if supported
 *
 * Verb-first shorthand stays bound to the default type (task) plus
 * ref-prefix inference: `bro list`, `bro show bro-n5t`,
 * `bro close <id>`. A noun or a non-task verb in that position gets a
 * `bro <noun> <verb>` redirect, never a silent reinterpretation.
 *
 * Flag convention: `--key=value` or boolean `--key`; `--k v` pairs are
 * NOT consumed (a value would eat the ref).
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
} from '@broject/core'
import { PLUGINS } from './plugins.ts'
import { storeDoc } from './doctypes/store.ts'
import { taskDoc } from './doctypes/task.ts'

const BUILTIN_DOCS: DocType[] = [taskDoc, storeDoc]
const EXTRA_DOCS: DocType[] = []

/** Runtime registration — external plugin loaders and tests. */
export function registerDocType(type: DocType): void {
  EXTRA_DOCS.push(type)
}

/** Registration filter: a doc type whose noun duplicates another
 *  type's name/alias, spells a standard verb (`bro list` where 'list'
 *  is also a noun is unparseable), or overlaps another type's
 *  idPrefix (bare-ref inference becomes ambiguous) is dropped with a
 *  warning — one bad plugin doc must not corrupt the namespace. */
export function filterDocTypes(types: DocType[]): DocType[] {
  const nouns = new Set<string>()
  const prefixes: [string, string][] = []
  const out: DocType[] = []
  for (const t of types) {
    const names = [t.name, ...(t.aliases ?? [])]
    const clash = names.find((n) => nouns.has(n) || Object.hasOwn(STANDARD_VERBS, n))
    if (clash) {
      console.error(`warning: doc type "${t.name}" noun "${clash}" is reserved — skipped`)
      continue
    }
    const px = t.idPrefix && prefixes.find(([p]) => p.startsWith(t.idPrefix!) || t.idPrefix!.startsWith(p))
    if (px) {
      console.error(
        `warning: doc type "${t.name}" idPrefix "${t.idPrefix}" overlaps "${px[1]}" — skipped`
      )
      continue
    }
    for (const n of names) {
      nouns.add(n)
    }
    if (t.idPrefix) {
      prefixes.push([t.idPrefix, t.name])
    }
    out.push(t)
  }
  return out
}

let docTypesCache: { sig: string; filtered: DocType[] } | undefined

/** All registered doc types — builtins, plugin `docs` fields, and
 *  runtime registrations — minus namespace collisions. Memoized on the
 *  registration list plus the filter-relevant fields (name/aliases/
 *  idPrefix) so a collision warning prints once per process instead of
 *  once per call site (reservedWords/dispatch/--help all call this).
 *  Any registration — registerDocType, a plugin pushed after external
 *  load, or an in-place mutation of a registered type — rebuilds the
 *  list and re-filters once. */
export function docTypes(): DocType[] {
  const raw = [...BUILTIN_DOCS, ...PLUGINS.flatMap((p) => p.docs ?? []), ...EXTRA_DOCS]
  const sig = raw.map((t) => `${t.name}${t.aliases?.join(',') ?? ''}${t.idPrefix ?? ''}`).join('\n')
  if (docTypesCache?.sig !== sig) {
    docTypesCache = { sig, filtered: filterDocTypes(raw) }
  }
  return docTypesCache.filtered
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

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(2)
}

function needRef(type: DocType, ref: string | undefined, verb: string): string {
  if (!ref) {
    die(`bro ${type.name} ${verb} needs a ref — \`bro ${type.name} ${verb} <id>\``)
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

/** Invoke `verb` on `type`'s adapter — unknown verbs die with the
 *  type's discovered verb list (the noun is already explicit). */
async function runBound(
  type: DocType,
  verb: string,
  rest: string[],
  flags: DocFlags,
  ctx: DocCtx
): Promise<true> {
  const adapter = type.adapter(ctx)
  const method = verbMethod(adapter, verb)
  if (!method) {
    die(`bro ${type.name} ${verb} — ${type.name} verbs: ${docVerbs(adapter).join(' ')}`)
  }
  if (ctx.scope === 'global' && !(type.scopes ?? ['project']).includes('global')) {
    die(`--global is not supported on ${type.name}`)
  }

  let result: unknown
  switch (STANDARD_VERBS[verb]) {
    case 'list':
      result = [...(adapter.list?.(flags) ?? [])]
      break
    case 'get':
      result = adapter.get?.(needRef(type, rest[0], verb)) ?? die(`${type.name} "${rest[0]}" not found`)
      break
    case 'create':
      result = adapter.create?.({ ...flags, title: rest.join(' ') }, flags)
      break
    case 'update':
      result = adapter.update?.(needRef(type, rest[0], verb), flags)
      break
    case 'remove':
      adapter.remove?.(needRef(type, rest[0], verb))
      break
    default:
      // custom verb — ref is a convenience head; `positional` carries
      // the full tail so passthrough verbs (exec) lose nothing
      result = await (method as (
        ref: string | undefined,
        flags: DocFlags,
        positional: string[]
      ) => unknown)(rest[0], flags, rest)
  }
  printResult(type, verb, result)
  return true
}

/**
 * Dispatch `cmd` into the doc layer. Noun-first is the grammar:
 * `bro <noun> [verb] [ref…]` (bare noun → `list` when supported).
 * Verb-first is shorthand bound to the default type plus ref-prefix
 * inference. Returns false when `cmd` is neither a noun nor a doc
 * verb — the caller falls through to "unknown command".
 */
export async function runDocVerb(cmd: string, argv: string[]): Promise<boolean> {
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
  const { positional, flags, scope } = docArgs(argv)
  const ctx: DocCtx = { root, scope }
  const types = docTypes()

  // noun-first — canonical: `bro store init --global`
  const noun = types.find((t) => docTypeNamed(t, cmd))
  if (noun) {
    const [verb = 'list', ...rest] = positional
    return runBound(noun, verb, rest, flags, ctx)
  }

  // verb-first shorthand: ref-prefix inference wins, else the default
  // type (task). `bro show bro-n5t` / `bro list` — anything noun- or
  // foreign-verb-shaped gets a noun-first redirect, not silent magic.
  const pref = positional[0]
  const inferred =
    (pref !== undefined &&
      types.find((t) => t.idPrefix && pref.startsWith(t.idPrefix))) ||
    types.find((t) => t.name === 'task') ||
    types[0]
  if (!inferred) {
    return false
  }
  if (!verbMethod(inferred.adapter(ctx), cmd)) {
    const owner = types.find((t) => verbMethod(t.adapter(ctx), cmd) !== undefined)
    if (owner) {
      die(`'${cmd}' is a ${owner.name} verb — use \`bro ${owner.name} ${cmd} …\``)
    }
    return false
  }
  if (pref !== undefined && types.some((t) => t !== inferred && docTypeNamed(t, pref))) {
    die(`'${pref}' is a doc noun — use \`bro ${pref} ${cmd} …\``)
  }
  // the bound type's own noun stays consumable: `bro show task <id>`
  const rest = pref !== undefined && docTypeNamed(inferred, pref) ? positional.slice(1) : positional
  return runBound(inferred, cmd, rest, flags, ctx)
}

/** Words external plugins must not take as command names — plugin
 *  lookup wins argv[0], so a plugin named `list` would shadow the doc
 *  layer, and one named `task` would look like a doc noun it isn't.
 *  The set is computed, not declared: plugin commands ∪ doc nouns ∪
 *  discovered doc verbs. Everything else is usable. */
export function reservedWords(root = process.cwd()): Set<string> {
  const ctx: DocCtx = { root, scope: 'project' }
  const words = new Set(Object.keys(STANDARD_VERBS))
  for (const p of PLUGINS) {
    words.add(p.name)
  }
  for (const t of docTypes()) {
    words.add(t.name)
    for (const a of t.aliases ?? []) {
      words.add(a)
    }
    for (const v of docVerbs(t.adapter(ctx))) {
      words.add(v)
    }
  }
  return words
}

/** Noun/verb lines for `bro --help` — discovered, not hardcoded.
 *  `verbs` here means the shorthand surface: the default type's verbs
 *  usable verb-first; every type's full verb set lives behind
 *  `bro <noun> <verb>`. */
export function docUsageLines(): string[] {
  const root = process.cwd()
  const ctx: DocCtx = { root, scope: 'project' }
  const types = docTypes()
  const def = types.find((t) => t.name === 'task') ?? types[0]
  const verbs = def ? docVerbs(def.adapter(ctx)) : []
  return [
    `  doc types: ${types.map((t) => t.name).join(' ')}   — \`bro <noun> <verb>\` (e.g. \`bro task list\`, \`bro store init --global\`)`,
    `  shorthand: ${verbs.join(' ')}   — ${def?.name ?? 'task'} verbs usable verb-first (\`bro show <id>\`)`,
  ]
}

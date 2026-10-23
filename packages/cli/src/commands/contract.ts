/**
 * `bro contract` — the machine-readable CLI surface (spec bro-k9ces).
 * Hidden plumbing: agents and transports (serve, mcp, ACP) read the
 * dump instead of parsing usage prose.
 *
 *   bro contract dump [--json]   registry → compact table / JSON doc
 *   bro contract check           committed contract/cli.json vs the live
 *                                dump — drift fails, an announced
 *                                removal (contract/BREAKING.md) does not
 *   bro contract gen             regenerate contract/cli.json
 *
 * check/gen take --contract/--dump/--breaking file overrides — the
 * reconcile engine is pure, so fixtures keep git and the network out.
 * They also build the live dump from core plugins only — external
 * plugins come from machine-local config and must not leak into the
 * committed snapshot.
 *
 * Canonical key paths (what BREAKING.md bullets and `removed`
 * tombstones name): a command is `<name>`, a group `groups.<g>`,
 * inside a command `<name>.contract|.group|.aliasOf|.argvPrefix|.json`
 * and `<name>[.subs.<s>].flags.<f>|.exits.<e>`. Announcing a path
 * covers everything under it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BroPlugin, CliContract, CliSubContract } from '@broject/core'
import { flag } from './args.ts'

export const CONTRACT_VERSION = 1

/** The committed file and any --dump override are untrusted input —
 *  every walk guards record shape so a malformed file reports drift
 *  instead of crashing. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const eqJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

// --- the dump --------------------------------------------------------------

export interface ContractCommandRow {
  name: string
  group?: string
  summary: string
  /** Every invocation spelling — the flat `bro <name>` plus
   *  `bro <group> <name>` for grouped members. A group host has no
   *  second spelling (`bro plan plan` is not one). */
  spellings: string[]
  /** Names that alias TO this command (reverse aliasOf). */
  aliases: string[]
  aliasOf?: string
  deprecated?: string
  flatDeprecated?: string
  hidden: boolean
  skill?: string
  configKey?: string
  plan: boolean
  planVersion?: number
  /** Argv spliced ahead of the user's args — a reroute as real as
   *  aliasOf (`unwind` → `drill up`). */
  argvPrefix?: string[]
  contract?: CliContract
  external: boolean
}

export interface ContractDump {
  version: number
  groups: Record<string, { summary?: string; members: string[] }>
  commands: Record<string, ContractCommandRow>
}

function spellings(p: BroPlugin): string[] {
  return p.group !== undefined && p.group !== p.name
    ? [p.name, `${p.group} ${p.name}`]
    : [p.name]
}

function commandRow(p: BroPlugin, aliases: string[]): ContractCommandRow {
  return {
    name: p.name,
    group: p.group,
    summary: p.summary,
    spellings: spellings(p),
    aliases,
    aliasOf: p.aliasOf,
    deprecated: p.deprecated,
    flatDeprecated: p.flatDeprecated,
    hidden: p.hidden === true,
    skill: p.skill,
    configKey: p.configKey,
    plan: p.planSchema !== undefined,
    planVersion: p.planSchema !== undefined ? (p.planVersion ?? 1) : undefined,
    argvPrefix: p.argvPrefix,
    contract: p.contract,
    external: p.external === true,
  }
}

/** Groups in declared-meta order first, then groups only external
 *  plugins add; every plugin lands in its group's members. */
function groupRows(
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): Map<string, { summary?: string; members: string[] }> {
  const meta = new Map(groupMeta)
  const order = [
    ...meta.keys(),
    ...plugins
      .map((p) => p.group)
      .filter((g): g is string => g !== undefined && !meta.has(g)),
  ]
  const rows = new Map<string, { summary?: string; members: string[] }>()
  for (const g of order) {
    rows.set(g, { summary: meta.get(g), members: [] })
  }
  for (const p of plugins) {
    if (p.group !== undefined) {
      rows.get(p.group)?.members.push(p.name)
    }
  }
  return rows
}

/** The live registry as the contract document — deterministic: key
 *  order is registry/group order, no timestamps, no tool version.
 *  Maps → Object.fromEntries, so a plugin named `__proto__` still
 *  lands as an own enumerable key. */
export function buildDump(
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): ContractDump {
  // name → the commands that alias to it (registry order)
  const aliasTo = new Map<string, string[]>()
  for (const p of plugins) {
    if (p.aliasOf !== undefined) {
      const target = p.aliasOf.split(' ')[0] ?? ''
      aliasTo.set(target, [...(aliasTo.get(target) ?? []), p.name])
    }
  }
  const commands = new Map<string, ContractCommandRow>()
  for (const p of plugins) {
    commands.set(p.name, commandRow(p, aliasTo.get(p.name) ?? []))
  }
  return {
    version: CONTRACT_VERSION,
    groups: Object.fromEntries(groupRows(plugins, groupMeta)),
    commands: Object.fromEntries(commands),
  }
}

// --- the reconcile engine ----------------------------------------------------

/** The committed snapshot — the dump plus the tombstone ledger. */
export interface ContractDoc extends ContractDump {
  removed: Record<string, unknown>
}

export interface ContractProblem {
  kind: 'breaking' | 'stale' | 'ledger'
  /** canonical path — the BREAKING.md bullet token */
  path: string
  message: string
}

interface Removal {
  path: string
  value: unknown
}

const emptyDoc = (): ContractDoc => ({
  version: CONTRACT_VERSION,
  groups: {},
  commands: {},
  removed: {},
})

/** Coerce parsed JSON into the doc shape — unknown fields ride along
 *  only inside commands/groups/removed; anything else degrades to the
 *  empty-doc default (drift, not a crash). */
function asDoc(parsed: unknown): ContractDoc {
  if (!isRecord(parsed)) {
    return emptyDoc()
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : CONTRACT_VERSION,
    groups: isRecord(parsed.groups) ? (parsed.groups as ContractDump['groups']) : {},
    commands: isRecord(parsed.commands)
      ? (parsed.commands as ContractDoc['commands'])
      : {},
    removed: isRecord(parsed.removed) ? parsed.removed : {},
  }
}

/** `- <path> — reason` bullets → the announced path set. A trailing
 *  colon on the token is punctuation, not part of the path. */
export function parseBreaking(md: string): Set<string> {
  const out = new Set<string>()
  for (const line of md.split('\n')) {
    const m = /^\s*[-*]\s+(\S+)/.exec(line)
    if (m !== null && m[1] !== undefined) {
      out.add(m[1].replace(/:$/, ''))
    }
  }
  return out
}

/** An announcement covers its own path and every descendant —
 *  announcing a command covers everything it carried. */
function covered(path: string, announced: ReadonlySet<string>): boolean {
  for (const a of announced) {
    if (path === a || path.startsWith(`${a}.`)) {
      return true
    }
  }
  return false
}

/** When a whole committed map is gone, each leaf is still reported at
 *  its own dotted path — a bullet may name the map OR a single entry. */
function removedLeaves(prefix: string, committed: Record<string, unknown>): Removal[] {
  return Object.entries(committed).map(([k, v]) => ({
    path: `${prefix}.${k}`,
    value: v,
  }))
}

/** Keys present in a committed scalar map (flags/exits) but absent
 *  live are removals. Non-record committed values degrade to stale
 *  drift via eqJson, never a walk over garbage. */
function diffMap(prefix: string, committed: unknown, live: unknown): Removal[] {
  if (!isRecord(committed)) {
    return []
  }
  if (!isRecord(live)) {
    return removedLeaves(prefix, committed)
  }
  const out: Removal[] = []
  for (const [k, cv] of Object.entries(committed)) {
    if (live[k] === undefined) {
      out.push({ path: `${prefix}.${k}`, value: cv })
    }
  }
  return out
}

/** The subs map — same leaf semantics, but each surviving key descends
 *  into its own sub-contract for flag/exit/json diffs. */
function diffSubs(prefix: string, committed: unknown, live: unknown): Removal[] {
  if (!isRecord(committed)) {
    return []
  }
  if (!isRecord(live)) {
    return removedLeaves(prefix, committed)
  }
  const out: Removal[] = []
  for (const [sub, cv] of Object.entries(committed)) {
    const lv = live[sub]
    if (lv === undefined) {
      out.push({ path: `${prefix}.${sub}`, value: cv })
    } else if (isRecord(cv) && isRecord(lv)) {
      out.push(...diffSub(`${prefix}.${sub}`, cv as CliSubContract, lv as CliSubContract))
    }
  }
  return out
}

/** Removals inside one contract level — the bare command and each sub
 *  share the flags/exits/json shape. */
function diffSub(
  prefix: string,
  committed: CliSubContract,
  live: CliSubContract
): Removal[] {
  const out = [
    ...diffMap(`${prefix}.flags`, committed.flags, live.flags),
    ...diffMap(`${prefix}.exits`, committed.exits, live.exits),
  ]
  if (committed.json !== undefined && live.json === undefined) {
    out.push({ path: `${prefix}.json`, value: committed.json })
  }
  return out
}

function diffContract(
  name: string,
  committed: unknown,
  live: CliContract | undefined
): Removal[] {
  if (!isRecord(committed)) {
    return []
  }
  if (live === undefined) {
    return [{ path: `${name}.contract`, value: committed }]
  }
  return [
    ...diffSub(name, committed as CliSubContract, live),
    ...diffSubs(`${name}.subs`, committed.subs, live.subs),
  ]
}

/** Invocation-meaning scalars on a surviving command — a difference
 *  reroutes `bro <name>` under the same spelling. */
function commandRemovals(
  name: string,
  committed: Record<string, unknown>,
  live: ContractCommandRow
): Removal[] {
  const out: Removal[] = []
  // a group change kills the `bro <old-group> <name>` spelling; a group
  // ADDED to a formerly top-level command only adds one
  if (committed.group !== live.group && committed.group !== undefined) {
    out.push({ path: `${name}.group`, value: committed.group })
  }
  // aliasOf and argvPrefix differences reroute the invocation — added,
  // changed, or removed, the spelling runs different code
  if (committed.aliasOf !== live.aliasOf) {
    out.push({ path: `${name}.aliasOf`, value: committed.aliasOf })
  }
  if (!eqJson(committed.argvPrefix, live.argvPrefix)) {
    out.push({ path: `${name}.argvPrefix`, value: committed.argvPrefix })
  }
  out.push(...diffContract(name, committed.contract, live.contract))
  return out
}

function groupRemovals(
  committedGroups: Record<string, unknown>,
  live: ContractDump
): Removal[] {
  const out: Removal[] = []
  for (const [g, v] of Object.entries(committedGroups)) {
    if (live.groups[g] === undefined) {
      out.push({ path: `groups.${g}`, value: v })
    }
  }
  return out
}

function commandRowRemovals(
  committedCommands: Record<string, unknown>,
  live: ContractDump
): Removal[] {
  const out: Removal[] = []
  for (const [name, c] of Object.entries(committedCommands)) {
    const l = live.commands[name]
    if (l === undefined) {
      out.push({ path: name, value: c })
    } else if (isRecord(c)) {
      out.push(...commandRemovals(name, c, l))
    }
    // a non-record committed row is drift — the stale pass reports it
  }
  return out
}

/** Paths present in the committed doc whose removal changes the
 *  invocation surface — commands, groups, invocation-spelling scalars
 *  (group/aliasOf/argvPrefix), and every declared contract leaf. */
function removals(committed: ContractDoc, live: ContractDump): Removal[] {
  const committedGroups = isRecord(committed.groups) ? committed.groups : {}
  const committedCommands = isRecord(committed.commands) ? committed.commands : {}
  return [
    ...groupRemovals(committedGroups, live),
    ...commandRowRemovals(committedCommands, live),
  ]
}

/** Additions and value edits inside one map — `(added)` marks keys the
 *  committed doc never had. */
function mapStale(
  prefix: string,
  committed: unknown,
  doc: unknown
): string[] {
  if (!isRecord(doc)) {
    return []
  }
  const committedMap = isRecord(committed) ? committed : {}
  const out: string[] = []
  for (const [k, v] of Object.entries(doc)) {
    const c = committedMap[k]
    if (c === undefined) {
      out.push(`${prefix === '' ? k : `${prefix}.${k}`} (added)`)
    } else if (!eqJson(c, v)) {
      out.push(prefix === '' ? k : `${prefix}.${k}`)
    }
  }
  return out
}

/** Committed-vs-doc drift that is NOT a surface removal — additions
 *  and meaning edits. Fixed by regeneration, never an announcement. */
function stalePaths(committed: ContractDoc, doc: ContractDoc): string[] {
  const out: string[] = []
  if (committed.version !== doc.version) {
    out.push('version')
  }
  out.push(...mapStale('groups', committed.groups, doc.groups))
  out.push(...mapStale('', committed.commands, doc.commands))
  if (!eqJson(committed.removed, doc.removed)) {
    out.push('removed')
  }
  return out
}

/** The gate as data: what the committed file should become and why it
 *  can't yet. Announced removals move to `removed` (old value kept);
 *  unannounced ones are breaking problems; everything else different
 *  is stale. */
export function reconcileContract(
  committed: ContractDoc,
  live: ContractDump,
  announced: ReadonlySet<string>
): { doc: ContractDoc; problems: ContractProblem[] } {
  const problems: ContractProblem[] = []
  const removed = new Map<string, unknown>(Object.entries(committed.removed))
  for (const r of removals(committed, live)) {
    if (!covered(r.path, announced)) {
      problems.push({
        kind: 'breaking',
        path: r.path,
        message: 'surface removed or respelled — announce it in contract/BREAKING.md',
      })
      continue
    }
    removed.set(r.path, r.value)
  }
  for (const k of removed.keys()) {
    if (!covered(k, announced)) {
      problems.push({
        kind: 'ledger',
        path: `removed.${k}`,
        message: 'tombstone has no BREAKING.md bullet — the ledger cannot be quietly edited around',
      })
    }
  }
  const doc: ContractDoc = {
    version: live.version,
    groups: live.groups,
    commands: live.commands,
    removed: Object.fromEntries(removed),
  }
  for (const path of stalePaths(committed, doc)) {
    problems.push({ kind: 'stale', path, message: 'run `npm run gen:contract`' })
  }
  return { doc, problems }
}

// --- the command -------------------------------------------------------------

/** A JSON fixture/snapshot — read + parse, exit 2 on garbage. Typed at
 *  the parse site so no call-site cast can smuggle `undefined` through
 *  when process.exit is stubbed. */
function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    console.error(
      `contract: ${path} — ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(2)
  }
}

/** tmp + rename — a `check` racing a `gen`, or a crash mid-write, never
 *  sees a truncated snapshot. */
function writeDocAtomic(path: string, doc: ContractDoc): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  renameSync(tmp, path)
}

function printTable(dump: ContractDump): void {
  for (const c of Object.values(dump.commands)) {
    const flags =
      Object.keys(c.contract?.flags ?? {}).length +
      Object.values(c.contract?.subs ?? {}).reduce(
        (n, s) => n + Object.keys(s.flags ?? {}).length,
        0
      )
    const marker = c.aliasOf !== undefined ? `→ ${c.aliasOf}` : c.hidden ? 'hidden' : String(flags)
    console.log(
      `${c.name.padEnd(12)} ${(c.group ?? '-').padEnd(8)} ${(c.skill ?? '-').padEnd(10)} ` +
        `${marker.padEnd(10)} ${c.summary}`
    )
  }
}

function reportProblems(problems: ContractProblem[]): void {
  for (const p of problems) {
    console.error(`  ${p.kind.padEnd(8)} ${p.path} — ${p.message}`)
  }
}

interface GatePaths {
  contractPath: string
  breakingPath: string
  dumpPath?: string
}

function gatePaths(rest: string[]): GatePaths {
  return {
    contractPath: flag(rest, '--contract') ?? 'contract/cli.json',
    breakingPath: flag(rest, '--breaking') ?? 'contract/BREAKING.md',
    dumpPath: flag(rest, '--dump'),
  }
}

function cmdGen(
  contractPath: string,
  committedRaw: string | undefined,
  doc: ContractDoc,
  problems: ContractProblem[]
): void {
  const fatal = problems.filter((p) => p.kind !== 'stale')
  if (fatal.length > 0) {
    console.error(
      `contract: refusing to regenerate — ${fatal.length} unannounced breaking change(s)`
    )
    reportProblems(fatal)
    process.exit(1)
  }
  // optimistic CAS — a second gen or a hand edit landing mid-run must
  // not be silently clobbered
  if (existsSync(contractPath) && readFileSync(contractPath, 'utf8') !== committedRaw) {
    console.error(`contract: ${contractPath} changed mid-gen — rerun`)
    process.exit(1)
  }
  writeDocAtomic(contractPath, doc)
  console.log(
    `${contractPath}: regenerated — ${Object.keys(doc.commands).length} commands, ${Object.keys(doc.removed).length} tombstone(s)`
  )
}

function cmdGate(
  sub: 'check' | 'gen',
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>,
  rest: string[]
): void {
  const { contractPath, breakingPath, dumpPath } = gatePaths(rest)
  const live =
    dumpPath !== undefined
      ? readJsonFile<ContractDump>(dumpPath)
      : buildDump(
          // the committed surface is the repo's registry — external
          // plugins are machine-local config and must not drift it
          plugins.filter((p) => p.external !== true),
          groupMeta
        )
  const committedRaw = existsSync(contractPath)
    ? readFileSync(contractPath, 'utf8')
    : undefined
  const committed =
    committedRaw === undefined
      ? emptyDoc()
      : asDoc(readJsonFile<ContractDoc>(contractPath))
  const announced = parseBreaking(
    existsSync(breakingPath) ? readFileSync(breakingPath, 'utf8') : ''
  )
  const { doc, problems } = reconcileContract(committed, live, announced)
  if (sub === 'gen') {
    cmdGen(contractPath, committedRaw, doc, problems)
    return
  }
  if (problems.length === 0) {
    console.log(`${contractPath}: fresh`)
    return
  }
  console.error(`contract: ${problems.length} problem(s) in ${contractPath}`)
  reportProblems(problems)
  process.exit(1)
}

export function runContractCommand(
  argv: string[],
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): void {
  const [sub, ...rest] = argv
  if (sub === 'dump') {
    const dump = buildDump(plugins, groupMeta)
    if (rest.includes('--json')) {
      console.log(JSON.stringify(dump, null, 2))
    } else {
      printTable(dump)
    }
    return
  }
  if (sub === 'check' || sub === 'gen') {
    cmdGate(sub, plugins, groupMeta, rest)
    return
  }
  console.error(
    'usage: bro contract dump [--json] | check [--contract f] [--dump f] [--breaking f] | gen [same flags]'
  )
  process.exit(2)
}

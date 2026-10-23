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
 *
 * Canonical key paths (what BREAKING.md bullets and `removed`
 * tombstones name): a command is `<name>`, a group `groups.<g>`,
 * inside a command `<name>.contract|.group|.aliasOf|.json` and
 * `<name>[.subs.<s>].flags.<f>|.exits.<e>`. Announcing a path covers
 * everything under it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BroPlugin, CliContract, CliSubContract } from '@broject/core'
import { flag } from './args.ts'

export const CONTRACT_VERSION = 1

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

/** The live registry as the contract document — deterministic: key
 *  order is registry/group order, no timestamps, no tool version. */
export function buildDump(
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): ContractDump {
  // name → the commands that alias to it (registry order)
  const aliasTo = new Map<string, string[]>()
  for (const p of plugins) {
    if (p.aliasOf === undefined) {
      continue
    }
    const target = p.aliasOf.split(' ')[0]!
    aliasTo.set(target, [...(aliasTo.get(target) ?? []), p.name])
  }
  const commands: Record<string, ContractCommandRow> = {}
  const groups: ContractDump['groups'] = {}
  // declared group order first, then groups only external plugins add
  const groupOrder = [
    ...groupMeta.map(([g]) => g),
    ...plugins
      .map((p) => p.group)
      .filter((g): g is string => g !== undefined && !groupMeta.some(([m]) => m === g)),
  ]
  for (const g of groupOrder) {
    groups[g] = {
      summary: groupMeta.find(([m]) => m === g)?.[1],
      members: [],
    }
  }
  for (const p of plugins) {
    commands[p.name] = {
      name: p.name,
      group: p.group,
      summary: p.summary,
      spellings: spellings(p),
      aliases: aliasTo.get(p.name) ?? [],
      aliasOf: p.aliasOf,
      deprecated: p.deprecated,
      flatDeprecated: p.flatDeprecated,
      hidden: p.hidden === true,
      skill: p.skill,
      configKey: p.configKey,
      plan: p.planSchema !== undefined,
      planVersion: p.planSchema !== undefined ? (p.planVersion ?? 1) : undefined,
      contract: p.contract,
      external: p.external === true,
    }
    if (p.group !== undefined) {
      groups[p.group]!.members.push(p.name)
    }
  }
  return { version: CONTRACT_VERSION, groups, commands }
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

/** `- <path> — reason` bullets → the announced path set. A trailing
 *  colon on the token is punctuation, not part of the path. */
export function parseBreaking(md: string): Set<string> {
  const out = new Set<string>()
  for (const line of md.split('\n')) {
    const m = /^\s*[-*]\s+(\S+)/.exec(line)
    if (m !== null) {
      out.add(m[1]!.replace(/:$/, ''))
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

/** Keys present in a committed map but absent live are removals; a key
 *  surviving in both descends when the values are sub-contracts. */
function diffMap(
  prefix: string,
  committed: Record<string, unknown> | undefined,
  live: Record<string, unknown> | undefined,
  out: Removal[],
  descend?: (key: string, c: CliSubContract, l: CliSubContract) => void
): void {
  if (committed === undefined) {
    return
  }
  if (live === undefined) {
    out.push({ path: prefix, value: committed })
    return
  }
  for (const [k, cv] of Object.entries(committed)) {
    const lv = live[k]
    if (lv === undefined) {
      out.push({ path: `${prefix}.${k}`, value: cv })
    } else {
      descend?.(k, cv as CliSubContract, lv as CliSubContract)
    }
  }
}

/** Removals inside one contract level — the bare command and each sub
 *  share the flags/exits/json shape. */
function diffSub(
  prefix: string,
  committed: CliSubContract,
  live: CliSubContract,
  out: Removal[]
): void {
  diffMap(`${prefix}.flags`, committed.flags, live.flags, out)
  diffMap(`${prefix}.exits`, committed.exits, live.exits, out)
  if (committed.json !== undefined && live.json === undefined) {
    out.push({ path: `${prefix}.json`, value: committed.json })
  }
}

function diffContract(
  name: string,
  committed: CliContract | undefined,
  live: CliContract | undefined,
  out: Removal[]
): void {
  if (committed === undefined) {
    return
  }
  if (live === undefined) {
    out.push({ path: `${name}.contract`, value: committed })
    return
  }
  diffSub(name, committed, live, out)
  diffMap(`${name}.subs`, committed.subs, live.subs, out, (sub, c, l) =>
    diffSub(`${name}.subs.${sub}`, c, l, out)
  )
}

/** Paths present in the committed doc whose removal changes the
 *  invocation surface — commands, groups, invocation-spelling scalars
 *  (group/aliasOf), and every declared contract leaf. */
function removals(committed: ContractDoc, live: ContractDump): Removal[] {
  const out: Removal[] = []
  for (const [g, v] of Object.entries(committed.groups)) {
    if (live.groups[g] === undefined) {
      out.push({ path: `groups.${g}`, value: v })
    }
  }
  for (const [name, c] of Object.entries(committed.commands)) {
    const l = live.commands[name]
    if (l === undefined) {
      out.push({ path: name, value: c })
      continue
    }
    // a group change kills the `bro <old-group> <name>` spelling; a
    // group ADDED to a formerly top-level command only adds one
    if (c.group !== l.group && c.group !== undefined) {
      out.push({ path: `${name}.group`, value: c.group })
    }
    // any aliasOf difference reroutes `bro <name>` — becoming an alias
    // and ceasing to be one both rewrite what the spelling does
    if (c.aliasOf !== l.aliasOf) {
      out.push({ path: `${name}.aliasOf`, value: c.aliasOf })
    }
    diffContract(name, c.contract, l.contract, out)
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
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  for (const [g, v] of Object.entries(doc.groups)) {
    const c = committed.groups[g]
    if (c === undefined) {
      out.push(`groups.${g} (added)`)
    } else if (!eq(c, v)) {
      out.push(`groups.${g}`)
    }
  }
  for (const [name, v] of Object.entries(doc.commands)) {
    const c = committed.commands[name]
    if (c === undefined) {
      out.push(`${name} (added)`)
    } else if (!eq(c, v)) {
      out.push(name)
    }
  }
  if (!eq(committed.removed ?? {}, doc.removed)) {
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
  const removed: Record<string, unknown> = { ...(committed.removed ?? {}) }
  for (const r of removals(committed, live)) {
    if (!covered(r.path, announced)) {
      problems.push({
        kind: 'breaking',
        path: r.path,
        message: 'surface removed or respelled — announce it in contract/BREAKING.md',
      })
      continue
    }
    removed[r.path] = r.value
  }
  for (const k of Object.keys(removed)) {
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
    removed,
  }
  for (const path of stalePaths(committed, doc)) {
    problems.push({ kind: 'stale', path, message: 'run `npm run gen:contract`' })
  }
  return { doc, problems }
}

// --- the command -------------------------------------------------------------

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(
      `contract: ${path} — ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(2)
  }
}

function printTable(dump: ContractDump): void {
  for (const c of Object.values(dump.commands)) {
    const flags = Object.keys(c.contract?.flags ?? {}).length +
      Object.values(c.contract?.subs ?? {}).reduce(
        (n, s) => n + Object.keys(s.flags ?? {}).length,
        0
      )
    console.log(
      `${c.name.padEnd(12)} ${(c.group ?? '-').padEnd(8)} ${(c.skill ?? '-').padEnd(10)} ` +
        `${(c.aliasOf !== undefined ? `→ ${c.aliasOf}` : c.hidden ? 'hidden' : String(flags)).padEnd(10)} ${c.summary}`
    )
  }
}

function reportProblems(problems: ContractProblem[]): void {
  for (const p of problems) {
    console.error(`  ${p.kind.padEnd(8)} ${p.path} — ${p.message}`)
  }
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
    const contractPath = flag(rest, '--contract') ?? 'contract/cli.json'
    const breakingPath = flag(rest, '--breaking') ?? 'contract/BREAKING.md'
    const dumpPath = flag(rest, '--dump')
    const live =
      dumpPath !== undefined
        ? (readJsonFile(dumpPath) as ContractDump)
        : buildDump(plugins, groupMeta)
    const committed: ContractDoc = existsSync(contractPath)
      ? (readJsonFile(contractPath) as ContractDoc)
      : { version: CONTRACT_VERSION, groups: {}, commands: {}, removed: {} }
    const announced = parseBreaking(
      existsSync(breakingPath) ? readFileSync(breakingPath, 'utf8') : ''
    )
    const { doc, problems } = reconcileContract(committed, live, announced)
    if (sub === 'gen') {
      const fatal = problems.filter((p) => p.kind !== 'stale')
      if (fatal.length > 0) {
        console.error(`contract: refusing to regenerate — ${fatal.length} unannounced breaking change(s)`)
        reportProblems(fatal)
        process.exit(1)
      }
      mkdirSync(dirname(contractPath), { recursive: true })
      writeFileSync(contractPath, `${JSON.stringify(doc, null, 2)}\n`)
      console.log(
        `${contractPath}: regenerated — ${Object.keys(doc.commands).length} commands, ${Object.keys(doc.removed).length} tombstone(s)`
      )
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
  console.error(
    'usage: bro contract dump [--json] | check [--contract f] [--dump f] [--breaking f] | gen [same flags]'
  )
  process.exit(2)
}

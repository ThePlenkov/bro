/**
 * `bro convoy <sub>` — agent-internal execution over beads molecules.
 * bd owns the DAG (formula → pour → molecule); bro owns scheduling:
 * `next` emits the next executable step, `done` closes it, `status`
 * renders the DAG. All state lives in beads — a convoy survives
 * session restarts and compaction by construction.
 *
 *   status [mol]              DAG: every step as done/ready/blocked
 *   next [mol]                next executable step (JSON) — or gate/complete/blocked
 *   done <step> [--result T]  close a step, then emit the new `next`
 *   pour <formula> [--var K=V]…  register agent/human types, bd mol pour
 *   list                      open molecules in this workspace
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'smol-toml'
import { bd, checkBeads } from '@bro/core'
import {
  beadsDir,
  claimStep,
  declAsIssue,
  formulaSteps,
  inlineFormulaDoc,
  listMolecules,
  loadMolecule,
  nextStep,
  pourFormula,
  resolveMolecule,
  stepInputs,
  stepKind,
  stepsOf,
} from '@bro/convoy'
import type {
  ConvoyInline,
  ConvoyMolecule,
  ConvoyNext,
  ConvoyPlan,
  MolIssue,
  StepState,
} from '@bro/convoy'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro convoy <command> [args…]

Commands:
  status [mol] [--mol ID]         Render the DAG — done/ready/blocked per step
  next [mol] [--mol ID]           Emit the next executable step as JSON
  done <step-id> [--result TEXT] [--mol ID]  Close a step and emit the new next
  claim <step-id> [--mol ID]               Atomically claim a step (assignee + in_progress)
  pour <formula> [--var K=V]…     Pour a formula into a molecule (registers agent/human types)
  list                            Open molecules in this workspace

  With no mol id, the single open molecule is used; ambiguity is an error.`)
  process.exit(exitCode)
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--result', '--var', '--mol'])

const convoyPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

const GLYPH: Record<StepState, string> = { done: '✓', ready: '▸', blocked: '·', in_progress: '◐' }

/** Attach the upstream handoff — closed direct deps' close reasons. */
function withInputs(next: ConvoyNext, mol: Parameters<typeof stepInputs>[0]): ConvoyNext {
  if (!next.step) return next
  const inputs = stepInputs(mol, next.step.id)
  return inputs.length > 0 ? { ...next, inputs } : next
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 40) || 'convoy'

/** A molecule that forbids gates must not contain any — formulas are
 *  inspected pre-pour, inline steps were already checked at parse time
 *  but a direct caller can bypass the schema. */
function assertGateFree(m: ConvoyMolecule): void {
  const declared: MolIssue[] =
    'formula' in m ? formulaSteps(m.formula) : m.steps.map(declAsIssue)
  const gated = declared.filter((s) => stepKind(s) === 'human')
  if (gated.length > 0) {
    const name = 'formula' in m ? m.formula : m.title
    throw new Error(
      `molecule "${name}" declares human gates (${gated.map((s) => s.id).join(', ')}) but gates = "forbid"`
    )
  }
}

/** An inline molecule pours through a generated formula file in the
 *  resolved beads dir — the only path where declared agent/human types
 *  survive (`bd create` flattens them to task). The file is a pour-time
 *  artifact: removed as soon as the molecule exists. */
function pourInline(m: ConvoyInline): string {
  const name = `bro-plan-${slugify(m.title)}-${randomBytes(3).toString('hex')}`
  const dir = join(beadsDir(), 'formulas')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.formula.toml`)
  writeFileSync(file, stringify(inlineFormulaDoc(m, name)))
  try {
    const rootId = pourFormula(name, {})
    // bd titles the root after the formula name — restore the plan's title
    bd(['update', rootId, '--title', m.title])
    return rootId
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Materialize a convoy plan (`bro run convoy.toml`): pour each declared
 * molecule — registered formulas via `bd mol pour`, inline step lists via
 * a generated formula. Execution then proceeds through
 * `convoy next`/`done` as usual.
 */
export function applyConvoyPlan(plan: ConvoyPlan): void {
  checkBeads()
  // preflight every gate policy before pouring anything — a late
  // "forbid" failure must not leave earlier molecules poured
  for (const m of plan.molecules) {
    if ((m.gates ?? plan.gates ?? 'allow') === 'forbid') {
      assertGateFree(m)
    }
  }
  const poured: string[] = []
  try {
    for (const m of plan.molecules) {
      const rootId = 'formula' in m ? pourFormula(m.formula, m.vars ?? {}) : pourInline(m)
      poured.push(rootId)
      console.log(`convoy ↓ ${rootId} ${'formula' in m ? m.formula : m.title}`)
    }
  } catch (err) {
    // bd has no transactions — a mid-flight failure deletes the molecules
    // this run poured (the applyDrillPlan convention): a retry converges
    // instead of leaving half the plan materialized
    const orphans = rollbackPoured(poured)
    if (orphans.length === 0) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${msg} — cleanup incomplete: molecule(s) left behind: ${orphans.join(', ')}`,
      { cause: err }
    )
  }
}

/** Delete the molecules this run poured, newest first — steps before
 *  their root since bd refuses a root with open children. Returns the
 *  root ids whose cleanup failed. */
function rollbackPoured(poured: string[]): string[] {
  const orphans: string[] = []
  for (const rootId of [...poured].reverse()) {
    try {
      for (const s of stepsOf(loadMolecule(rootId))) bd(['delete', s.id, '--force'])
      bd(['delete', rootId, '--force'])
    } catch {
      orphans.push(rootId)
    }
  }
  return orphans
}

export async function runConvoyCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') usage()
  const SUBS = new Set(['list', 'status', 'next', 'done', 'claim', 'pour'])
  if (!SUBS.has(sub)) {
    console.error(`unknown convoy command: ${sub}`)
    usage()
  }
  // reject unknown options — a misspelled flag (e.g. --reslut) must not
  // silently degrade a `done` into a close with no reason
  const KNOWN_FLAGS = new Set([...VALUE_FLAGS])
  for (const a of rest) {
    if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
      console.error(`error: unknown option ${a}`)
      process.exit(2)
    }
  }
  checkBeads()

  switch (sub) {
    case 'list': {
      const mols = listMolecules()
      if (mols.length === 0) {
        console.log('no open molecules')
        return
      }
      for (const m of mols) console.log(`${m.id}\t${m.title}`)
      return
    }
    case 'status': {
      const [id] = convoyPositionals(rest)
      const mol = resolveMolecule(id ?? flag(rest, '--mol'))
      const steps = stepsOf(mol)
      console.log(`${mol.root.id} ${mol.root.title}`)
      for (const s of steps) {
        const wait = s.blockedBy.length > 0 ? `  ⟵ ${s.blockedBy.join(', ')}` : ''
        const gate = s.kind === 'human' && s.state !== 'done' ? ' [human gate]' : ''
        const claimed = s.state === 'in_progress' ? ' [in progress]' : ''
        console.log(`  ${GLYPH[s.state]} ${s.id}  ${s.title}${gate}${claimed}${wait}`)
      }
      return
    }
    case 'next': {
      const [id] = convoyPositionals(rest)
      const mol = resolveMolecule(id ?? flag(rest, '--mol'))
      console.log(JSON.stringify(withInputs(nextStep(mol), mol), null, 2))
      return
    }
    case 'done': {
      const [stepId] = convoyPositionals(rest)
      if (!stepId) {
        console.error('error: done requires a step id')
        process.exit(2)
      }
      // membership check before mutation — a mistyped/copied id must not
      // close an unrelated issue
      const mol = resolveMolecule(flag(rest, '--mol'))
      const step = stepsOf(mol).find((s) => s.id === stepId)
      if (!step) {
        console.error(`error: ${stepId} is not a step of molecule ${mol.root.id}`)
        process.exit(2)
      }
      // dependency order is the contract — a blocked step can't be done;
      // ready or claimed (in_progress) steps can
      if (step.state !== 'ready' && step.state !== 'in_progress') {
        console.error(
          `error: ${stepId} is ${step.state} — only ready or claimed steps can be done` +
            (step.blockedBy.length > 0 ? ` (waiting on ${step.blockedBy.join(', ')})` : ''),
        )
        process.exit(2)
      }
      const result = flag(rest, '--result')
      // the handoff is the contract — close_reason is what downstream
      // steps read via inputs[]
      if (!result) {
        console.error('error: done requires --result — the next steps read it as their input')
        process.exit(2)
      }
      bd(['close', stepId, '--reason', result])
      const fresh = resolveMolecule(mol.root.id)
      console.log(JSON.stringify(withInputs(nextStep(fresh), fresh), null, 2))
      return
    }
    case 'claim': {
      const [stepId] = convoyPositionals(rest)
      if (!stepId) {
        console.error('error: claim requires a step id')
        process.exit(2)
      }
      const mol = resolveMolecule(flag(rest, '--mol'))
      const step = stepsOf(mol).find((s) => s.id === stepId)
      if (!step) {
        console.error(`error: ${stepId} is not a step of molecule ${mol.root.id}`)
        process.exit(2)
      }
      if (step.state !== 'ready') {
        console.error(`error: ${stepId} is ${step.state} — only ready steps can be claimed`)
        process.exit(2)
      }
      claimStep(stepId)
      const fresh = resolveMolecule(mol.root.id)
      console.log(JSON.stringify(withInputs(nextStep(fresh), fresh), null, 2))
      return
    }
    case 'pour': {
      const [formula] = convoyPositionals(rest)
      if (!formula) {
        console.error('error: pour requires a formula name')
        process.exit(2)
      }
      const vars: Record<string, string> = {}
      for (const kv of flagAll(rest, '--var')) {
        const eq = kv.indexOf('=')
        if (eq < 1) {
          console.error(`error: --var must be K=V, got "${kv}"`)
          process.exit(2)
        }
        vars[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      const rootId = pourFormula(formula, vars)
      console.log(rootId)
      return
    }
    default:
      usage()
  }
}

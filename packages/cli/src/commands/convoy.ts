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
import { bd, checkBeads } from '@bro/core'
import {
  listMolecules,
  nextStep,
  pourFormula,
  resolveMolecule,
  stepInputs,
  stepsOf,
} from '@bro/convoy'
import type { ConvoyNext, StepState } from '@bro/convoy'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro convoy <command> [args…]

Commands:
  status [mol]                    Render the DAG — done/ready/blocked per step
  next [mol]                      Emit the next executable step as JSON
  done <step-id> [--result TEXT] [--mol ID]  Close a step and emit the new next
  pour <formula> [--var K=V]…     Pour a formula into a molecule (registers agent/human types)
  list                            Open molecules in this workspace

  With no mol id, the single open molecule is used; ambiguity is an error.`)
  process.exit(exitCode)
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--result', '--var', '--mol'])

const convoyPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

const GLYPH: Record<StepState, string> = { done: '✓', ready: '▸', blocked: '·' }

/** Attach the upstream handoff — closed direct deps' close reasons. */
function withInputs(next: ConvoyNext, mol: Parameters<typeof stepInputs>[0]): ConvoyNext {
  if (!next.step) return next
  const inputs = stepInputs(mol, next.step.id)
  return inputs.length > 0 ? { ...next, inputs } : next
}

export async function runConvoyCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') usage()
  const SUBS = new Set(['list', 'status', 'next', 'done', 'pour'])
  if (!SUBS.has(sub)) {
    console.error(`unknown convoy command: ${sub}`)
    usage()
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
      const mol = resolveMolecule(id)
      const steps = stepsOf(mol)
      console.log(`${mol.root.id} ${mol.root.title}`)
      for (const s of steps) {
        const wait = s.blockedBy.length > 0 ? `  ⟵ ${s.blockedBy.join(', ')}` : ''
        const gate = s.kind === 'human' && s.state !== 'done' ? ' [human gate]' : ''
        console.log(`  ${GLYPH[s.state]} ${s.id}  ${s.title}${gate}${wait}`)
      }
      return
    }
    case 'next': {
      const [id] = convoyPositionals(rest)
      const mol = resolveMolecule(id)
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
      if (!stepsOf(mol).some((s) => s.id === stepId)) {
        console.error(`error: ${stepId} is not a step of molecule ${mol.root.id}`)
        process.exit(2)
      }
      const result = flag(rest, '--result')
      bd(['close', stepId, ...(result ? ['--reason', result] : [])])
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

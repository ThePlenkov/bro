/** queue plane — the molecule DAG behind `bro convoy next`. bd's mol
 *  commands are cwd-bound, so this plane serves the repo `bro mcp`
 *  was spawned in (ctx.dir === cwd by command contract). */
import {
  isBdNotFound,
  PlaneUnavailable,
  verbsNotWired,
  type PlaneCtx,
  type PlaneDescriptor,
  type Run,
} from '@broject/core'
import {
  listMolecules,
  loadMolecule,
  nextStep,
  resolveMolecule,
  stepInputs,
  stepsOf,
} from '@broject/convoy'
import type { ConvoyStep, Molecule } from '@broject/convoy'
import { argString, beadsReachable, bounded, dispatchRead, inRepo } from './helpers.ts'

/** A mol whose own read fails is a row in error — never a fake
 *  'blocked' the whole list would have to carry, and never a thrown
 *  list. Covers nextStep() inside molRow and loadMolecule() in list —
 *  a mol that vanishes between listing and loading lands here. */
const molErrorRow = (
  id: string,
  title: string,
  status: string,
  err: unknown
): Run => ({
  id,
  title,
  status,
  state: 'error',
  error: err instanceof Error ? err.message : String(err),
  ready: [],
  gates: [],
  inProgress: [],
  blocked: [],
  stuck: [],
})

const molRow = (mol: Molecule): Run => {
  try {
    const n = nextStep(mol)
    return {
      id: mol.root.id,
      title: mol.root.title,
      status: mol.root.status,
      state: n.state,
      ready: n.ready.map((s: ConvoyStep) => s.id),
      gates: n.gates,
      inProgress: n.inProgress,
      blocked: n.blocked,
      stuck: n.stuck,
    }
  } catch (err) {
    return molErrorRow(mol.root.id, mol.root.title, mol.root.status, err)
  }
}

export function queuePlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro convoy next --json` — the mol's own ConvoyNext plus the
     *  closed-dependency handoff (inputs), verbatim. */
    next: (a) => {
      const mol = resolveMolecule(argString(a, 'mol'))
      const n = nextStep(mol)
      return n.step === undefined ? n : { ...n, inputs: stepInputs(mol, n.step.id) }
    },
  }
  return {
    name: 'queue',
    reads: Object.keys(reads),
    verbs: ['pour', 'claim', 'done'],
    readArgs: {
      list: {
        type: 'object',
        properties: { limit: { type: 'integer' } },
      },
      next: {
        type: 'object',
        properties: { mol: { type: 'string', description: 'molecule id; default: the single open mol' } },
      },
    },
    capabilities: async () => ({
      read: inRepo(dir) && (await bounded(beadsReachable(dir), 10_000, false)),
      pour: false, // write verbs are declared, not exposed (v1)
      claim: false,
      done: false,
    }),
    list: async (f) => {
      if (!inRepo(dir)) {
        throw new PlaneUnavailable('queue', 'not a git repo')
      }
      let mols
      try {
        mols = listMolecules()
      } catch (err) {
        throw new PlaneUnavailable('queue', err instanceof Error ? err.message : String(err))
      }
      const rows = mols.map((m) => {
        try {
          return molRow(loadMolecule(m.id))
        } catch (err) {
          return molErrorRow(m.id, m.title, m.status, err)
        }
      })
      const limit = typeof f?.limit === 'number' ? f.limit : undefined
      return limit === undefined ? rows : rows.slice(0, limit)
    },
    get: async (ref) => {
      if (!inRepo(dir)) {
        throw new PlaneUnavailable('queue', 'not a git repo')
      }
      let mol: Molecule
      try {
        mol = loadMolecule(ref)
      } catch (err) {
        if (isBdNotFound(err)) {
          return undefined
        }
        throw new PlaneUnavailable('queue', err instanceof Error ? err.message : String(err))
      }
      const row = molRow(mol)
      const n = nextStep(mol)
      return {
        ...row,
        steps: stepsOf(mol),
        inputs: n.step === undefined ? undefined : stepInputs(mol, n.step.id),
      }
    },
    read: (name, args) => dispatchRead('queue', reads, name, args),
    exec: verbsNotWired('queue', ['pour', 'claim', 'done']),
  }
}

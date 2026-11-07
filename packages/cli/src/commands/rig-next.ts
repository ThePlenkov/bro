import type { BeadStore } from '@broject/core'
import { rigNext, type RigNext } from '@broject/rig'

// Re-export the engine symbols so consumers (drive.ts, etc.) that
// historically imported them from this adapter keep resolving.
export { rigNext, type RigNext }

export async function runRigNext(
  dir: string = process.cwd(),
  item?: string | { json?: boolean; cwd?: string; dir?: string; store?: BeadStore },
  json?: boolean
): Promise<number> {
  let resolvedDir = dir
  let resolvedItem: string | undefined
  let resolvedJson = json ?? false
  let store: BeadStore | undefined
  if (typeof item === 'object' && item !== null) {
    resolvedDir = item.dir ?? item.cwd ?? dir
    resolvedJson = item.json ?? resolvedJson
    store = item.store
    resolvedItem = undefined
  } else {
    resolvedItem = item
  }

  const verdict = rigNext(resolvedDir, resolvedItem, { store })
  if (resolvedJson) {
    console.log(JSON.stringify(verdict, null, 2))
    return exitCode(verdict)
  }
  // keep byte-identical to the pre-extraction CLI output
  console.log(formatVerdict(verdict))
  return exitCode(verdict)
}

function formatVerdict(v: RigNext): string {
  const verdict = v.verdict
  const id = v.id
  const detail = v.detail
  let line = `rig next: ${verdict}`
  if (id !== undefined) {
    line += ` ${id}`
  }
  if (detail !== undefined) {
    line += ` — ${detail}`
  }
  return line
}

function exitCode(v: RigNext): number {
  if (v.verdict === 'blocked') return 1
  return 0
}

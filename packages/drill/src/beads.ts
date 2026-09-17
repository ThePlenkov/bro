/**
 * beads readiness for drill frames. The `bd` launcher itself lives in
 * @bro/core — PATH lookup is the contract (same as gh).
 */
import { bd } from '@bro/core'

export { bd, bdJson } from '@bro/core'

export function checkBeads(): void {
  try {
    bd(['--version'])
  } catch {
    throw new Error('bd not found — install beads first (https://github.com/gastownhall/beads)')
  }
  try {
    bd(['list', '--json', '-n', '1'])
  } catch (err) {
    // preserve the real failure — "not initialized" is only one cause
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new Error(
      `bd list failed — ${stderr || (err instanceof Error ? err.message : String(err))} ` +
        '(run `bd init` if beads is not initialized here)'
    )
  }
}

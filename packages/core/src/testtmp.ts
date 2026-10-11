/** Test-only fixture dirs under a per-process sweep: every dir made
 *  via tmpDir() is deleted when the test process exits, pass or fail.
 *  Not exported from index.ts — unreachable from the package entry, it
 *  never lands in dist. Fixture sites that already rm in a finally
 *  don't need this; bare mkdtemp sites do (bro-7qrdp). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pending: string[] = []
let armed = false

export function tmpDir(prefix: string): string {
  if (!armed) {
    armed = true
    process.once('exit', () => {
      for (const d of pending) rmSync(d, { recursive: true, force: true })
    })
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  pending.push(dir)
  return dir
}

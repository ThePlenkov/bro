/** Test-only fixture dirs under a per-process sweep: every dir made
 *  via tmpDir() is deleted when the test process exits, pass or fail.
 *  Reachable from the package entry through testkit (which re-exports
 *  scrubEnv and calls tmpDir), so it does ship in dist alongside the
 *  test seam — keep it dependency-free and side-effect-light. Fixture
 *  sites that already rm in a finally don't need this; bare mkdtemp
 *  sites do (bro-7qrdp). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pending: string[] = [];
let armed = false;

export function tmpDir(prefix: string): string {
  if (!armed) {
    armed = true;
    process.once('exit', () => {
      for (const d of pending) rmSync(d, { recursive: true, force: true });
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pending.push(dir);
  return dir;
}

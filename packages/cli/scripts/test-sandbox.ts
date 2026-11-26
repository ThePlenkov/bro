import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestSandbox {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * Keep a test worker's temporary files below one disposable directory.
 * A test process can be interrupted while a fixture is being torn down;
 * removing this root after the worker exits makes that failure mode
 * harmless instead of leaving bro-* directories in the host /tmp.
 */
export function createTestSandbox(baseEnv: NodeJS.ProcessEnv = process.env): TestSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'bro-test-run-'));
  let cleaned = false;
  return {
    dir,
    env: {
      ...baseEnv,
      TMPDIR: dir,
      TMP: dir,
      TEMP: dir,
    },
    cleanup(): void {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

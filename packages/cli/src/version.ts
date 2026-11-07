import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth is package.json — this module sits at src/
// root, so `../package.json` resolves in the workspace AND inside the
// bundled dist/index.js (one dir below package.json in the tarball).
// A commands/* module cannot use this path — its own ../ is src/.
export const VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
  ) as { version: string }
).version

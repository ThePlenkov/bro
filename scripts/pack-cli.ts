// packages/cli pack helper — runs from packages/cli cwd on `npm pack`/`publish`.
// pre: copies README+LICENSE into the tarball and strips workspace-only
//      @broject/* devDeps — tsdown bundles them into dist, and published
//      metadata must not reference packages npm cannot resolve.
// post: restores package.json verbatim and removes the staged files.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const STASH = '.pack-stash.json'
const EXTRAS = ['README.md', 'LICENSE']

if (process.argv[2] === 'pre') {
  for (const f of EXTRAS) copyFileSync(`../../${f}`, f)
  const orig = readFileSync('package.json', 'utf8')
  const pkg = JSON.parse(orig)
  for (const k of Object.keys(pkg.devDependencies ?? {})) {
    if (k.startsWith('@broject/')) delete pkg.devDependencies[k]
  }
  writeFileSync(STASH, orig)
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
} else {
  for (const f of EXTRAS) rmSync(f, { force: true })
  if (existsSync(STASH)) {
    writeFileSync('package.json', readFileSync(STASH))
    rmSync(STASH)
  }
}

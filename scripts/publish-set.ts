// publish.yml package set — every non-private @broject/* under packages/,
// topo-sorted by internal deps so a consumer never resolves a dep that
// isn't on the registry yet. `private: true` marks bundled-only internals
// (mesh, query): versioned by `nx release` but shipped inside @broject/bro,
// never standalone — flip the flag to enrol a package in publishing.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkgs = new Map() // dir -> { name, deps: Set<@broject/* names> }
for (const dir of readdirSync(join(root, 'packages'))) {
  let p
  try {
    p = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
  } catch {
    continue // not a package dir — stray file or missing package.json
  }
  if (!p.name?.startsWith('@broject/') || p.private) continue
  pkgs.set(dir, {
    name: p.name,
    deps: new Set(Object.keys(p.dependencies ?? {}).filter((d) => d.startsWith('@broject/'))),
  })
}
const dirOf = new Map([...pkgs.entries()].map(([d, p]) => [p.name, d]))

// Kahn — alphabetical among ready nodes keeps the output deterministic
const pending = new Map([...pkgs.keys()].map((d) => [d, 0]))
const dependents = new Map()
for (const [dir, p] of pkgs) {
  for (const dep of p.deps) {
    const depDir = dirOf.get(dep)
    if (!depDir) continue // dep on a private/bundled package — no publish order
    pending.set(dir, pending.get(dir) + 1)
    dependents.set(depDir, [...(dependents.get(depDir) ?? []), dir])
  }
}
const ready = [...pkgs.keys()]
  .filter((d) => pending.get(d) === 0)
  .sort((a, b) => a.localeCompare(b))
const order = []
while (ready.length) {
  const dir = ready.shift()
  order.push(dir)
  for (const next of dependents.get(dir) ?? []) {
    const left = pending.get(next) - 1
    pending.set(next, left)
    if (left === 0) {
      ready.push(next)
      ready.sort((a, b) => a.localeCompare(b))
    }
  }
}
if (order.length !== pkgs.size) {
  console.error(`publish-set: @broject/* dep cycle — ordered ${order.length}/${pkgs.size}`)
  process.exit(1)
}
console.log(order.join(' '))

/**
 * gen-plugins — materialize per-client plugin adapters under plugins/.
 *
 * The repo root is the canonical Devin plugin (plugin.json + hooks.json +
 * skills/). `plugins/<client>/bro/` are self-contained copies a client can
 * install standalone — remote installs can't follow links outside their
 * checkout, so content is copied, not referenced.
 *
 *   plugins/devin/bro/   plugin.json + hooks.json copied from root
 *   plugins/claude/bro/  .claude-plugin/plugin.json derived from plugin.json
 *                        + hand-written hooks/hooks.json (Claude event names)
 *   plugins/codex/bro/   .codex-plugin/plugin.json derived from plugin.json
 *
 * Every adapter gets skills/ and hooks/run.sh. Only the Claude hooks wiring
 * is authored by hand — everything else is generated, so `check:plugins`
 * fails CI when an adapter drifts from its source.
 *
 *   node scripts/gen-plugins.mjs           # write
 *   node scripts/gen-plugins.mjs --check   # verify freshness, exit 1 on drift
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')

const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'))

/** Claude/Codex manifests reuse the agent-plugins fields minus $schema. */
function clientManifest(extra = {}) {
  const { $schema: _drop, ...fields } = manifest
  return `${JSON.stringify({ ...fields, ...extra }, null, 2)}\n`
}

// files written per adapter — value is source path, or [text] literal content
const ADAPTERS = {
  'plugins/devin/bro': {
    'plugin.json': 'plugin.json',
    'hooks.json': 'hooks.json',
  },
  'plugins/claude/bro': {
    '.claude-plugin/plugin.json': [clientManifest()],
    // hand-written (Claude event names) — listed so --check doesn't flag it
    'hooks/hooks.json': null,
  },
  'plugins/codex/bro': {
    '.codex-plugin/plugin.json': [
      clientManifest({ interface: { displayName: 'bro' } }),
    ],
  },
}

// the npx fallback pin always equals plugin.json's version — rewrite it in
// the hook sources so a version bump can't leave a stale pin behind
const VERSIONED_SOURCES = [
  'hooks.json',
  'hooks/run.sh',
  'plugins/claude/bro/hooks/hooks.json',
]
const PIN_RE = /@theplenkov\/bro@[\w.:-]+/g

const drift = []

function emit(path, content) {
  if (CHECK) {
    if (!existsSync(join(ROOT, path)) || readFileSync(join(ROOT, path), 'utf8') !== content) {
      drift.push(path)
    }
    return
  }
  mkdirSync(dirname(join(ROOT, path)), { recursive: true })
  writeFileSync(join(ROOT, path), content)
}

// keep every `@theplenkov/bro@…` npx pin equal to plugin.json's version
for (const src of VERSIONED_SOURCES) {
  const p = join(ROOT, src)
  if (!existsSync(p)) {
    drift.push(src)
    continue
  }
  const text = readFileSync(p, 'utf8')
  const synced = text.replace(PIN_RE, `@theplenkov/bro@${manifest.version}`)
  if (CHECK ? synced !== text : false) {
    drift.push(src)
  } else if (!CHECK && synced !== text) {
    writeFileSync(p, synced)
  }
}

for (const [dir, files] of Object.entries(ADAPTERS)) {
  // expected file set: declared entries + skills/ + hooks/run.sh —
  // anything else on disk under the adapter is stale generated content
  const expected = new Set(Object.keys(files).map((rel) => `${dir}/${rel}`))
  for (const [rel, src] of Object.entries(files)) {
    if (src === null) {
      if (!existsSync(join(ROOT, `${dir}/${rel}`))) {
        drift.push(`${dir}/${rel}`)
      }
      continue
    }
    emit(
      `${dir}/${rel}`,
      Array.isArray(src) ? src[0] : readFileSync(join(ROOT, src), 'utf8')
    )
  }
  const skillsOut = `${dir}/skills`
  const runShOut = `${dir}/hooks/run.sh`
  for (const f of walk(join(ROOT, 'skills'))) {
    expected.add(`${skillsOut}/${f}`)
  }
  expected.add(runShOut)
  if (CHECK) {
    for (const f of walk(join(ROOT, 'skills'))) {
      const rel = `${skillsOut}/${f}`
      const want = readFileSync(join(ROOT, 'skills', f), 'utf8')
      if (!existsSync(join(ROOT, rel)) || readFileSync(join(ROOT, rel), 'utf8') !== want) {
        drift.push(rel)
      }
    }
    const wantSh = readFileSync(join(ROOT, 'hooks/run.sh'), 'utf8')
    if (!existsSync(join(ROOT, runShOut)) || readFileSync(join(ROOT, runShOut), 'utf8') !== wantSh) {
      drift.push(runShOut)
    }
    // stale leftovers — files on disk that generation no longer produces
    if (existsSync(join(ROOT, dir))) {
      for (const f of walk(join(ROOT, dir))) {
        if (!expected.has(`${dir}/${f}`)) {
          drift.push(`${dir}/${f}`)
        }
      }
    }
  } else {
    rmSync(join(ROOT, skillsOut), { recursive: true, force: true })
    cpSync(join(ROOT, 'skills'), join(ROOT, skillsOut), { recursive: true })
    mkdirSync(join(ROOT, `${dir}/hooks`), { recursive: true })
    cpSync(join(ROOT, 'hooks/run.sh'), join(ROOT, runShOut))
  }
}

function* walk(dir, prefix = '') {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const rel = prefix ? `${prefix}/${e}` : e
    if (statSync(p).isDirectory()) {
      yield* walk(p, rel)
    } else {
      yield rel
    }
  }
}

if (CHECK && drift.length > 0) {
  console.error(`plugin adapters out of date — run \`npm run gen:plugins\`:\n  ${drift.join('\n  ')}`)
  process.exit(1)
}
console.log(CHECK ? 'plugin adapters fresh' : 'plugin adapters generated')

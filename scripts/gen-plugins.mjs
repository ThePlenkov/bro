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
  },
  'plugins/codex/bro': {
    '.codex-plugin/plugin.json': [
      clientManifest({ interface: { displayName: 'bro' } }),
    ],
  },
}

const drift = []
const seen = new Set()

function emit(path, content) {
  seen.add(path)
  if (CHECK) {
    if (!existsSync(join(ROOT, path)) || readFileSync(join(ROOT, path), 'utf8') !== content) {
      drift.push(path)
    }
    return
  }
  mkdirSync(dirname(join(ROOT, path)), { recursive: true })
  writeFileSync(join(ROOT, path), content)
}

for (const [dir, files] of Object.entries(ADAPTERS)) {
  for (const [rel, src] of Object.entries(files)) {
    emit(
      `${dir}/${rel}`,
      Array.isArray(src) ? src[0] : readFileSync(join(ROOT, src), 'utf8')
    )
  }
  // shared payload — identical in every adapter
  const skillsOut = `${dir}/skills`
  const runShOut = `${dir}/hooks/run.sh`
  if (CHECK) {
    // dir copies are checked file-by-file
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

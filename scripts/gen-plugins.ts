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
 *   node scripts/gen-plugins.ts           # write
 *   node scripts/gen-plugins.ts --check   # verify freshness, exit 1 on drift
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')
const SYNC_VERSION = process.argv.includes('--sync-version')
if (SYNC_VERSION && CHECK) {
  console.error('--sync-version writes files — cannot combine with --check')
  process.exit(1)
}

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  } catch (err) {
    console.error(
      `${rel}: failed to read or parse — ${err instanceof Error ? err.message : err}`
    )
    process.exit(1)
  }
}

// the published CLI version is the release truth — every manifest must match
const cliVersion = readJson('packages/cli/package.json').version

// release bumps packages/*/package.json only; --sync-version stamps that
// version into every hand-maintained manifest BEFORE the equality checks,
// so a release PR can't fail check:plugins on a stale version field
const MARKETPLACES = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
]
if (SYNC_VERSION) {
  // surgical replace — reserializing churns unrelated formatting
  for (const f of ['plugin.json', ...MARKETPLACES]) {
    const p = join(ROOT, f)
    const text = readFileSync(p, 'utf8')
    const synced = text.replace(
      /"version":\s*"[^"]+"/g,
      () => `"version": "${cliVersion}"`
    )
    if (synced !== text) {
      writeFileSync(p, synced)
    }
  }
}

const manifest = readJson('plugin.json')
// null/array/index signature all index cleanly per-field — only a plain
// object may reach the field checks below
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  console.error('plugin.json: top-level value must be an object')
  process.exit(1)
}

// agent-plugins 1.0 shape — hand-rolled check (no ajv dep): a malformed
// manifest currently only fails at `devin plugins install` time
const REQUIRED_STRING_FIELDS = ['name', 'version', 'description']
const KNOWN_TOP_LEVEL = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords',
])
for (const f of REQUIRED_STRING_FIELDS) {
  if (typeof manifest[f] !== 'string' || manifest[f].trim() === '') {
    console.error(`plugin.json: "${f}" must be a non-empty string`)
    process.exit(1)
  }
}
for (const k of Object.keys(manifest)) {
  if (!KNOWN_TOP_LEVEL.has(k)) {
    // warn only — the spec can add fields; typos surface here too
    console.error(`plugin.json: warning — unknown top-level field "${k}"`)
  }
}
// trim guard first — JS $ matches before a trailing \n, so "bro\n" would
// pass the pattern alone; surrounding whitespace is never a valid slug
if (
  manifest.name !== manifest.name.trim() ||
  !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(manifest.name)
) {
  console.error(`plugin.json: name "${manifest.name}" is not a valid plugin slug`)
  process.exit(1)
}
// semver.org rules — one monolithic regex trips complexity gates, so
// split: numeric fields forbid leading zeros; prerelease/build are
// dot-separated identifiers (prerelease ids can't be all-digit-with-zero)
const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SEMVER_PRE_ID = /^(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)$/
const SEMVER_BUILD_ID = /^[0-9a-zA-Z-]+$/
function isSemver(v) {
  const [head, build, ...extra] = v.split('+')
  if (
    extra.length > 0 ||
    (build !== undefined && !build.split('.').every((s) => SEMVER_BUILD_ID.test(s)))
  ) {
    return false
  }
  const dash = head.indexOf('-')
  const core = dash === -1 ? head : head.slice(0, dash)
  const pre = dash === -1 ? undefined : head.slice(dash + 1)
  return (
    SEMVER_CORE.test(core) &&
    (pre === undefined || pre.split('.').every((s) => SEMVER_PRE_ID.test(s)))
  )
}
if (!isSemver(manifest.version)) {
  console.error(`plugin.json: version "${manifest.version}" is not semver`)
  process.exit(1)
}
if (manifest.version !== cliVersion) {
  console.error(
    `plugin.json: version ${manifest.version} != packages/cli version ${cliVersion}`
  )
  process.exit(1)
}
for (const m of MARKETPLACES) {
  for (const p of readJson(m).plugins ?? []) {
    if (p.version !== cliVersion) {
      console.error(`${m}: plugin "${p.name}" version ${p.version} != packages/cli version ${cliVersion}`)
      process.exit(1)
    }
  }
}

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
  const p = join(ROOT, path)
  // lstat, not exists/stat: a stale directory or symlink where a file is
  // expected must be REPLACED — readFileSync would crash on the dir and
  // writeFileSync would write through the link to an external target
  let st
  try {
    st = lstatSync(p)
  } catch {
    st = undefined
  }
  const stale = st !== undefined && (st.isDirectory() || st.isSymbolicLink())
  if (CHECK) {
    if (st === undefined || stale || readFileSync(p, 'utf8') !== content) {
      drift.push(path)
    }
    return
  }
  if (stale) {
    rmSync(p, { recursive: true, force: true })
  }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
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
      // hand-written source — generation can't create it, so its absence
      // is an error in write mode too, not just check drift
      if (!existsSync(join(ROOT, `${dir}/${rel}`))) {
        if (!CHECK) {
          console.error(`required hand-written file missing: ${dir}/${rel}`)
          process.exit(1)
        }
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
  // the adapter dir itself may be a stale file or symlink — never
  // traverse into it: flag/remove the entry, let emit recreate the real
  // directory. readdirSync would follow the link and the stale sweep
  // below would then delete files OUTSIDE the repo.
  const dirPath = join(ROOT, dir)
  let dirStat
  try {
    dirStat = lstatSync(dirPath)
  } catch {
    dirStat = undefined
  }
  if (dirStat !== undefined && !dirStat.isDirectory()) {
    if (CHECK) {
      drift.push(dir)
    } else {
      rmSync(dirPath, { recursive: true, force: true })
    }
    dirStat = undefined
  }
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
    if (dirStat !== undefined) {
      for (const f of walk(dirPath)) {
        if (!expected.has(`${dir}/${f}`)) {
          drift.push(`${dir}/${f}`)
        }
      }
    }
  } else {
    // remove stale outputs first so `gen:plugins` repairs what --check
    // flags; declared hand-written files are in `expected` and survive
    if (dirStat !== undefined) {
      for (const f of walk(join(ROOT, dir))) {
        if (!expected.has(`${dir}/${f}`)) {
          rmSync(join(ROOT, dir, f))
        }
      }
    }
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
    // lstat — a symlinked directory is a LEAF: recursing through it would
    // surface external paths that the stale-cleanup then deletes outside
    // the repo. rmSync on the yielded link removes the link, not the target.
    const st = lstatSync(p)
    if (st.isDirectory() && !st.isSymbolicLink()) {
      yield* walk(p, rel)
    } else {
      yield rel
    }
  }
}

if (CHECK && drift.length > 0) {
  console.error(`plugin adapters out of date — run \`npm run gen:plugins\`:\n  ${[...new Set(drift)].join('\n  ')}`)
  process.exit(1)
}
console.log(CHECK ? 'plugin adapters fresh' : 'plugin adapters generated')

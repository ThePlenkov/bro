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
 *   plugins/cursor/bro/  .cursor-plugin/plugin.json + hooks/hooks.json
 *                        (Cursor event names, command shape, output schema)
 *
 * Every adapter gets skills/ and hooks/run.sh. Only the Claude hooks wiring
 * is authored by hand — Cursor's hooks.json is generated from the event
 * map below. `check:plugins` fails CI when an adapter drifts from its source.
 *
 *   node scripts/gen-plugins.ts           # write
 *   node scripts/gen-plugins.ts --check   # verify freshness, exit 1 on drift
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURSOR_SELF_TOOL_MATCHER } from '../packages/cli/src/cursor-hook.ts'

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

// Cursor's marketplace schema rejects a per-entry version, so this file
// is not in MARKETPLACES (nothing to stamp). The source path is the
// contract check:plugins can still enforce.
const cursorMarketplace = readJson('.cursor-plugin/marketplace.json')
const cursorEntry = (cursorMarketplace.plugins ?? []).find((p) => p?.name === 'bro')
if (cursorMarketplace.name !== 'bro' || cursorEntry?.source !== 'plugins/cursor/bro') {
  console.error(
    '.cursor-plugin/marketplace.json: name "bro" must source "plugins/cursor/bro"'
  )
  process.exit(1)
}
if (cursorEntry.version !== undefined && cursorEntry.version !== cliVersion) {
  console.error(
    `.cursor-plugin/marketplace.json: version ${cursorEntry.version} != packages/cli version ${cliVersion}`
  )
  process.exit(1)
}

/** Claude/Codex manifests reuse the agent-plugins fields minus $schema. */
function clientManifest(extra = {}) {
  const { $schema: _drop, ...fields } = manifest
  return `${JSON.stringify({ ...fields, ...extra }, null, 2)}\n`
}

/** Cursor's plugin schema is additionalProperties:false and its own
 * field set — don't spread agent-plugins fields it doesn't know. */
function cursorManifest() {
  const author = manifest.author
  const authorName =
    typeof author === 'string'
      ? author.trim()
      : author && typeof author === 'object' && typeof author.name === 'string'
        ? author.name.trim()
        : ''
  const body = {
    name: manifest.name,
    displayName: 'bro',
    version: manifest.version,
    description: manifest.description,
    ...(authorName ? { author: { name: authorName } } : {}),
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords,
    category: 'developer-tools',
    skills: './skills/',
    hooks: './hooks/hooks.json',
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/** ${CURSOR_PLUGIN_ROOT} is a bare token so Cursor expands it before the
 * shell runs. Quoted, so a path with spaces survives. Fallback is bro on
 * PATH, then the version-pinned package. Always exit 0. */
function cursorHookCommand(event) {
  // events are code-owned literals today; keep that a checked invariant —
  // the string lands in a shell command, so a future caller passing
  // metachars must fail here, not in the generated hooks.json
  if (!/^[a-z-]+$/.test(event)) {
    throw new Error(`invalid hook event name: ${event}`)
  }
  const pin = `@broject/bro@${manifest.version}`
  return `if [ -f "\${CURSOR_PLUGIN_ROOT}/hooks/run.sh" ]; then "\${CURSOR_PLUGIN_ROOT}/hooks/run.sh" ${event} || true; elif command -v bro >/dev/null 2>&1 && bro hooks >/dev/null 2>&1; then bro hooks ${event} || true; elif command -v npx >/dev/null 2>&1; then npx -y --prefer-offline "${pin}" hooks ${event} || true; fi; exit 0`
}

function cursorHook(event, timeout, extra = {}) {
  return { command: cursorHookCommand(event), timeout, ...extra }
}

/** sessionStart is absent on cloud agents, and a loaded repo's
 * session-start probe measures 20–40s — the first beforeSubmitPrompt
 * does that work, so both timeouts sit above it. stop's loop_limit is
 * 1: one follow-up, then the turn ends (gates, not loops). */
function cursorHooksJson() {
  const body = {
    version: 1,
    hooks: {
      sessionStart: [cursorHook('session-start', 45)],
      preCompact: [cursorHook('pre-compact', 20)],
      beforeSubmitPrompt: [cursorHook('prompt-submit', 45)],
      postToolUse: [cursorHook('post-tool', 10, { matcher: '^Shell$' })],
      postToolUseFailure: [cursorHook('post-tool', 10, { matcher: '^Shell$' })],
      stop: [cursorHook('stop', 25, { loop_limit: 1 })],
      beforeShellExecution: [
        cursorHook('permission', 10, { matcher: CURSOR_SELF_TOOL_MATCHER }),
      ],
    },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function cursorReadme() {
  return `# bro — Cursor plugin

Agent's sidekick for Cursor: review debt, the PR review loop, drill frames,
and wtf→retro. Mechanics live in the \`bro\` CLI. This directory is the
Cursor plugin — skills plus lifecycle hooks.

## Install

In Cursor:

\`\`\`text
/add-plugin https://github.com/ThePlenkov/bro
\`\`\`

Then install **bro** from Customize. The marketplace manifest is
\`.cursor-plugin/marketplace.json\` at the repo root; this directory is
the plugin it points at.

For a local checkout, symlink or copy \`plugins/cursor/bro\` to
\`~/.cursor/plugins/local/bro\`.

Context and stop hooks stay quiet until the workspace opts in
(\`bro.config.json\` or \`.beads/\`, which \`bro setup\` writes). A missing
CLI or a timeout never stalls the session. \`beforeShellExecution\` still
answers when the workspace has not opted in — Cursor treats an empty
reply as a deny. A plain \`bro\` / \`bd\` / \`npx @broject/bro\` is allowed;
anything else that matched is left as a prompt.

## Hooks

| Cursor hook | bro event | Effect |
| --- | --- | --- |
| \`sessionStart\` | \`session-start\` | Rehydrate beads, drill, debt, and PR state |
| \`beforeSubmitPrompt\` | \`prompt-submit\` | Prompt context. The first one also rehydrates when \`sessionStart\` did not run (cloud agents) |
| \`preCompact\` | \`pre-compact\` | Drop the rehydration mark so the next prompt reloads state |
| \`postToolUse\` / \`postToolUseFailure\` | \`post-tool\` | Arm the stop gate, cite the governing skill, drain \`bro notify\` |
| \`stop\` | \`stop\` | One follow-up when this session armed a gate (\`loop_limit: 1\`) |
| \`beforeShellExecution\` | \`permission\` | Auto-approve a plain \`bro\` / \`bd\` / \`npx @broject/bro\` command |

A chained command (\`bro act status && …\`) is not auto-approved.

Requires Node ≥ 22.18. The hook resolves a built checkout, then \`bro\` on
PATH, then \`npx -y @broject/bro@${manifest.version}\`.
`
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
  'plugins/cursor/bro': {
    '.cursor-plugin/plugin.json': [cursorManifest()],
    'hooks/hooks.json': [cursorHooksJson()],
    'README.md': [cursorReadme()],
    'LICENSE': 'LICENSE',
  },
}

// the npx fallback pin always equals plugin.json's version — rewrite it in
// the hook sources so a version bump can't leave a stale pin behind
const VERSIONED_SOURCES = [
  'hooks.json',
  'hooks/run.sh',
  'plugins/claude/bro/hooks/hooks.json',
]
const PIN_RE = /@broject\/bro@[\w.:-]+/g

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

// keep every `@broject/bro@…` npx pin equal to plugin.json's version
for (const src of VERSIONED_SOURCES) {
  const p = join(ROOT, src)
  if (!existsSync(p)) {
    drift.push(src)
    continue
  }
  const text = readFileSync(p, 'utf8')
  const synced = text.replace(PIN_RE, `@broject/bro@${manifest.version}`)
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

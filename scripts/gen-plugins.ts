/**
 * gen-plugins — materialize per-client plugin adapters under plugins/.
 *
 * The repo root is the Agent Plugin (plugin.json + skills/ per
 * agent-plugins.org and agentskills.io) and the Devin plugin. Host
 * directories carry only that client's extras (manifest, hooks). Codex
 * installs the repo root, so it does not get a skills tree of its own.
 *
 *   plugins/devin/bro/   plugin.json + hooks.json copied from root
 *   .claude-plugin/plugin.json  Claude manifest at the repo root; skills
 *                        are ./skills/, hooks are ./hooks/hooks.json
 *   .codex-plugin/plugin.json  Codex manifest at the repo root; skills
 *                        resolve to ./skills/, hooks to the hand-written
 *                        plugins/codex/bro/hooks/hooks.json
 *   plugins/cursor/bro/  .cursor-plugin/plugin.json + hooks/hooks.json
 *                        (Cursor event names, command shape, output schema)
 *
 * Claude and Codex install the repo root, so neither gets a skills tree
 * of its own. Other adapters still link skills/ until their marketplace
 * does the same. Each of those copies hooks/run.sh. Claude and Codex
 * hooks wiring is authored by hand — Cursor's hooks.json is generated from
 * the event map below. `check:plugins` fails CI when an adapter drifts.
 *
 *   node scripts/gen-plugins.ts           # write
 *   node scripts/gen-plugins.ts --check   # verify freshness, exit 1 on drift
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
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
const codexMarketplace = readJson('.agents/plugins/marketplace.json')
const codexEntry = (codexMarketplace.plugins ?? []).find((p) => p?.name === 'bro')
if (codexEntry?.source !== '.') {
  console.error(
    '.agents/plugins/marketplace.json: bro source must be "." — the repo root is the Agent Plugin'
  )
  process.exit(1)
}
const claudeMarketplace = readJson('.claude-plugin/marketplace.json')
const claudeEntry = (claudeMarketplace.plugins ?? []).find((p) => p?.name === 'bro')
if (claudeEntry?.source !== './') {
  console.error(
    '.claude-plugin/marketplace.json: bro source must be "./" — the repo root is the plugin'
  )
  process.exit(1)
}
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

function cursorAuthorName(author) {
  if (typeof author === 'string') {
    return author.trim()
  }
  if (author && typeof author === 'object' && typeof author.name === 'string') {
    return author.name.trim()
  }
  return ''
}

/** Cursor's plugin schema is additionalProperties:false and its own
 * field set — don't spread agent-plugins fields it doesn't know. */
function cursorManifest() {
  const authorName = cursorAuthorName(manifest.author)
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
  // the `bro hooks` capability probe runs with stdin closed — a bare
  // invocation must not consume the payload stdin still holds for the
  // real `bro hooks ${event}` call that follows
  return `if [ -f "\${CURSOR_PLUGIN_ROOT}/hooks/run.sh" ]; then "\${CURSOR_PLUGIN_ROOT}/hooks/run.sh" ${event} || true; elif command -v bro >/dev/null 2>&1 && bro hooks </dev/null >/dev/null 2>&1; then bro hooks ${event} || true; elif command -v npx >/dev/null 2>&1; then npx -y --prefer-offline "${pin}" hooks ${event} || true; fi; exit 0`
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

function opencodeReadme() {
  return `# bro — opencode plugin

Agent's sidekick for opencode: the same lifecycle mechanics bro gives
other clients, over opencode's native JS/TS plugin bus. \`bro.ts\` is a
verbatim copy of \`packages/cli/src/opencode.ts\` — a self-contained
module (node builtins only) generated by \`npm run gen:plugins\`;
\`check:plugins\` fails when it drifts. It serves opencode V1
(\`server\` → the classic hook map) and V2 (\`id\` + \`setup(ctx)\` —
context/compaction/prompt session hooks, tool guard + result
enrichment, permission evaluate, shell env, the bro tool namespace,
the \`/bro\` command, and the public event stream's stop gate).

\`cli.ts\` is the TUI half — a verbatim copy of
\`packages/cli/src/opencode-tui.ts\` (\`./tui\` in the npm package).
It adds a \`bro.status\` palette/slash command that runs \`bro status\`
and shows the board as a toast, plus toasts on \`permission.asked\` and
\`session.error\`.

## Install

\`\`\`sh
bro plugins install opencode            # both scopes
bro plugins install opencode --global   # ~/.config/opencode/plugins/{bro.ts,bro-cli.ts}
bro plugins install opencode --local    # <repo>/.opencode/plugins/{bro.ts,bro-cli.ts}
\`\`\`

Repo-distributed: this directory inside a bro clone is itself the
adapter — point opencode at it, or let \`bro plugins install --local\`
copy \`bro.ts\` + \`cli.ts\` (as \`bro-cli.ts\`) into the project's
\`.opencode/plugins/\`.

The module resolves the CLI as local dist (bundled sibling or the
checkout's \`packages/cli/dist/index.js\` found walking up), then \`bro\`
on PATH passing the \`bro hooks\` probe, then \`npx -y --prefer-offline
@broject/bro@${manifest.version}\`. Every hook call is async and
fail-open — a missing CLI means no context, never an error.
`
}

function kiloReadme() {
  return `# bro — kilo plugin

Agent's sidekick for kilo: bro subcommands as a tool, session-start
rehydration, a stop-gate warn on \`session.idle\`, and auto-approve for
bro/bd shell calls — over kilo's native plugin bus. \`bro.ts\` is a
verbatim copy of \`packages/cli/src/kilo.ts\`, generated by
\`npm run gen:plugins\`; \`check:plugins\` fails when it drifts.

## Install

\`\`\`sh
bro plugins install kilo            # both scopes
bro plugins install kilo --global   # ~/.config/kilo/bro/bro.ts + kilo.json plugin[] entry
bro plugins install kilo --local    # <repo>/.kilo/plugin/bro.ts
\`\`\`

The module imports \`@kilocode/plugin\` — kilo provisions a
\`package.json\` + \`node_modules\` in any config dir that carries a
\`plugin/\` folder, so the specifier resolves inside kilo's plugin
environment. Local installs are auto-loaded from \`.kilo/plugin/\`;
global installs register a \`file:///\` entry in
\`~/.config/kilo/kilo.json\`.

The module resolves the CLI as the checkout's
\`packages/cli/dist/index.js\` found walking up, then \`bro\` on PATH.
Every hook call is fail-open — a missing CLI means no context, never an
error.
`
}

function piReadme() {
  return `# bro — pi extension

Agent's sidekick for pi: the live project board on pi's TUI plus the
same lifecycle mechanics the shell adapters carry, over pi's in-process
extension API. \`bro.ts\` is a verbatim copy of \`packages/cli/src/pi.ts\`
— a self-contained module (node builtins only) generated by
\`npm run gen:plugins\`; \`check:plugins\` fails when it drifts.

## What it wires

- **board widget** — \`bro status --json\` rendered via
  \`ctx.ui.setWidget\`/\`setStatus\`, refreshed on session start, turn
  end, and agent settle.
- **lifecycle** — pi events → \`bro hooks <event>\`: session-start and
  post-compaction rehydration injected once as a hidden context message,
  pre-compact carried across, prompt-submit nudges, post-tool arming,
  and \`agent_before_settle\` → the stop gate (a real gate: block lands
  the blocker as a message and continues the turn, once per session).
- **\`/bro\`** — bare refreshes the board; \`/bro act|next|fleet|…\`
  runs the CLI and drops the output into the transcript.
- **\`bro_status\` tool** — the board JSON as a model-callable read.

## Install

\`\`\`sh
bro plugins install pi            # both scopes
bro plugins install pi --global   # ~/.pi/agent/extensions/bro.ts
bro plugins install pi --local    # <repo>/.pi/extensions/bro.ts
\`\`\`

Pi discovers extensions from \`<cwd>/.pi/extensions/\` and
\`~/.pi/agent/extensions/\` (jiti loads the raw .ts — no build needed),
or load it ad hoc: \`pi --extension <path>/bro.ts\`.

The module resolves the CLI as local dist (bundled sibling or the
checkout's \`packages/cli/dist/index.js\` found walking up), then \`bro\`
on PATH passing the \`bro hooks\` probe, then \`npx -y --prefer-offline
@broject/bro@${manifest.version}\`. Every call is async and fail-open —
a missing CLI or a non-bro directory means no widget and no context,
never an error.
`
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

For a local checkout, symlink \`plugins/cursor/bro\` to
\`~/.cursor/plugins/local/bro\`. \`skills\` in that directory is a link to
the repository \`skills/\` tree — one copy for every client — so the
adapter has to stay inside the checkout.

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

/** Per-adapter opt-outs — opencode plugins are bare modules: no skills
 *  tree, no shell hook launcher. Anything not listed gets both. */
const ADAPTER_OPTS: Record<string, { skills?: boolean; runSh?: boolean }> = {
  'plugins/opencode/bro': { skills: false, runSh: false },
  'plugins/kilo/bro': { skills: false, runSh: false },
  'plugins/pi/bro': { skills: false, runSh: false },
  // Codex installs the repo root (plugin.json + skills/). A skills entry
  // here would be a second package. Claude does too: its manifest and
  // hooks live at the repo root, so there is no plugins/claude adapter.
  'plugins/codex/bro': { skills: false },
}

// files written per adapter — value is source path, or [text] literal content
const ADAPTERS = {
  'plugins/opencode/bro': {
    'bro.ts': 'packages/cli/src/opencode.ts',
    'cli.ts': 'packages/cli/src/opencode-tui.ts',
    'README.md': [opencodeReadme()],
  },
  'plugins/kilo/bro': {
    'bro.ts': 'packages/cli/src/kilo.ts',
    'README.md': [kiloReadme()],
  },
  'plugins/pi/bro': {
    'bro.ts': 'packages/cli/src/pi.ts',
    'README.md': [piReadme()],
  },
  'plugins/devin/bro': {
    'plugin.json': 'plugin.json',
    'hooks.json': 'hooks.json',
  },
  'plugins/codex/bro': {
    // hand-written (Codex event names) — listed so --check doesn't flag it.
    // The manifest lives at the repo root: this directory is hooks only.
    'hooks/hooks.json': null,
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
  'plugins/codex/bro/hooks/hooks.json',
  // the materialized opencode modules carry the npx fallback pin
  'packages/cli/src/opencode.ts',
  'packages/cli/src/opencode-tui.ts',
  // the pi extension carries the same pin
  'packages/cli/src/pi.ts',
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

/** plugins/<client>/bro/skills → the one repo skills/ tree. Forward
 * slashes so the git symlink is the same on every OS. */
function skillsLinkTarget(adapterRel) {
  return relative(join(ROOT, adapterRel), join(ROOT, 'skills')).split(sep).join('/')
}

function skillsLinkFresh(adapterRel) {
  const link = join(ROOT, adapterRel, 'skills')
  try {
    const st = lstatSync(link)
    return st.isSymbolicLink() && readlinkSync(link) === skillsLinkTarget(adapterRel)
  } catch {
    return false
  }
}

function ensureSkillsLink(adapterRel) {
  if (skillsLinkFresh(adapterRel)) {
    return
  }
  const link = join(ROOT, adapterRel, 'skills')
  rmSync(link, { recursive: true, force: true })
  mkdirSync(join(ROOT, adapterRel), { recursive: true })
  symlinkSync(skillsLinkTarget(adapterRel), link)
}

emit('.claude-plugin/plugin.json', clientManifest())

emit(
  '.codex-plugin/plugin.json',
  clientManifest({
    interface: { displayName: 'bro' },
    skills: './skills/',
    hooks: './plugins/codex/bro/hooks/hooks.json',
  })
)

for (const [dir, files] of Object.entries(ADAPTERS)) {
  // A symlinked adapter dir is replaced before any write. emit() only
  // notices a symlink at the file itself; a link at the directory would
  // let mkdir/writeFile follow it and modify a tree outside the checkout.
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
      continue
    }
    rmSync(dirPath, { recursive: true, force: true })
    dirStat = undefined
  }
  const opts = ADAPTER_OPTS[dir] ?? {}
  const linkSkills = opts.skills !== false
  const wantRunSh = opts.runSh !== false
  // expected file set: declared entries + the skills symlink + hooks/run.sh.
  // A copied skills tree lists every file so the stale sweep can see them.
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
  if (linkSkills) {
    expected.add(skillsOut)
  }
  if (wantRunSh) {
    expected.add(runShOut)
  }
  if (!CHECK) {
    if (linkSkills) {
      ensureSkillsLink(dir)
    }
  } else if (linkSkills && !skillsLinkFresh(dir)) {
    drift.push(skillsOut)
  }
  if (CHECK) {
    if (wantRunSh) {
      const wantSh = readFileSync(join(ROOT, 'hooks/run.sh'), 'utf8')
      if (!existsSync(join(ROOT, runShOut)) || readFileSync(join(ROOT, runShOut), 'utf8') !== wantSh) {
        drift.push(runShOut)
      }
    }
    // stale leftovers — files on disk that generation no longer produces
    if (dirStat !== undefined) {
      for (const f of walk(dirPath)) {
        // the skills symlink is checked by skillsLinkFresh — don't flag
        // the link itself. Adapters without skills get no carve-out: a
        // `skills` entry there IS the drift.
        if (linkSkills && (f === 'skills' || f.startsWith('skills/'))) {
          continue
        }
        if (!expected.has(`${dir}/${f}`)) {
          drift.push(`${dir}/${f}`)
        }
      }
    }
  } else {
    // remove stale outputs first so `gen:plugins` repairs what --check
    // flags; declared hand-written files are in `expected` and survive.
    // skills/ is already the symlink, so this walk does not enter it.
    if (dirStat !== undefined) {
      for (const f of walk(join(ROOT, dir))) {
        if (!expected.has(`${dir}/${f}`)) {
          rmSync(join(ROOT, dir, f))
        }
      }
    }
    if (wantRunSh) {
      mkdirSync(join(ROOT, `${dir}/hooks`), { recursive: true })
      cpSync(join(ROOT, 'hooks/run.sh'), join(ROOT, runShOut))
    }
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

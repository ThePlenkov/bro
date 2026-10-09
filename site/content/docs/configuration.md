---
title: Configuration
description: bro.config.ts — typed config, validated sections, safe fallbacks.
---

Config lives in three merged layers — precedence **local > project >
global**:

| Layer | File | Audience |
| ----- | ---- | -------- |
| global | `$XDG_CONFIG_HOME/bro/config.{ts,json}` (default `~/.config/bro/`) | Your cross-project operator config — `providers`, `judge`, `fleet`, `agents` |
| project | `bro.config.{ts,json}` in the repo root | Committed, identical-for-everyone policy — `act`, `sdd`, `guard`, `debt`, `stack` |
| local | `bro.config.local.{ts,json}` in the repo root | Gitignored project-private overrides — machine paths, personal caps |

Each layer resolves cwd → main worktree root (linked worktrees
inherit), `.ts` shadows `.json` in one dir. Layers deep-merge: objects
merge per key, arrays and scalars replace — a layer only needs the keys
it sets. `bro doctor` prints the effective layers, per-section
provenance, and warns when operator config sits in the committed file
or policy sits in the global one (advisory — loading never drops a
section for being in the "wrong" layer).

```ts
// bro.config.ts — plain default export; every key optional
export default {
  personality: 'terse',
  stores: ['jsonl', 'beads'],
  debt: { dir: '.agents/review-debt' },
  sync: { ref: 'refs/bro/data', remote: 'origin', beads: true },
  act: { ignoreChecks: ['kilo'], maxRounds: 3 },
  plugins: ['./my-plugin.ts'],
}
```

`bro setup` writes `bro.config.local.json` — store choices are
machine-local and never belong in the committed layer.

## Sections

### `stores`

Artifact backends. `jsonl` is the evidence ledger — always written.
`beads` is on by default (auto-inits `.beads` stealth when missing —
announced on stderr, skipped on dry/list-only/empty-ledger runs, nothing
lands in git) and projects debt into `bd`.
`gitref` pushes artifact dirs to the data ref.
Explicit `"stores": ["jsonl"]` is the beads opt-out.

### `debt`

| Key | Default | What |
| --- | ------- | ---- |
| `dir` | `.agents/review-debt` | Ledger directory (`BRO_DEBT_DIR` env wins) |

### `sync`

| Key | Default | What |
| --- | ------- | ---- |
| `ref` | `refs/bro/data` | Data ref — outside `refs/heads`, never a branch |
| `remote` | `origin` | Remote the data ref pushes/pulls |
| `beads` | `true` | Also run `bd sync` — beads state (drill frames, wtfs, retros) has its own transport; `false` syncs only bro artifacts |

### `act`

| Key | Default | What |
| --- | ------- | ---- |
| `ignoreChecks` | `[]` | Advisory checks excluded from the exit gate — for chronically flaky external reviewers. Entries are name substrings or `{ name, consecutiveFailures, threadWindowDays }` (defaults `3`, `7`): a *failing* check stays quiet only after that many consecutive failing heads with matching thread activity — otherwise it surfaces as a non-blocking alert |
| `maxRounds` | `3` | Inline fix-round cap. Past it, remaining threads must defer to debt beads. `0` unbounds non-docs PRs — a docs-only PR is still capped while `docsMaxRounds > 0` |
| `docsPaths` | `['*.md', '*.mdx', '*.rst', 'docs/']` | Path patterns classifying a file as docs. No slash → basename glob (`*.md`); trailing `/` → dir at any depth, name globs too (`docs*/` hits `docs-v2/`); otherwise full-path glob (`**` crosses `/`) |
| `docsMaxRounds` | `2` | Tighter round cap for docs-only PRs (every changed file matches `docsPaths`). `0` disables the docs-specific cap — `(maxRounds: 0, docsMaxRounds: 0)` is fully uncapped |

### `plugins`

External plugin specifiers — relative paths (contained to the repo) or
package names, imported at startup. Each module's default export must be
a `BroPlugin`. See [Plugins](/docs/plugins).

### `loop`

| Key | Default | What |
| --- | ------- | ---- |
| `agent` | `""` | Shell template for the agent command; `{promptFile}` is replaced by the work order. The raw lane — superseded by `provider`/`profile` |
| `provider` | `""` | Named [provider](/docs/commands/providers) the spawn resolves through — `acp` entries run the headless `acp-worker`, `cli` entries substitute their command for `agent` |
| `profile` | `""` | `fleet.profiles.<name>` preset — fills provider/model/autoApprove piecewise |
| `model` | `""` | Model override for the provider lane |
| `bootstrap` | `""` | Optional command run in each fresh worktree before the agent |
| `agentTimeoutMin` | `45` | Per-agent time budget in minutes |
| `mergeTimeoutMin` | `45` | Review-gate budget in minutes |
| `fixRounds` | `3` | Maximum review-fix respawns per bead |
| `maxItems` | `0` | Maximum beads per run; `0` means until idle or gated |

### `drive`

| Key | Default | What |
| --- | ------- | ---- |
| `intervalSec` | `300` | Cadence for `--every` and scheduled `--once` runs |
| `merge` | `"auto"` | `auto` merges orphaned green PRs; `never` reports them without merging |

### `fleet`

| Key | Default | What |
| --- | ------- | ---- |
| `maxConcurrent` | `3` | Cap on live registry agents, counted across all backends. `0` is uncapped. Enforced in the shared spawn prologue under the registry lock; an unverifiable entry occupies its slot (fail-closed) |

### `agents`

`agents` contains object-valued backend-specific configuration bags.
Their keys are defined by the selected backend; there is no universal
backend option set or schema default. Choose the backend under
`connectors.agents`, not `agents`. Two cross-backend keys exist:

| Key | Default | What |
| --- | ------- | ---- |
| `agents.<backend>.provider` | unset | Named [provider](/docs/commands/providers) the backend's spawns run through |
| `agents.<kind>.maxSessions` | unset | Host-wide live-session quota for that session kind (e.g. `agents.devin.maxSessions`), admitted under a shared slot lock |

### `providers`

The named provider registry — `{ "<name>": { "type": "api"\|"acp"\|"cli",
…connection } }`. Consumers pick by name; the entry's kind fixes the
connection shape (`api`: `baseUrl` + `apiKeyEnv`/`apiKeyCommand` +
`models` allowlist; `acp`/`cli`: `command` + `model`). See
[Providers](/docs/commands/providers).

### `judge`

| Key | Default | What |
| --- | ------- | ---- |
| `mode` | `"off"` | `off` decides nothing on its own; `shadow` annotates `act threads` and journals verdicts |
| `provider` / `model` | unset | Named provider + allowed model id the chain resolves through |
| `fallback` | unset | Escalation provider name re-asked on unanswered or low-confidence answers |
| `confidence` | `0.6` | Confidence floor below which answers escalate |
| `timeoutMs` | `3000` | Bounds the whole chained call |
| `maxDecisionsPerRun` | `50` | Fresh `decide()` calls per invocation |
| `baseUrl` / `apiKeyEnv` / `llm` | unset | Legacy single-backend shape — synthesized into anonymous `api` providers with a deprecation warning |

### `guard`

| Key | Default | What |
| --- | ------- | ---- |
| `enabled` | `true` | `false` silences the whole mechanism |
| `defs` | `[]` | Project-owned guard declarations — `{ name, when, say }`; shadow a builtin by reusing its name |
| `maxPerEvent` | — | Cap on guard lines one hook event emits |

See [bro guard](/docs/commands/guard) for the `when` clause vocabulary.

### `query`

| Key | Default | What |
| --- | ------- | ---- |
| `concurrency` | `4` | Fan-out cap for `query` plan steps |
| `env` | `{}` | Operator-pinned literal env overlay for connector spawns |

### `sweep`

| Key | Default | What |
| --- | ------- | ---- |
| `olderThanDays` | `30` | Age line for both the gate and `bd prune --older-than` |
| `dir` | `.agents/sweep` | Archive directory — must live inside the synced set so `bro sync` carries it |
| `flatten` | `true` | Run `bd flatten` as the pipeline's last stage |

### `learn`

| Key | Default | What |
| --- | ------- | ---- |
| `enabled` | `true` | Disable lesson injection without deleting the store |
| `maxInject` | `3` | Maximum lesson lines emitted by one hook probe |
| `sources` | `[]` | Empty means all lesson sources; a non-empty list is an allowlist |

### `sdd`

| Key | Default | What |
| --- | ------- | ---- |
| `mode` | `"off"` | `off`, `remind`, or `gate`; gate blocks once at the stop hook |
| `dir` | `"specs"` | Directory used by the native specs connector |

### `watch`

| Key | Default | What |
| --- | ------- | ---- |
| `intervalSec` | `60` | Heartbeat cadence for `bro watch install` |

### `check`

| Key | Default | What |
| --- | ------- | ---- |
| `bin` | unset | Sverka executable or path |
| `config` | unset | Sverka config path |
| `entry` | unset | Sverka entry name |
| `executor` | unset | `host` or `docker` |
| `evaluate` | `false` | Collect SARIF artifacts and run the policy gate |

### `drill`

| Key | Default | What |
| --- | ------- | ---- |
| `report.dir` | `"drills"` | Repo-relative directory for durable drill reports |
| `report.mode` | `"off"` | `off`, `prompt`, or `always`; explicit `--report` still wins |

### `stack`

| Key | Default | What |
| --- | ------- | ---- |
| `mode` | `"manual"` | `manual` stacks only on explicit `--stack`/`--base`; `auto` uses the current worktree branch when appropriate |

### `beads`

| Key | Default | What |
| --- | ------- | ---- |
| `global` | `~/.local/share/bro/beads` | User-level beads directory; `BRO_GLOBAL_BEADS` overrides the file value, and `~` expands to the home directory |

---
title: Configuration
description: bro.config.ts — typed config, validated sections, safe fallbacks.
---

`bro.config.ts` (preferred) or `bro.config.json` in the repo root.
Everything is optional — missing keys and wrong-type values fall back
to per-section defaults instead of crashing. (A syntactically broken
file is different — `bro setup` will tell you to fix it.)

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

The config file is written per-clone by `bro setup` and gitignored on
purpose — store choices are machine-local.

## Sections

### `stores`

Artifact backends. `jsonl` is the evidence ledger — always written.
`beads` is on by default (auto-inits `.beads` stealth when missing) and
projects debt into `bd`. `gitref` pushes artifact dirs to the data ref.
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
| `ignoreChecks` | `[]` | Check-name substrings excluded from the exit gate — for chronically flaky external reviewers |
| `maxRounds` | `3` | Inline fix-round cap. Past it, remaining threads must defer to debt beads. `0` disables |

### `plugins`

External plugin specifiers — relative paths (contained to the repo) or
package names, imported at startup. Each module's default export must be
a `BroPlugin`. See [Plugins](/bro/plugins/).

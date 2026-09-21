---
title: Plugins
description: bro is a host — definePlugin, external loading, custom components.
---

bro is a plugin system on top of beads and `gh`. Every built-in command
is a plugin in one registry; external plugins load from config and get
the same contract — command, skill, config section, plan schema.

## The contract

A plugin is a plain object — or typed via the side-effect-free
`@theplenkov/bro/plugin` entry point:

```ts
// bro-memory.ts
import { definePlugin } from '@theplenkov/bro/plugin'

export default definePlugin({
  name: 'memory',                    // → `bro memory <args>`
  summary: 'remember what matters',  // shows in `bro plugins` + help
  skill: 'memory',                   // skills/memory/SKILL.md
  argvPrefix: ['mem'],               // aliases
  configKey: 'memory',               // owns the `memory` config section
  configSchema: (raw) => ({
    dir: typeof raw?.dir === 'string' ? raw.dir : '.agents/memory',
  }),
  planSchema: validateMemoryPlan,    // validates `kind = "memory"` plans
  runPlan: runMemoryPlan,            // executes them via `bro run`
  run: (argv) => { /* ... */ },
})
```

Required: `name`, `summary`, `run`. Everything else is optional and
type-checked at load — wrong field types warn and skip the plugin.
`@theplenkov/bro/plugin` also exports `defineConfig`, `makePrinter`, and
the `BroPlugin` / `BroConfig` / `ConfigSection` / `PlanSchema` types —
it never runs the CLI on import.

## Loading external plugins

```ts
// bro.config.ts
export default {
  plugins: ['./bro-memory.ts', '@acme/bro-standup'],
}
```

- Relative paths resolve from the repo root and **cannot escape it**
- Default export must be a `BroPlugin` (or an array)
- Names colliding with built-ins are rejected; so are `configKey`s that
  shadow an owned section
- Invalid plugins warn and are skipped — they never crash the CLI
- TypeScript files load natively (Node ≥ 22)

## Bring your own memory

Everyone's memory layer is different — that's the point of the split. A
memory plugin is a plugin that owns a config section and a command:

```ts
// bro-memory.ts — a repo-local plugin
export default {
  name: 'memory',
  summary: 'project memory, my way',
  configKey: 'memory',
  configSchema: (raw) => ({ dir: raw?.dir ?? '.memory' }),
  run: async (argv) => {
    // write/read whatever store you want — sqlite, files, a service
  },
}
```

Artifacts that shouldn't touch the review surface go on the data ref —
`bro sync` carries them. Stores, commands, config, plans: if your
component fits the contract, bro hosts it.

## Guardrails

- Built-in command names and config sections are protected from external
  collisions
- `bro plugins` lists the live registry — name, skill, config, summary
- External plugins can't be `hidden` from the help output

# @broject/loop

[![npm](https://img.shields.io/npm/v/@broject/loop)](https://www.npmjs.com/package/@broject/loop)

The autonomous backlog loop behind `bro loop` — claims each ready bead,
spawns the configured agent in a fresh worktree, drives the `bro act`
review gate, closes the bead, repeats.

> You probably want the CLI instead: `bro loop`.
> Install this only when building your own agent driver.

## Install

```bash
npm i @broject/loop
```

Requires Node ≥ 22, `bd`, and a configured agent (`loop.agent` in
bro.config.json). ESM only.

## Surface

- `planItem` / `LoopItem` — the work-order payload per claimed bead
- `buildWorkPrompt` / `buildFixPrompt` / `expandAgentCmd` — agent spawn
- `DEFAULT_LOOP_CONFIG` / `LoopConfig` / `LoopBead` — config + types
- `loopSection` — the `loop` section of bro.config.json

## Links

- Docs: https://broject.dev/docs
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/loop
- CLI: https://www.npmjs.com/package/@broject/bro

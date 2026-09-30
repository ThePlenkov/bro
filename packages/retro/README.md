# @broject/retro

[![npm](https://img.shields.io/npm/v/@broject/retro)](https://www.npmjs.com/package/@broject/retro)

The retrospect engine behind `bro retrospect` — parses TOML retro plans
(a root cause + prevention actions) and fans each action out to its sink:
beads, skills, rules, or docs. Powers `bro wtf`.

> You probably want the CLI instead: `bro wtf "it happened again"`.
> Install this only when wiring self-correction into your own loop.

## Install

```bash
npm i @broject/retro
```

Requires Node ≥ 22 and `bd`. ESM only.

## Surface

- `parsePlan` / `parsePlanDoc` / `PLAN_SCHEMA` — retro plan parsing +
  validation
- `ACTION_SINKS` — where prevention actions land: `backlog`, `memory`,
  `agentic-documents`, `upstream-issue`, `workaround`
- `RETRO_SCOPES` — action visibility: `universal`, `project`, `user`,
  `agent`, `session`
- Re-exports `bd` primitives from `@broject/core`

## Links

- Docs: https://broject.dev/docs/commands/retrospect
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/retro
- CLI: https://www.npmjs.com/package/@broject/bro

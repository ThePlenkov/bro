# @broject/core

Shared primitives every `bro` package builds on — `gh`/`git`/`bd`
subprocess wrappers, config + TOML parsing, the plugin, doc and task-store
surfaces, plan schemas.

> You probably want the CLI instead: `npx @broject/bro --help`.
> Install this only when writing a bro connector or embedding the
> primitives in your own tool.

## Install

```bash
npm i @broject/core
```

Requires Node ≥ 22. ESM only.

## Surface

- `gh` / `ghJson` / `ghTry`, `prLink`, `resolveRepo` — GitHub CLI calls
- `git` / `gitTry` — git plumbing with structured results
- `bd` / `bdJson` / `bdTry`, `checkBeads`, `initBeadsStealth` — beads
- `definePlugin` / `BroPlugin` — the plugin contract (subcommand + skill +
  config section)
- `docTypeNamed` / `docVerbs` / `DocAdapter` — the verb-first
  `bro <verb> <noun>` surface
- `taskStore` / `TaskRow` — typed issue-level surface over the store
- `BroConfig` / `ConfigSection` — bro.config.json parsing

## Links

- Docs: https://broject.dev/docs
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/core
- CLI: https://www.npmjs.com/package/@broject/bro

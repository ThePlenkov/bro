# @broject/learn

[![npm](https://img.shields.io/npm/v/@broject/learn)](https://www.npmjs.com/package/@broject/learn)

The learn store for `bro` — lesson schema and `bd-kv` CRUD behind `bro learn`.

> You probably want the CLI instead — `bro` ships this package already.
> Install it only when building your own lesson store or connector.

## Install

```bash
npm i @broject/learn
```

Requires Node ≥ 22. ESM only. Store operations shell out to the `bd`
CLI (`bd kv`), so `bd` must be on PATH and the repo needs an
initialized beads store.

## Surface

- `Lesson` / `LessonTrigger` / `HookEvent` / `Evidence` — lesson schema and provenance types
- `putLesson` / `getLesson` / `listLessons` / `deleteLesson` — keyed lesson store
- `matchPath` / `triggerMatches` / `parseTraceLine` — match lessons to hook context
- `DEFAULT_LEARN_CONFIG` / `learnSection` — config defaults and schema
- `learnConnector` — registers the learn connector
- `captureLessons` / `planCapture` / `applyCapture` — distill completed artifacts into lessons
- `probeQuestion` / `rankLessons` / `recordProbeAnswer` — check the store before investigating again

## Links

- Docs: <https://broject.dev/docs/commands/learn>
- Source: <https://github.com/ThePlenkov/bro/tree/main/packages/learn>
- CLI: <https://www.npmjs.com/package/@broject/bro>

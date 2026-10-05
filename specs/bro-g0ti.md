---
parent: bro-f4ot.2-judge
scope:
  - packages/judge/
  - packages/cli/src/plugins.ts
  - packages/cli/src/commands/judge.ts
  - skills/judge/
  - plugins/
  - specs/sessions/bro-f4ot.2-judge.md
---

# bro-g0ti — judge: rename jev connector to systemone — protocol vs model separation

Parent: `bro-f4ot.2-judge` (judge facade + connectors). Pure rename —
no behavior change beyond the names things are called.

## Problem

Per the live API (https://docs.typesafe.ai/api.md): **System One is the
protocol** — `POST /v1/systemone` takes `{state, model, questions}` —
and `model` is a REQUIRED request field. `jev-latest` is one alias for
it; more System One models will exist. A connector named `jev`
conflates the layers — like naming an OpenAI-compat connector `gpt4`.
The connector id, config value, and `decidedBy` attribution must name
the protocol; the model stays a user-pinned config value.

## Design

Provider = protocol, model = user choice — same shape `llm-judge`
already has (`judge.llm.model` picks the model, the connector is
`llm-judge`).

- **Connector id** `jev` → `systemone`: `packages/judge/src/jev.ts` →
  `systemone.ts` (`git mv`), `jevConnector` → `systemoneConnector`,
  `jevJudge` → `systemoneJudge`, `JevJudgeOpts` →
  `SystemoneJudgeOpts`, `JEV_NAME` → `SYSTEMONE_NAME` = `'systemone'`.
- **`decidedBy`** on emitted answers: `'jev'` → `'systemone'`. Error
  strings ("jev returned …", "jev auth failed …") follow the connector
  name.
- **`connectors.judge` config value** `'jev'` → `'systemone'`. No
  deprecation alias: the whole judge capability landed after v0.2.4 —
  unreleased, nothing to deprecate (the two-release rule guards
  *shipped* surfaces).
- **Model is untouched**: `judge.model` default stays `'jev-latest'`
  (the documented default alias — a model name, not a connector name).
  Strings that name the model (`jev-1.13.0`, `typesafe/jev-1.13`) keep
  `jev`; strings that name the connector move to `systemone`.
- **Journal**: existing verdicts may carry `decidedBy: 'jev'` — left
  as recorded history; `bro judge stats` groups by the recorded name
  (a local, unreleased artifact — no migration).
- **Tests**: `jev.test.ts` → `systemone.test.ts`; fixture
  `decidedBy: 'jev'` → `'systemone'` where it denotes the connector;
  model strings stay.
- **Docs/skills**: `skills/judge/SKILL.md` updated, plugin adapters
  regenerated (`npm run gen:plugins` — never hand-edit `plugins/`),
  `packages/judge/package.json` description/keywords, doc comments in
  `index.ts`/`llm-judge.ts`/`stats.ts`/`shadow.ts`, and the parent
  spec's connector references.

## Plan

- [ ] `git mv` jev.ts/jev.test.ts → systemone.ts/systemone.test.ts;
      rename exports, connector name, decidedBy, error strings
- [ ] Update imports (`index.ts`, `cli/plugins.ts`) and tests
      (stats/replay/shadow/cli judge fixtures)
- [ ] Update skill + docs + parent spec connector refs; `npm run
      gen:plugins`
- [ ] `npm test` (exact CI command) + `npm run lint`
- [ ] Commit, push, `gh pr create` — spec rides the same PR

# AGENTS.md — bro

`bro` is the agent's sidekick CLI. Skills are instructions — bro is the hands.
Heavy mechanics live in `packages/*`; `skills/` holds thin prompt wrappers only.

## Layout

```
packages/core     @bro/core      — gh wrapper, config loader, output printer
packages/debt     @bro/debt      — review-debt domain: collect, labels, ledger
packages/cli      @theplenkov/bro — published CLI (bin: bro), bundles @bro/*
skills/bro-debt                  — thin skill: policy only, calls `bro debt *`
vendor/nx.ts      submodule      — nx-devkit source (no releases; ride the source)
```

## Critical setup step

Nx plugins come from the `vendor/nx.ts` submodule as **TS source**. They must
be patched and built before nx works:

```bash
git submodule update --init
npm install
npm run build:nx-plugins   # patches vendor source + builds dist + syncs
```

`scripts/patch-nx-submodule.ts` fixes upstream issues not yet landed
(exports → dist, vendor/ skip, projectRoot keys). Idempotent — safe to re-run
after every `git submodule update --remote`.

## Commands

```bash
npm run build      # nx run-many -t build (packages only; skills-* excluded —
                   # skill build needs the external skills-compiler)
npm test           # node:test via tsx
npm run lint       # includes skill lint/validate targets
npx nx show projects
```

## Conventions

- **Node-native only.** The published CLI runs on `node >= 22` — no `Bun.*`
  APIs anywhere in `packages/`. (`bun` is allowed in `scripts/` dev tooling.)
- **`gh` is a hard runtime dep** — shell out, don't add Octokit.
- **No deps unless needed.** Hand-rolled arg parsing beats a parser library.
- Dev deps: tsdown (build), tsx (tests/scripts), typescript.
- New skill → `skills/<name>/SKILL.md` + `agents/openai.yaml`; keep it thin —
  if it needs logic, that logic belongs in `packages/`.

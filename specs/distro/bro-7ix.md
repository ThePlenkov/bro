# bro-7ix — 0.x contract stability: changelog + deprecation policy

## Problem

The verb-first→noun-first dispatch flip shipped within days (#96→#99) —
correct for pre-1.0, but early adopters got zero signal: no changelog,
no release notes beyond auto-generated GitHub notes, and no warning on
the old grammar. The next breaking surface change (removed command,
renamed flag, retired doc verb) currently has no mechanism to warn
before removal — a user finds out when their command dies.

## Design

Minimum viable policy, two seams plus the written rule.

### Changelog per release

Releases already run on conventional commits (`release.version.
conventionalCommits`) — `nx release changelog` renders the same commits
into `CHANGELOG.md`, so notes cost nothing extra per release.

- `nx.json`: `release.changelog.workspaceChangelog` — `file` defaults
  to `CHANGELOG.md`; `createRelease: false` because release-tag.yml
  already owns the GitHub release (nx must not race it).
- `release.yml`: after `nx release version` bumps the manifests, run
  `nx release changelog "$v" --git-commit=false --git-tag=false` — the
  version is resolved explicitly since the tag doesn't exist yet, and
  git mutations stay with the workflow's single commit. `CHANGELOG.md`
  joins the staged file list so the release PR carries its notes.
- Seed the file for v0.1.0–v0.2.3 by replaying `nx release changelog`
  per tag range — same renderer, same format as future entries.

### Deprecation warnings

Contract: one stderr line, the deprecated thing still works. Two seams:

- **Command level** — `BroPlugin.deprecated?: string` carries the
  advice ("use `bro drill up`"). Dispatch prints
  `warning: 'bro <name>' is deprecated — <advice>` before running, so
  deprecating a command is a registry field, not a code change. The
  field joins `PLUGIN_FIELD_CHECKS` — external plugins get the seam too.
  Authors pair it with `hidden: true` to drop the command from
  `--help` while it still works.
- **Flag/verb level** — `warnDeprecated(what, advice?)` in
  `@broject/core` owns the line format; commands deprecating flags call
  `deprecatedFlag(argv, '--old', advice)` (args.ts), deprecated doc
  verbs call `warnDeprecated` inside the adapter method — no schema
  grows for a one-release shim.

### The policy

CONTRIBUTING.md gains a **Stability & deprecations** section: pre-1.0
may break, but removal is two releases — first ships the deprecation
warning (command keeps working), the next may remove. Deprecations and
removals land in CHANGELOG.md via the conventional-commit subject
(`deprecate:`/`feat!:`).

Non-goals: no sunset scheduling automation, no removal enforcement, no
projected-changelogs (lockstep versioning makes them noise).

## Plan

- [ ] `nx.json` workspace changelog config + `release.yml` changelog step
- [ ] seed `CHANGELOG.md` for v0.1.0–v0.2.3 via `nx release changelog`
- [ ] `core`: `deprecation.ts` (`warnDeprecated`) + export;
      `plugin.ts` `deprecated?: string` field
- [ ] `cli`: dispatch warning in index.ts; `deprecated` field check in
      plugins.ts; `deprecatedFlag` in commands/args.ts
- [ ] CONTRIBUTING.md stability/deprecation policy section
- [ ] tests: field validation, `deprecatedFlag` warnings, e2e dispatch
      warning via an external deprecated plugin
- [ ] `npm test` (the CI gate) green

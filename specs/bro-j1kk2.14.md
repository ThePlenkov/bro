# bro-j1kk2.14 — site: What's New — human-readable release notes for 0.3.0

Epic `bro-j1kk2` (`specs/bro-j1kk2/spec.md`) child. Owner ruling:
the release ships as **0.3.0** (supersedes the epic's recorded 1.0.0
decision — recorded on the bead).

## Problem

`CHANGELOG.md` is the canonical ledger — one line per merged PR,
scoped by package, ordered by kind. It is complete and useless as a
"should I upgrade?" answer: ~40 merged PRs of mechanism with no
narrative, no capability grouping, no migration guidance. The site —
which deploys on every merge to main — has no release-notes surface
at all. A reader deciding whether to upgrade gets a git log, not a
story.

## Decision: hand-curated markdown, not generated

`site/content/docs/whats-new.md` — one curated page, wired into
`meta.json` nav (sidebar) plus a landing-page nav link.

Rejected: generating the page from CHANGELOG at build. A generator
reproduces exactly the git-log dump this bead exists to replace —
grouping by capability, naming the reader's benefit, and judging what
deserves prose are editorial acts, not transforms. The generated
command reference (bro-j1kk2.8) already covers mechanical freshness;
What's New is the human layer. Curator duty: each release gets one
section, written before the version tag lands — the same discipline
as the CHANGELOG entry itself. The page is the ledger's narrative
twin, never its replacement: CHANGELOG stays canonical.

## Page shape

One page, newest release first. Per release:

- lead with **what you can now do** — capability groups, not PR
  lists; one group may fold several PRs into a single "you can"
  statement;
- **upgrade notes** — renames, deprecations, removals, config and
  distribution changes, stated plainly;
- PR/bead enumeration stays in CHANGELOG — the page links to docs
  pages and the ledger, not to commits.

Voice: the landing's register — direct, opinionated, capability-first
— aimed at a reader deciding whether to upgrade, not a newcomer.

### 0.3.0 content (merged since the 0.2.5 ledger boundary)

Ledger boundary: CHANGELOG's 0.2.5 section ends around PR #532;
everything from #533/#535 onward is unreleased and belongs to 0.3.0.
Verified against `git log v0.2.5..origin/main` and merged-PR list:

- **Live-tail streaming** — `bro fleet agents log <ref> [--follow]`
  (#536), SSE `GET /api/v1/agents/<ref>/log?follow` (#541), the ACP
  `onUpdate` streaming seam (#555).
- **Serve becomes a plane catalog** — REST `/api/v1/planes*` (#562),
  `/ui` index-driven dashboard (#563), SSE `/api/v1/events/stream` +
  `asyncapi.json` (#564); the ACP conductor `/v1/messages` over
  `devin acp` re-landed — one retained session per client
  conversation (#553, #569), image blocks on the wire (#558).
- **The rig engine** — `bro queue` frame intake (#545), drill
  `park|wake|waiting` (#546), spawn mints the worktree as one
  transition with `bro fleet agents up` (#547), `bro rig next` the
  stateless re-entry verdict (#548), loop/drive re-entry folded onto
  it (#551). Design: `/docs/design/rig-engine`.
- **Human sign-off in the merge gate** — `act.requireApproval` (#561).
- **CLI** — `flatDeprecated`, the per-name flat-spelling retirement
  knob (#557); grouped `bro <group> <member>` stays canonical, no
  name retired yet.
- **Site/docs** — landing rewrite (#543), glossary (#538), generated
  command reference (#542), design section + specs curation (#550).
- **Distribution** — `@theplenkov/bro` deprecated on npm;
  `@broject/bro@<major>` pins now derive from the plugin's own
  version (#549).
- Also notable: `bro status` stale-checkout drift row (#560), the
  devin read-mostly session plane (#568), the claude-plugin dogfood
  scenario (#571).

Excluded from prose: internal fixes, test-only PRs, CI bumps — they
stay ledger material.

## Nav wiring

- `site/content/docs/meta.json` — `whats-new` in the "Start here"
  section, after `why-bro`.
- `site/src/routes/index.tsx` — `what's new` link in the landing
  `<nav>` next to `docs`.

## Verify

- `cd site && npm run build` — CI's site.yml gate is `npm ci &&
  npm run build`; the vite build + prerender must succeed and crawl
  the new page.
- `/docs/whats-new` resolves and appears in the serialized page tree
  (the meta.json entry is the assertion; prerender output confirms).

## Non-goals

- Backfilling 0.2.x sections — the section-per-release convention
  starts with 0.3.0; older releases stay ledger-only.
- Cutting the release, bumping `plugin.json`, or generating anything.
- Closing the bead or merging without the act gate.

# bro-uq6ou — auto-bump homebrew tap formula on release tag

## Problem

`Formula/bro.rb` in ThePlenkov/homebrew-brew is bumped by hand after every
release — url + sha256 of the tag tarball, version derived from the url.
Missed bumps ship stale `brew install bro`.

## Design

`.github/workflows/homebrew.yml`, mirroring publish.yml's dispatch shape:

- Triggers: `push: tags: ['v*']` (human-pushed tags only — a GITHUB_TOKEN
  tag push fires no events) + `workflow_dispatch(tag=)` for backfill.
  release-tag.yml dispatches it on main right after the publish dispatch —
  same reasoning as publish.yml: latest workflow file, tag selects the
  payload.
- Bump: fetch the codeload tarball for the tag (retry — archives are
  rendered on first request), sed `url`/`sha256` in Formula/bro.rb on a
  ThePlenkov/homebrew-brew checkout, commit `bro <v>`, push to main.
  Idempotent: no diff → no push.
- Auth: the tap is a separate repo — GITHUB_TOKEN can't write it. Every
  step is gated on `secrets.HOMEBREW_TAP_TOKEN` (fine-grained PAT,
  contents:write on ThePlenkov/homebrew-brew). Absent → `::warning::` on
  the run and the release stays green: the formula is bumped by hand
  until the secret exists. The setup line lives in the workflow header.

## Deferred

- npm-tarball install — **done in bro-0opqd**: the formula now installs
  the published `@broject/bro` tarball (`npm install *std_npm_args`), and
  homebrew.yml orders itself after publish.yml by polling the registry
  for the version before computing sha256.

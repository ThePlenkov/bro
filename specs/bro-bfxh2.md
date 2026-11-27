---
parent: project
---

# bro-bfxh2 — importing external skills

## Problem

`bro skills` already delegates installation to the `skills` CLI, but a
`github:owner/repo/path` source is not a resolver contract: it can follow a
moving default branch and its install is not explicitly tied to the path
requested by the bro project. External skills must remain read-only inputs,
must be installed through `.agents/skills/`, and must be reproducible.

## Design

The first slice resolves `github:owner/repo[/path]` by resolving the
repository's default branch to its current commit SHA at add time, then
delegating the fetch/materialisation to the existing pinned `skills` CLI
seam. The resulting `skills-lock.json` is authoritative; its `ref` is the
resolved commit and existing hash/drift checks remain in force. No source is
copied into bro's `skills/` tree and no upstream files are modified.

Source parsing remains strict and rejects traversal. Slice 2 implements an
explicit marketplace source: `marketplace:owner/repo#entry`. The fragment is
the catalog entry name (not a branch or ref). Bro resolves the repository
default branch to a full SHA, reads `.claude-plugin/marketplace.json` first
and `.agents/plugins/marketplace.json` second at that SHA, then delegates the
selected entry's repository path to the same pinned `github:` resolver. The
manifest is read-only and is never copied into bro. Claude entries use their
`source` path; Codex entries may additionally list a matching path in
`skills`, which is selected when present. A missing or malformed entry fails
loudly. The private `theplenkov-ai/skills` repository requires the normal
GitHub credential seam; acceptance can use the public `ThePlenkov/skills`
mirror when private access is unavailable.

## Verify

- Unit tests cover source resolution, SHA pinning, path forwarding, invalid
  sources, marketplace entry selection, and failure to resolve a ref.
- A scratch project runs `bro skills add github:ThePlenkov/skills/...` against
  a real public skill and verifies that only `.agents/skills/` and the lock
  are changed, with a full commit SHA recorded.
- Run the CLI skills tests, package typecheck, build, and generated-artifact
  freshness checks.

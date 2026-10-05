---
parent: project
---

# distro — distribution: npm, packs, releases, site

## Scope

The `@broject/*` scope on npm, `bro-pack` for `bro setup --pack`,
generated plugin adapters (devin/claude/codex/cursor), Nx release + publish
preflight, curated GitHub release notes, badges, broject.dev.

## Owns

```text
packages/pack/                       @broject/bro-pack
nx.json, scripts/gen-plugins.ts, scripts/gen-embedded.ts
.github/workflows/{release,release-tag,publish}.yml
site/, plugin.json, .claude-plugin/, .agents/plugins/, .cursor-plugin/
plugins/*/bro/                         generated client adapters
```

# bro-2nb6t — omp distribution: marketplace catalog → bro@theplenkov

## Problem

bro must distribute through omp's marketplace with the install ID
`bro@theplenkov` (user scope by default, project scope to override
per-project), and the bro repo must carry the catalog that makes that
ID resolvable. Today the only artifact is the ad-hoc local catalog
named `bro` in the operator's `marketplaces.json` — nothing in the repo
another machine could add.

omp's own mechanics (omp.sh/docs/plugins) already answer the local-vs-
global split, so no adapter code is involved:

- marketplace installs honor `--scope user` (default, all projects) and
  `--scope project` (recorded in the project's
  `.omp/plugins/installed_plugins.json`; the project copy **shadows**
  the user copy of the same `name@marketplace`);
- a local-directory install is a **symlink** into the user plugin
  directory with live edits — `--scope` is ignored for it, so it is the
  global-live dev tool, not a per-project one.

(PR #662 tried to grow this rule into adapter code — cwd-based
devAdapter delegation — and was withdrawn: strix HIGH on executing a
module from the session cwd, and omp already provides the semantics.)

## Design

`.omp-plugin/marketplace.json` committed at the repo root — the
preferred catalog path git/local sources read:

- top-level `name: "theplenkov"` — the catalog's name is the
  marketplace name, so the entry installs as `bro@theplenkov`;
- one entry, `bro` → `source: "./plugins/omp/bro"` (the omp payload
  directory — its package.json carries `omp.extensions`; the repo root
  manifest is the portable Agent-Plugin surface, not the omp plugin);
- `version` mirrors `plugin.json`/`plugins/omp/bro/package.json` (0.2.5)
  until the release pipeline owns the bump.

The generated omp README's Install section documents the three
receipts: marketplace add + user install, project-scope shadowing, and
the symlink live-dev loop.

## Plan

- [x] `.omp-plugin/marketplace.json` (name theplenkov, entry bro)
- [x] omp README Install section (gen-plugins template): marketplace
      add/install, --scope project shadowing, symlink dev loop
- [x] verify: catalog JSON parses + fields match the working catalog
- [x] PR stacked on feat/bro-omp-complete (the source path resolves
      there; lands with the adapter line)

---
parent: project
---

# bro-20zdl — toolkit site and connector marketplace

## Problem

The landing page presents one CLI even though bro is a toolkit: a core,
connector seams, policy skills and portable client packaging. Package
discovery needs a catalog tied to shipped code, not another prose list.

## Design

Owns: `site/`, package `bro` metadata in `packages/*/package.json`,
`scripts/package-metadata.ts`, `scripts/check-docs.ts`.

- `/` is the toolkit hub: four product cards, marketplace strip and the
  existing “bro writes bro” dogfood block. `/cli` retains the lifecycle
  closure wedge, interactive Terminal and Install. `/skills` covers policy,
  CLI mechanics, hooks/guard, packs and lock. `/plugins` covers one portable
  Agent Plugin packaged for clients and the separate Claude-on-other-agents
  plugin. `/brouter` presents an independent AI-native task router: user-authored
  Markdown routing formulas, configured agents, outcome feedback and the
  bare-agent versus agent+bro benchmark. It routes tasks, not LLM requests.
- Product copy presents the finished toolkit in the present tense. The global
  WIP banner owns the evolving-product caveat; catalog badges retain their
  metadata status. Product pages do not hedge with publication, source-build
  or roadmap disclaimers. Examples use the user interface: `npm i -g @broject/bro`,
  `npx @broject/bro`, `bro router`, standalone `npm i @broject/brouter`, and client
  plugin installation. No site example invokes internal scripts or dist files
  with Node. This presentation contract does not implement new CLI mechanics.
- A shared navigation component links products, docs, marketplace and GitHub.
  A non-dismissible work-in-progress banner lives in the root shell and is
  visible on every page, including docs and debt. Preserve the dark theme,
  responsive cards, keyboard links and readable status labels.
- Each workspace package declares `bro: { kind, status, facade? }`. `kind`
  is `core | capability | connector`; `status` is `stable | beta | planned`.
  A connector requires a nonempty facade identifier. Existing public
  packages are conservatively beta; private packages have metadata but are
  consistently excluded. Core/command/CLI are core, workflow packages are
  capabilities, vendor/protocol bindings are connectors.
- Vite generates the marketplace module at build time by reading package
  manifests. Cards show package name, manifest description, status, npm and
  source links. Connectors group by facade; capabilities and core have their
  own sections. No registry/runtime network request is needed. Planned items
  without a package live in one `site/planned-connectors.json`, show no npm
  package yet and link to their current source or design. Beads and native/
  speckit/openspec adapters remain embedded today, not standalone packages.
- The same metadata validator runs in the catalog build and check-docs;
  missing/invalid public metadata fails loudly. Planned rows are validated
  too. Facade identifiers use lowercase letters and hyphens, starting with a
  letter. Empty groups are omitted; missing package descriptions are errors.
  Every new page is explicitly prerendered and linked for crawl discovery.
  Package/plugin docs explain the toolkit and point to the generated catalog.

## Verify

- Test valid, absent and invalid metadata, connector facades and catalog
  generation (including exclusion of private packages and planned entries).
- Site build and typecheck; root typecheck; check-docs; diff check; commit
  hooks. Confirm prerendered HTML for all six new/updated entry pages.
- Preview full-page screenshots of `/`, `/brouter`, `/marketplace`, `/docs`;
  verify the root banner, layout, finished-product copy and catalog status cards.
  Save evidence outside the repo. Leave the local preview running.

# @broject/bro-pack

[![npm](https://img.shields.io/npm/v/@broject/bro-pack)](https://www.npmjs.com/package/@broject/bro-pack)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

The capability pack for `bro` — skills, agent adapters and bead formulas
shipped as a versioned npm package. `bro setup --pack` installs them into
`.agents/skills/` — plus `.beads/formulas/` when beads is enabled.

## Usage

```bash
npx @broject/bro setup --pack            # default pack: @broject/bro-pack
npx @broject/bro setup --pack <name>     # an alternate capability pack
```

The CLI resolves packs from the project's own `node_modules` first, then
its installation tree — pinning the pack version pins your agents'
capabilities.

Part of https://github.com/ThePlenkov/bro

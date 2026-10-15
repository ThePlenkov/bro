# bro-j1kk2.5 — glossary page

One line per concept. The site uses bro vocabulary everywhere (bead, mol,
convoy, act, debt, drill, wtf, rig, pulse…) with no place that defines
it. A reader hitting "pour a molecule" in `plans.md` or "the act gate"
in `why-bro.md` has nowhere to land.

## Scope

- New page `site/content/docs/glossary.md`, registered in
  `site/content/docs/meta.json` under the **Start here** section (after
  `why-bro`) — it is orientation material, not a command reference.
- Term list: the vocabulary the site and skills actually use —
  - beads side: bead, molecule/mol, formula, proto, wisp, gate, ready,
    claim
  - orchestration: convoy, fleet, rig, loop, drive, watch, pulse,
    daemon, stack, mesh, notify/mailbox
  - review & quality: act, debt, judge, guard, drill, retro, wtf, learn,
    sdd, sweep, dogfood
  - planes: connector, agent plane/backend, worktree (`bro work`),
    serve, status, trace, sync/restore, hook, skill, plugin
- Format: grouped sections, `**term** — one line` entries. One line
  means one line — the page is a lookup, not a tutorial; depth belongs
  on the concept's own doc/command page, linked where one exists.
- Tone: plain mechanism statements ("a molecule is the persistent
  instantiation of a formula"), matching `why-bro.md` voice — no
  marketing adjectives.

## Acceptance

- Every concept the bead names is present: bead, mol, convoy, loop,
  drive, fleet, rig, pulse, act, debt, drill, wtf.
- Page renders in the docs nav (meta.json entry).
- No term definition contradicts its skill `description:` or the
  convoy skill's canonical formula→molecule model.

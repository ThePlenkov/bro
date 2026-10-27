---

## parent: bro-36sx7

# bro-36sx7.5 — devin: drop duplicate .devin/hooks.v1.json chain + doctor duplicate-wiring check

## Problem

Devin can wire bro's lifecycle hooks twice: the installed `bro`
plugin registers every event from `plugins/devin/bro/hooks.json`,
and a project-local `.devin/hooks.v1.json` registers the same events
against `$DEVIN_PROJECT_DIR/hooks/run.sh`. This repo carries both.
Before this bead's defer landed (#708) every Devin event ran two
`run.sh` launchers that fought over the same state — the user saw
doubled `Hook failed … timed out` failures. After it, the plugin
copy still _spawns_ and exits early per event — pure launcher
overhead on the path this epic exists to make free.

The committed `.devin/hooks.v1.json` predates the plugin packaging.
The plugin is now the maintained Devin wiring; the file is a
duplicate chain. The same state can regress anywhere — doctor needs
the check that names it.

## Design

- **Drop `.devin/hooks.v1.json`.** The plugin's `hooks.json` remains
  the single Devin wiring (user-scope install resolves `bro` from
  the local checkout; run.sh then resolves dist→PATH as usual). The
  project-chain defer in `hooks/run.sh` stays: other repos may still
  carry a project chain, and the defer keeps them single-firing
  until they drop it.
- **`bro doctor` `hooks-wiring` row** — duplicate wiring is
  machine+repo state: a project-local bro chain plus a resolved
  `bro` plugin both register Devin's hook events. Warn when
  `.devin/hooks.v1.json` exists **and** contains a bro chain
  signature (`hooks/run.sh` or `bro hooks` — a foreign-tool chain
  does not collide with the plugin) **and** Devin's plugin lockfile
  (`$XDG_DATA_HOME/devin/cli/plugins/lock.json`, `~/.local/share`
  fallback — the same base derivation `devinLocksDir` uses) resolves
  an entry named `bro` (any source). File absent → ok; chain present
  with no resolved plugin → ok — a lone project chain is legitimate
  wiring. Advisory like the rest of doctor: warn, never fail.

## Plan

- [x] delete `.devin/hooks.v1.json`
- [x] `hooks-wiring` doctor check + tests (bro chain + resolved
  plugin → warn; file absent, non-bro chain, or plugin absent
  → ok)
- [x] pin `XDG_DATA_HOME` in the doctor fixture so the lockfile
  probe stays hermetic

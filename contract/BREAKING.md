# CLI breaking changes — announcement ledger

`bro contract` freezes the machine-readable CLI surface in
`contract/cli.json`. A change that removes or respells an invocation —
a command, a group, a subcommand, a flag, an exit code, or a
`group`/`aliasOf`/`argvPrefix` reroute — is breaking and only passes
`npm run check:contract` when a bullet below names it.

Format — one bullet per breaking change:

```text
- <command-or-dotted-path> — reason
```

Paths are the canonical ones the check prints: a command is `<name>`,
a group `groups.<g>`, inside a command
`<name>.contract|.group|.aliasOf|.argvPrefix|.json` or
`<name>[.subs.<s>].flags.<f>|.exits.<e>`. Announcing a command covers
everything under it. Announced removals move to the `removed` map in
`cli.json` on `npm run gen:contract`; every tombstone must keep its
bullet here — the ledger cannot be quietly edited around. The reverse
holds too: a bullet that covers no pending removal and no tombstone is
a permanent hall-pass on that path — the gate rejects it, so spent
bullets get deleted.

`deprecated:`/`flatDeprecated:` additions are NOT breaking — a soft
removal is itself the announcement.

## Changes

- delegate.exits.2 — usage errors exit 1 today; the documented 2 was aspirational, the table now documents reality

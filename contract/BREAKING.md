# CLI breaking changes — announcement ledger

`bro contract` freezes the machine-readable CLI surface in
`contract/cli.json`. A change that removes or respells an invocation —
a command, a group, a subcommand, a flag, an exit code, or a
`group`/`aliasOf` reroute — is breaking and only passes
`npm run check:contract` when a bullet below names it.

Format — one bullet per breaking change:

```
- <command-or-dotted-path> — reason
```

Paths are the canonical ones the check prints: a command is `<name>`,
a group `groups.<g>`, inside a command
`<name>.contract|.group|.aliasOf|.json` or
`<name>[.subs.<s>].flags.<f>|.exits.<e>`. Announcing a command covers
everything under it. Announced removals move to the `removed` map in
`cli.json` on `npm run gen:contract`; every tombstone must keep its
bullet here — the ledger cannot be quietly edited around.

`deprecated:`/`flatDeprecated:` additions are NOT breaking — a soft
removal is itself the announcement.

## Changes

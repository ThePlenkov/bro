# @broject/github

The GitHub connector for `bro` — the `reviews` facade (PR state, threads,
checks, merge) implemented over the `gh` CLI. Registers like any
connector: built-in today, but nothing GitHub-specific lives in core.

> You probably want the CLI instead — `bro` ships this connector already.
> Install this only when writing a `reviews` backend for another forge.

## Install

```bash
npm i @broject/github
```

Requires Node ≥ 22 and an authenticated `gh`. ESM only.

## Surface

- `githubReview` — threads, checks, review state, merge ops over `gh`
- `githubConnector` — the `Connector` impl registered into bro
- Enterprise hosts resolve via `connectors.reviews` config

## Links

- Docs: https://broject.dev/docs
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/github
- CLI: https://www.npmjs.com/package/@broject/bro

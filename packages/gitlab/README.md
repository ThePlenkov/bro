# @broject/gitlab

[![npm](https://img.shields.io/npm/v/@broject/gitlab)](https://www.npmjs.com/package/@broject/gitlab)

The GitLab connector for `bro` — the `reviews` facade (MR state, threads,
checks, merge) implemented over the `glab` CLI. Registers like any
connector: built-in today, but nothing GitLab-specific lives in core.

> You probably want the CLI instead — `bro` ships this connector already.
> Install this only when writing a `reviews` backend for another forge.

## Install

```bash
npm i @broject/gitlab
```

Requires Node ≥ 22 and an authenticated `glab`. ESM only.

## Surface

- `gitlabReview` — threads, checks, review state, merge ops over `glab`
- `gitlabConnector` — the `Connector` impl registered into bro
- gitlab.com auto-detects from the origin remote; self-hosted instances
  resolve via `connectors.reviews` config

## Links

- Docs: https://broject.dev/docs
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/gitlab
- CLI: https://www.npmjs.com/package/@broject/bro

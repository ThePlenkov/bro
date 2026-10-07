# @broject/judge

[![npm](https://img.shields.io/npm/v/@broject/judge)](https://www.npmjs.com/package/@broject/judge)

The calibrated decision judge behind `bro judge` and `bro act threads`
shadow annotation — the provider-chain `decide()`, fallback escalation,
the verdict journal, and the stats/replay reports that score
judge-vs-outcome agreement.

> You probably want the CLI instead: `bro judge decide` smokes the
> resolved chain. Install this only when building a consumer that needs
> typed judgments.

## Install

```bash
npm i @broject/judge
```

Requires Node ≥ 22. ESM only.

## Surface

- `judgeFacade` / `judgeConfig` — the resolved chain over the `providers` registry
- `computeStats` / `formatStats` — agreement matrix, calibration buckets, latency and cost
- `replayMergedThreads` — re-judge archived review threads from merged PRs
- `appendRow` / `readJournal` — the verdict journal

## Links

- Docs: https://broject.dev/docs/commands/judge
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/judge
- CLI: https://www.npmjs.com/package/@broject/bro

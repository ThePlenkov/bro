/** `bro react <target> <how>` — record a reaction on a review artifact. */
import { ensureAuth, type PrTarget, type ReactionKind, reviewHost } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';

const KINDS = new Set<ReactionKind>(['+1', '-1', 'thumbs_up', 'thumbs_down', 'eyes']);

function target(rev: ReturnType<typeof reviewHost>, raw: string): PrTarget | string {
  const parsed = rev.parsePrRef(raw);
  if (parsed) return parsed;
  const shorthand = /^#?(\d+)$/.exec(raw);
  if (shorthand) return { repo: rev.resolveRepo([]), pr: Number(shorthand[1]) };
  return raw;
}

function parseArgs(argv: string[]): { rawTarget: string; kind: ReactionKind } {
  const [rawTarget, rawKind] = argv.filter(arg => !arg.startsWith('--'));
  if (!rawTarget || !rawKind) {
    throw new Error(
      'Usage: bro react <target> <+1|-1|thumbs_up|thumbs_down|eyes> [--remove] [--json]'
    );
  }
  if (!KINDS.has(rawKind as ReactionKind)) {
    throw new Error(
      'Usage: bro react <target> <+1|-1|thumbs_up|thumbs_down|eyes> [--remove] [--json]'
    );
  }
  return { rawTarget, kind: rawKind as ReactionKind };
}

type ReactResult = NonNullable<ReturnType<NonNullable<ReturnType<typeof reviewHost>['react']>>>;

const FORMATTERS: Array<{ flag: string; format: (result: ReactResult) => string }> = [
  { flag: '--json', format: result => JSON.stringify(result) },
  {
    flag: '--tsv',
    format: result =>
      `${result.artifact}\t${result.reaction}\t${result.removed ? 'removed' : 'applied'}`,
  },
];

function printResult(result: ReactResult, argv: string[]): void {
  const formatter =
    FORMATTERS.find(candidate => argv.includes(candidate.flag))?.format ??
    ((value: ReactResult) => `${value.reaction} applied to ${value.artifact}`);
  console.log(formatter(result));
}

export function runReactCommand(argv: string[]): void {
  const { rawTarget, kind } = parseArgs(argv);
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  if (!rev.react) throw new Error('the configured review host does not support reactions');
  const result = rev.react(target(rev, rawTarget), kind, argv.includes('--remove'));
  printResult(result, argv);
}

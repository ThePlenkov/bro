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

export function runReactCommand(argv: string[]): void {
  const [rawTarget, rawKind] = argv.filter(arg => !arg.startsWith('--'));
  if (!rawTarget || !rawKind || !KINDS.has(rawKind as ReactionKind)) {
    throw new Error(
      'Usage: bro react <target> <+1|-1|thumbs_up|thumbs_down|eyes> [--remove] [--json]'
    );
  }
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  if (!rev.react) throw new Error('the configured review host does not support reactions');
  const result = rev.react(
    target(rev, rawTarget),
    rawKind as ReactionKind,
    argv.includes('--remove')
  );
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result));
  } else if (argv.includes('--tsv')) {
    console.log(
      `${result.artifact}\t${result.reaction}\t${result.removed ? 'removed' : 'applied'}`
    );
  } else {
    console.log(`${result.reaction} applied to ${result.artifact}`);
  }
}

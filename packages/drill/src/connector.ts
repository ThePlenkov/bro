/**
 * The drill connector — open-frame state for the agent lifecycle: the
 * frame line at session start and prompt submit, and the stop-gate
 * contribution under the 'drill' arming aspect.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beadsStoreStampAsync, GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDirAsync } from '@broject/core';
import type { Connector, ConnectorCtx } from '@broject/core';
import { currentFrameAsync } from './frames.ts';
import type { DrillFrame } from './types.ts';

/** `<git-common>/bro/hooks` — the shared state dir every hook surface
 *  writes into, on the canonical async probe (spec bro-36sx7.2 — the
 *  inline rev-parse copy was a spawnSync inside the sweep). null
 *  off-repo. */
async function hooksDirAsync(dir: string): Promise<string | null> {
  const common = await gitCommonDirAsync(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return common === null ? null : join(common, 'bro', 'hooks');
}

// --- open-frame snapshot ------------------------------------------------------
// The hook launcher's shell fast-path (spec: specs/bro-arm83.md) cannot
// read the bead store, so the probe leaves its answer behind keyed on the
// same write barometer learn uses: {"frame":null} means "verified no open
// frame at this manifest" — the shell skips Node only on that proof.
// Caching the answer also skips two bd spawns inside Node on every hit.
interface DrillSnapshot {
  stamp: string;
  frame: DrillFrame | null;
}

const snapshotFile = (hooks: string): string => join(hooks, 'cache', 'drills.json');

async function currentFrameCachedAsync(
  dir: string,
  hooks: string
): Promise<DrillFrame | undefined> {
  const stamp = await beadsStoreStampAsync(dir);
  const file = snapshotFile(hooks);
  if (stamp !== null) {
    try {
      const snap = JSON.parse(readFileSync(file, 'utf8')) as DrillSnapshot;
      if (snap.stamp === stamp) {
        return snap.frame ?? undefined;
      }
    } catch {
      // absent or torn snapshot — refresh below
    }
  }
  const frame = await currentFrameAsync(dir);
  if (stamp === null) {
    return frame; // no recognizable store — nothing to key the snapshot on
  }
  try {
    // tmp+rename — a racing hook process can observe the file
    // mid-write; a torn snapshot just re-reads live next time
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ stamp, frame: frame ?? null } satisfies DrillSnapshot));
    renameSync(tmp, file);
  } catch {
    // a lost snapshot costs one extra subprocess next probe — never a stall
  }
  return frame;
}

/** The open-frame line, or null — the same text every surface shares.
 *  Async: the frame lookup is two bd spawns that would serialize and
 *  freeze the probe sweep in sync form. */
async function frameLine(ctx: ConnectorCtx): Promise<string | null> {
  try {
    const hooks = await hooksDirAsync(ctx.dir);
    const frame =
      hooks === null
        ? await currentFrameAsync(ctx.dir)
        : await currentFrameCachedAsync(ctx.dir, hooks);
    if (!frame) {
      return null;
    }
    return `drill frame open: ${frame.id} "${frame.title}" [depth=${frame.depth}] — close with \`bro drill up --result "…"\``;
  } catch {
    return null;
  }
}

export const drillConnector: Connector = {
  name: 'drill',
  hooks: () => ({
    async sessionStart(ctx) {
      const line = await frameLine(ctx);
      return line ? [line] : [];
    },
    async promptSubmit(ctx) {
      const line = await frameLine(ctx);
      return line ? [line] : [];
    },
    async stopGate(ctx) {
      const line = await frameLine(ctx);
      if (!line) {
        return [];
      }
      return [
        {
          aspect: 'drill',
          block: `bro: ${line}`,
          passive: `bro: ${line} (opened outside this session — informational)`,
        },
      ];
    },
  }),
};

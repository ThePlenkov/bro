/**
 * `bro skills` spawn plane — resolving the skills CLI binary and
 * running it (POSIX direct, Windows through ComSpec with quoted argv).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SkillSource } from './skills-sources.ts';

/** A spawn target — `[file, ...prefixArgs]`: a resolved `skills` bin
 *  runs directly; the default is `npx -y skills@<pin>`. */
export interface SkillsBin {
  file: string;
  args: string[];
  via?: string;
}

/** The npx fallback package — pinned (a bare `skills` spec would
 *  execute whatever the registry serves that day); skills.bin or a
 *  PATH install overrides it. */
const SKILLS_PKG = 'skills@1.7.4';

export type SpawnRunner = (
  bin: SkillsBin,
  root: string,
  args: string[]
) => SpawnSyncReturns<string>;

export type BinProbe = (cmd: string) => boolean;

/** Resolution: `skills.bin` (a path with a separator, else a PATH
 *  command) → `skills` on PATH → `npx -y skills@1.7.4`. The npx fallback
 *  needs no probe — npx is the documented invocation and resolves the
 *  package on demand. `probe` is injectable so tests never touch the
 *  real PATH. */
export function resolveSkillsBin(
  root: string,
  cfgBin?: string,
  probe: BinProbe = commandOnPath
): SkillsBin {
  if (cfgBin !== undefined) {
    if (cfgBin.includes('/') || cfgBin.includes(sep)) {
      const p = isAbsolute(cfgBin) ? cfgBin : resolve(root, cfgBin);
      return { file: p, args: [], via: 'config' };
    }
    return { file: cfgBin, args: [], via: 'config' };
  }
  if (probe('skills')) {
    return { file: 'skills', args: [], via: 'path' };
  }
  return { file: 'npx', args: ['-y', SKILLS_PKG], via: 'npx' };
}

/** One argv element quoted for `cmd.exe /d /s /c` — every metachar
 *  caret-escaped so a configured path or source string can never turn
 *  into a second command. */
function cmdQuote(arg: string): string {
  return `"${arg.replace(/[%^&|<>()"]/g, '^$&')}"`;
}

/** Windows can't exec `.cmd`/`.bat` (npx's own shim!) or a bare PATH
 *  command without the interpreter — route through ComSpec with every
 *  argument quoted; POSIX spawns stay direct. */
function spawnTarget(file: string, args: string[]): { file: string; args: string[] } {
  const needsCmd =
    /\.(cmd|bat)$/i.test(file) ||
    (process.platform === 'win32' && !/\.(exe|com)$/i.test(file) && !file.includes('/'));
  if (process.platform !== 'win32' || !needsCmd) {
    return { file, args };
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', cmdQuote(file), ...args.map(cmdQuote)],
  };
}

function spawnArgv(file: string, args: string[], cwd?: string): SpawnSyncReturns<string> {
  const t = spawnTarget(file, args);
  return spawnSync(t.file, t.args, {
    // NOSONAR — npx/PATH lookup is the contract (gh/bd precedent)
    cwd,
    stdio: cwd === undefined ? 'pipe' : undefined,
    encoding: 'utf8',
    // the CLI's interactive UI is verbose — headroom; -y skips prompts
    maxBuffer: 64 * 1024 * 1024,
    // a restore re-clones every locked repo — bounded, never infinite
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** A bare command on PATH? The probe is `cmd --version` — present and
 *  runnable wins; spawn errors and non-zero exits read as absent. */
export function commandOnPath(cmd: string): boolean {
  const proc = spawnArgv(cmd, ['--version']);
  return proc.error === undefined && proc.status === 0;
}

export const spawnSkills: SpawnRunner = (bin, root, args) =>
  spawnArgv(bin.file, [...bin.args, ...args], root);

export function addArgs(src: SkillSource & { kind: 'github' | 'url' }, agents: string[]): string[] {
  const pkg = src.kind === 'url' ? src.url : src.repo;
  const args = ['add', pkg];
  if (src.kind === 'github' && src.skill !== undefined) {
    args.push('-s', src.skill);
  }
  for (const a of agents) {
    args.push('-a', a);
  }
  args.push('-y');
  return args;
}

/** The skills CLI's own verdict for a spawn — the process ran and
 *  reported a status (spawn errors surface as `error`, not status). */
export function spawnFailed(proc: SpawnSyncReturns<string>): boolean {
  return proc.error !== undefined || (proc.status ?? 1) !== 0;
}

export function spawnDetail(proc: SpawnSyncReturns<string>): string {
  const tail = (proc.stderr ?? proc.stdout ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-2)
    .join(' — ');
  return proc.error?.message ?? (tail !== '' ? tail : `exit ${proc.status}`);
}

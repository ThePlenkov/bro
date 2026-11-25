/** Docker-specific mount, descriptor, and launch argument helpers. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  gitTry,
  SpawnError,
  type AgentInfo,
  type AgentRegistryEntry,
  type SpawnSpec,
} from '@broject/core';
import { jsoncToJson } from './docker-jsonc.ts';
import { dockerContainerName, dockerInspect, type DockerLiveness } from './docker-basic-harness.ts';
import {
  agentEnvPins,
  entryRunId,
  envKeyDropped,
  GIT_REPOSITORY_ENV_KEYS,
  getCredentialScope,
  infoCause,
  infoLearn,
  infoProvenance,
  isAllowedByEnvPolicy,
  probeState,
  writePrivateFileSync,
  type AgentConnectorEnv,
} from './spawn-harness.ts';
import { dockerRun } from './docker-basic-harness.ts';

export interface DockerMount {
  source: string;
  target: string;
}

export function dockerMounts(spec: SpawnSpec): DockerMount[] {
  const mounts: DockerMount[] = [];
  const add = (p: string): void => {
    const target = resolve(p);
    let source = target;
    try {
      source = realpathSync(target);
    } catch {
      // not created yet — docker will create the source root-owned,
      // which is the operator's path to give
    }
    if (
      target !== '' &&
      !mounts.some(m => target === m.target || target.startsWith(`${m.target}/`))
    ) {
      mounts.push({ source, target });
    }
  };
  add(spec.repoRoot);
  const r = gitTry([
    '-C',
    spec.repoRoot,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (r.code === 0) {
    add(r.out.trim());
  }
  add(spec.beadsDir);
  return mounts;
}

export interface Devcontainer {
  image?: unknown;
  build?: { dockerfile?: unknown; dockerFile?: unknown; context?: unknown; args?: unknown };
  dockerComposeFile?: unknown;
}

/** The devcontainer path — `agents.docker.devcontainer` if set (repo-
 *  relative or absolute), else the conventional location. */
export function devcontainerPath(spec: SpawnSpec, knobs: Record<string, unknown>): string {
  const kDc = knobs.devcontainer;
  if (typeof kDc !== 'string' || kDc.trim() === '') {
    return join(spec.repoRoot, '.devcontainer', 'devcontainer.json');
  }
  return isAbsolute(kDc) ? kDc : join(spec.repoRoot, kDc);
}

/** The parsed devcontainer — JSONC first (comments/trailing commas are
 *  legal there), a parse failure names the file as a 'config' error. */
export function readDevcontainer(dcPath: string): Devcontainer {
  if (!existsSync(dcPath)) {
    throw new SpawnError(
      `no image configured — set agents.docker.image or provide ${dcPath} with an "image" or "build.dockerfile"`,
      'config'
    );
  }
  try {
    const v = JSON.parse(jsoncToJson(readFileSync(dcPath, 'utf8'))) as unknown;
    return typeof v === 'object' && v !== null ? (v as Devcontainer) : {};
  } catch (err) {
    throw new SpawnError(
      `${dcPath} is not parseable devcontainer JSON — ${err instanceof Error ? err.message : String(err)}`,
      'config'
    );
  }
}

/** `build.dockerfile`/`dockerFile`, resolved against the devcontainer's
 *  directory — a compose-only or absent-build config is a named gap,
 *  never a silent fallback. */
export function devcontainerDockerfile(dcPath: string, dc: Devcontainer): string {
  const b = dc.build;
  let df: string | undefined;
  if (typeof b?.dockerfile === 'string' && b.dockerfile !== '') {
    df = b.dockerfile;
  } else if (typeof b?.dockerFile === 'string' && b.dockerFile !== '') {
    df = b.dockerFile;
  }
  if (df === undefined) {
    const hint =
      dc.dockerComposeFile !== undefined
        ? 'dockerComposeFile devcontainers are not supported — set agents.docker.image'
        : 'set agents.docker.image or give the devcontainer an "image" or "build.dockerfile"';
    throw new SpawnError(`no usable image in ${dcPath} — ${hint}`, 'config');
  }
  const dockerfile = isAbsolute(df) ? df : join(dirname(dcPath), df);
  if (!existsSync(dockerfile)) {
    throw new SpawnError(`devcontainer dockerfile ${dockerfile} does not exist`, 'config');
  }
  return dockerfile;
}

/** Build the devcontainer's dockerfile under a content-keyed tag. The
 *  tag can't see the build CONTEXT's files — but docker's own layer
 *  cache can, so EVERY resolve builds: a no-op build is seconds, a
 *  stale image is a wrong worker. */
export function buildDevcontainerImage(
  dcPath: string,
  dockerfile: string,
  dc: Devcontainer
): string {
  const dcDir = dirname(dcPath);
  const ctxRaw = typeof dc.build?.context === 'string' ? dc.build.context : '.';
  const context = isAbsolute(ctxRaw) ? ctxRaw : join(dcDir, ctxRaw);
  const buildArgs = Object.entries(
    typeof dc.build?.args === 'object' && dc.build.args !== null ? dc.build.args : {}
  ).flatMap(([k, v]) => ['--build-arg', `${k}=${String(v)}`]);
  const tag = `bro-dev-${createHash('sha256')
    .update(readFileSync(dcPath, 'utf8'))
    .update('\n')
    .update(readFileSync(dockerfile, 'utf8'))
    .digest('hex')
    .slice(0, 12)}`;
  const b = dockerRun({
    args: ['build', '-t', tag, '-f', dockerfile, ...buildArgs, context],
    timeoutMs: 600_000,
  });
  if (b.code !== 0) {
    const why = b.err !== '' ? b.err : `exited ${b.code}`;
    throw new SpawnError(`docker build ${dockerfile} failed — ${why}`, 'unavailable');
  }
  return tag;
}

/** Resolved image for a spawn — `agents.docker.image` wins; else the
 *  devcontainer's `image`, else a build of its `build.dockerfile`.
 *  Errors are 'config' (the operator's file/knob is wrong); a failed
 *  BUILD is 'unavailable' (the daemon's). Runs outside the registry
 *  lock — a first-build pays minutes that must not serialize other
 *  spawns. */
export function dockerImageFor(spec: SpawnSpec, knobs: Record<string, unknown>): string {
  const kImage = knobs.image;
  if (typeof kImage === 'string' && kImage.trim() !== '') {
    return ensureDockerImage(kImage.trim());
  }
  const dcPath = devcontainerPath(spec, knobs);
  const dc = readDevcontainer(dcPath);
  if (typeof dc.image === 'string' && dc.image.trim() !== '') {
    return ensureDockerImage(dc.image.trim());
  }
  return buildDevcontainerImage(dcPath, devcontainerDockerfile(dcPath, dc), dc);
}

/** A verbatim image (knob or devcontainer `image:`) must exist BEFORE
 *  `docker run` — an implicit pull inside the registry lock would pay
 *  hundreds of MB behind the 30s run timeout and stall every other
 *  spawn. Inspect is cheap; pull gets the build's 10-minute budget. */
export function ensureDockerImage(image: string): string {
  if (dockerRun({ args: ['image', 'inspect', image] }).code === 0) {
    return image;
  }
  const p = dockerRun({ args: ['pull', image], timeoutMs: 600_000 });
  if (p.code !== 0) {
    const why = p.err !== '' ? p.err : `exited ${p.code}`;
    throw new SpawnError(`docker pull ${image} failed — ${why}`, 'unavailable');
  }
  return image;
}

export function dockerProbeVerdict(entry: AgentRegistryEntry, live?: Set<string>): DockerLiveness {
  const name = dockerContainerName(entry);
  if (live !== undefined) {
    return name !== undefined && live.has(name) ? 'running' : 'dead';
  }
  return name === undefined ? 'dead' : dockerInspect({ name }).live;
}

export function toDockerInfo(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  live?: Set<string>
): AgentInfo {
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    runId: entryRunId(entry),
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    // Running wins (a 'stopped' flag on a still-running container means
    // rm hasn't landed); `--rm` removes the corpse on exit, so the
    // mounted .exit file is the only death record, exactly like native
    state: probeState(dir, home, molStep, entry, dockerProbeVerdict(entry, live)),
    ...infoCause(entry),
    ...infoLearn(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
    stderrLog: typeof entry.stderrLog === 'string' ? entry.stderrLog : undefined,
  };
}

/** Host-bound vars — `--env-file` OVERRIDES the image's own ENV, so a
 *  forwarded PATH/HOME/TMPDIR would shadow the toolchain paths the
 *  image set up (a macOS /opt/homebrew PATH finds nothing inside a
 *  Linux image; HOME=/Users/x breaks npm's cache and the agent CLI's
 *  config/credentials). spec.env is NOT filtered — an explicit knob
 *  is the operator's choice. */
export const DOCKER_HOST_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'OLDPWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'SHLVL',
  '_',
]);

/** Operator runArgs never carry secrets under strict scope — `-e`,
 *  or `--env-file` in runArgs would inject variables the allowlist
 *  excluded (spec bro-l8c4f.6). Dropped with a warning naming only the
 *  flag kinds — a value could be a secret and never reaches the log. */
export const DOCKER_ENV_FLAGS = new Set(['-e', '--env', '--env-file']);

export function filterStrictRunArgs(runArgs: string[], strictEnv: boolean): string[] {
  if (!strictEnv) return runArgs;
  const kept: string[] = [];
  const dropped = new Set<string>();
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i]!;
    const bare = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (DOCKER_ENV_FLAGS.has(bare)) {
      dropped.add(bare);
      // the separate-value form's operand is dropped with the flag —
      // a leaked `KEY=secret` positional would fail docker run anyway
      if (bare === a && i + 1 < runArgs.length) i++;
      continue;
    }
    kept.push(a);
  }
  if (dropped.size > 0) {
    console.error(
      `warning: strict credential scope drops env-passing docker runArgs: ${[...dropped].join(', ')} — route secrets through agents.docker.envAllowlist or spec.env`
    );
  }
  return kept;
}

/** The ambient env file — a 0600 file like tmux's, deleted by the
 *  caller after `docker run` (and on any failure). argv is visible to
 *  every local user (`ps`, `docker inspect`), so the ambient bag
 *  (secrets included) never goes on -e. Values with newlines can't
 *  survive docker's line-based format — dropped with a warning naming
 *  the keys. */

export function writeDockerEnvFile(
  envFile: string,
  spec: SpawnSpec,
  env?: AgentConnectorEnv
): void {
  const dropped: string[] = [];
  const policy = env
    ? getCredentialScope(env, 'docker')
    : { strictEnv: false, envAllowlist: undefined };
  const ambient = Object.entries({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !DOCKER_HOST_ENV.has(k))),
    ...spec.env,
  })
    .filter((e): e is [string, string] => {
      if (
        e[1] === undefined ||
        !/^[A-Za-z_]\w*$/.test(e[0]) ||
        // no tmpdir pin rides into a container (its /tmp is not the
        // host's), so an explicit spec.env TMPDIR passes — ambient TMP*
        // still drop via DOCKER_HOST_ENV above, they would shadow the
        // image's own tmpdir
        envKeyDropped(e[0], false) ||
        GIT_REPOSITORY_ENV_KEYS.has(e[0])
      ) {
        return false;
      }
      if (e[1].includes('\n') || e[1].includes('\r')) {
        dropped.push(e[0]);
        return false;
      }
      // spec.env spread over ambient — a key the caller supplied decides
      // its own row (the ambient BRO_BATCH marker is stripped; the
      // caller's own travels, spec bro-l8c4f.6)
      if (
        !isAllowedByEnvPolicy(
          e[0],
          e[1],
          'docker',
          spec,
          env ?? { agents: {}, connectors: {} },
          policy,
          Object.hasOwn(spec.env ?? {}, e[0])
        )
      ) {
        return false;
      }
      return true;
    })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  if (dropped.length > 0) {
    console.error(
      `warning: docker env-file drops ${dropped.length} var(s) with newline values: ${dropped.join(', ')}`
    );
  }
  writePrivateFileSync({ path: envFile, data: `${ambient}\n` });
}

/** The `docker run` argv — operator `runArgs` sit FIRST so docker's
 *  last-wins flag semantics keep `--name`/`--workdir`/labels/mounts
 *  under bro's control no matter what an operator passes. `--user`
 *  defaults to the host uid:gid — without it a rootful worker leaves
 *  root-owned files in the mounted worktree/git dir/beads store, and
 *  every later host-side git/rm hits EACCES; an operator `-u`/`--user`
 *  in runArgs still wins because the default is skipped, not shadowed. */
export function dockerRunArgv(
  name: string,
  spec: SpawnSpec,
  mounts: DockerMount[],
  envFile: string,
  agentId: string,
  promptFile: string,
  cliBadge: string | undefined,
  mol: string | undefined,
  runArgs: string[],
  image: string,
  wrapper: string,
  strictEnv: boolean
): string[] {
  const userArgs =
    typeof process.getuid === 'function' &&
    !runArgs.some(a => a === '--user' || a === '-u' || a.startsWith('--user='))
      ? ['--user', `${process.getuid()}:${process.getgid!()}`]
      : [];
  return [
    'run',
    '-d',
    '--init',
    '--rm',
    ...userArgs,
    ...filterStrictRunArgs(runArgs, strictEnv),
    '--name',
    name,
    '--workdir',
    mounts[0]?.target ?? resolve(spec.repoRoot),
    '--label',
    'bro.managed=1',
    '--label',
    `bro.step=${spec.molStep}`,
    ...mounts.flatMap(m => ['-v', `${m.source}:${m.target}`]),
    '--env-file',
    envFile,
    ...agentEnvPins(spec, agentId, promptFile, cliBadge, mol).flatMap(([k, v]) => [
      '-e',
      `${k}=${v}`,
    ]),
    image,
    'sh',
    '-c',
    wrapper,
  ];
}

// --- copilot -------------------------------------------------------------------

/** No local command runs on a copilot spawn — a provider-resolved
 *  worker/template has no remote surface to ride, and agents.copilot.
 *  command is meaningless by the same logic; refuse before anything
 *  lands. */

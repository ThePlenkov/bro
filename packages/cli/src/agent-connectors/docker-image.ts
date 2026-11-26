import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SpawnError, type SpawnSpec } from './core.ts';
import { jsoncToJson } from './docker-basic-harness.ts';
import { dockerRun } from './docker-basic-harness.ts';

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
  const df = configuredDockerfile(dc);
  if (df === undefined) {
    throw new SpawnError(`no usable image in ${dcPath} — ${missingImageHint(dc)}`, 'config');
  }
  const dockerfile = isAbsolute(df) ? df : join(dirname(dcPath), df);
  if (!existsSync(dockerfile)) {
    throw new SpawnError(`devcontainer dockerfile ${dockerfile} does not exist`, 'config');
  }
  return dockerfile;
}

function configuredDockerfile(dc: Devcontainer): string | undefined {
  const candidates = [dc.build?.dockerfile, dc.build?.dockerFile];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate !== ''
  );
}

function missingImageHint(dc: Devcontainer): string {
  const hints = new Map<boolean, string>([
    [true, 'dockerComposeFile devcontainers are not supported — set agents.docker.image'],
    [false, 'set agents.docker.image or give the devcontainer an "image" or "build.dockerfile"'],
  ]);
  return hints.get(dc.dockerComposeFile !== undefined)!;
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
  const context = resolveBuildContext(dcDir, dc);
  const buildArgs = resolveBuildArgs(dc);
  const tag = devcontainerTag(dcPath, dockerfile);
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

function resolveBuildContext(dcDir: string, dc: Devcontainer): string {
  const configured = typeof dc.build?.context === 'string' ? dc.build.context : '.';
  return isAbsolute(configured) ? configured : join(dcDir, configured);
}

function resolveBuildArgs(dc: Devcontainer): string[] {
  const args = typeof dc.build?.args === 'object' && dc.build.args !== null ? dc.build.args : {};
  return Object.entries(args).flatMap(([k, v]) => ['--build-arg', `${k}=${String(v)}`]);
}

function devcontainerTag(dcPath: string, dockerfile: string): string {
  return `bro-dev-${createHash('sha256')
    .update(readFileSync(dcPath, 'utf8'))
    .update('\n')
    .update(readFileSync(dockerfile, 'utf8'))
    .digest('hex')
    .slice(0, 12)}`;
}

/** Resolved image for a spawn — `agents.docker.image` wins; else the
 *  devcontainer's `image`, else a build of its `build.dockerfile`.
 *  Errors are 'config' (the operator's file/knob is wrong); a failed
 *  BUILD is 'unavailable' (the daemon's). Runs outside the registry
 *  lock — a first-build pays minutes that must not serialize other
 *  spawns. */
export function dockerImageFor(spec: SpawnSpec, knobs: Record<string, unknown>): string {
  const configuredImage = imageValue(knobs.image);
  if (configuredImage !== undefined) {
    return ensureDockerImage(configuredImage);
  }
  const dcPath = devcontainerPath(spec, knobs);
  const dc = readDevcontainer(dcPath);
  const devcontainerImage = imageValue(dc.image);
  if (devcontainerImage !== undefined) {
    return ensureDockerImage(devcontainerImage);
  }
  return buildDevcontainerImage(dcPath, devcontainerDockerfile(dcPath, dc), dc);
}

function imageValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
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

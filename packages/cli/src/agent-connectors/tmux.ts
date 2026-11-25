import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  AgentNotFound,
  type AgentConnectorEnv,
  SpawnError,
  agentsHome,
  findAgentEntry,
  fleetCapOf,
  getCredentialScope,
  isAllowedByEnvPolicy,
  markStoppedEntry,
  patchAgentRegistry,
  pollUntilGone,
  prepareSpawn,
  rebindSpawnLease,
  releaseSessionSlot,
  releaseSessionStart,
  releaseSpawnLease,
  retagSessionSlots,
  spawnHome,
  stepParent,
  tmuxProbe,
  tmuxRun,
  tmuxSessionName,
  toTmuxInfo,
  touchWorkMarker,
  warnNoPromptFile,
  workerRunLine,
  workerTmpDir,
  workerTmpEnvPins,
  workerWithResume,
  writePrivateFileSync,
  writeWorkMarker,
  ensureWorkerTmpDir,
  envKeyDropped,
  GIT_REPOSITORY_ENV_KEYS,
  agentEnvPins,
  externalGuardOf,
  sessionQuotaOf,
  shQuote,
  workerCliBadge,
  readAgentRegistry,
  procStat,
  TMUX_DEAD_ERR,
  withAgentRegistryLock,
} from './spawn-harness.ts';
import type {
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  ConnectorCtx,
  SpawnSpec,
} from './types.ts';
import { rmSync } from 'node:fs';
import { assertMutableConfig } from '../config-policy.ts';
import type { Lease } from '@broject/core';
export function makeTmuxConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['tmux'] ?? {};
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ??
    env.loop?.agent ??
    '';
  const socket = typeof knobs.socket === 'string' ? knobs.socket : 'bro';

  const findEntry = (id: string) => findAgentEntry(dir, 'tmux', id);

  return {
    name: 'tmux',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the critical section is sync
      assertMutableConfig(dir);
      const home = spawnHome(dir, 'tmux', command, spec);
      const ver = tmuxRun(socket, ['-V']);
      if (ver.missing || ver.code !== 0) {
        throw new SpawnError(
          `tmux unavailable — ${ver.missing ? 'not on PATH' : ver.err}`,
          'unavailable'
        );
      }
      // same critical section as native: dedup → claim → session →
      // pid-patch under the registry lock, all synchronous shell-outs;
      // the molecule pin's bd show resolves before the lock is taken
      const mol = stepParent(spec.beadsDir, spec.molStep);
      // the lease prepareSpawn mints must outlive the lock scope — a
      // launch failure after commit still has to free the cross-repo
      // key, so it is hoisted for the catch below
      let spawnLease: Lease | undefined;
      try {
        return withAgentRegistryLock(dir, () => {
          // the session name derives from the agentId prepareSpawn
          // resolves — entry callback, not a precomputed name, because a
          // tampered entry's unsafe id is reminted inside
          const {
            agentId,
            promptFile,
            log,
            stderrLog,
            exitFile,
            lease,
            reservation,
            resumeSessionId,
            crossKindReservations,
          } = prepareSpawn(dir, home, 'tmux', spec, {
            isLive: e => {
              const n = tmuxSessionName(e);
              if (n === undefined) {
                return false;
              }
              const p = tmuxProbe(socket, n);
              if (p.live === 'unknown') {
                // an unverifiable liveness probe must not let a duplicate
                // spawn kill-session a worker that may still be alive
                throw new SpawnError(
                  `cannot verify ${spec.molStep}'s tmux session — ${p.err}`,
                  'unavailable'
                );
              }
              if (p.live === 'running') {
                touchWorkMarker(dir, e.agentId);
              }
              return p.live === 'running';
            },
            liveDetail: e => `session ${tmuxSessionName(e) ?? '?'}`,
            entry: id => ({ session: `bro-${id}` }),
            cap: { max: fleetCapOf(env), env },
            env,
            sessionQuota: () => sessionQuotaOf(env, 'tmux', spec, command),
            spawnCommand: command,
            external: externalGuardOf(env),
          });
          spawnLease = lease;
          const session = `bro-${agentId}`;
          // resolved once for both consumers — the envFile filter drops
          // TMP* only when the pin rides -e below, and the mkdir runs
          // inside the failure guard (spec bro-v96mp)
          const workerTmp = workerTmpDir(spec.repoRoot, agentId);
          // a leftover session with our name (crash between entry and
          // kill, a respawn over a zombie) would make new-session fail
          // 'duplicate' — clear it; kill-session on a missing target is
          // a no-op error we ignore
          tmuxRun(socket, ['kill-session', '-t', session]);
          // ambient env (process.env + spec.env) rides a 0600 file the
          // pane sources, not argv — -e KEY=VALUE would expose secrets on
          // the tmux client's world-readable cmdline, a regression vs
          // native's spawn env. Identity pins are non-secret and stay on
          // -e; they're also filtered OUT of the file so sourcing can
          // never redirect the claim store or re-badge the worker
          const envFile = join(home, `${agentId}.env`);
          try {
            // the same credential-scope policy native/docker enforce (spec
            // bro-l8c4f.6) — a strict backend's tmux worker must not inherit
            // ambient env the allowlist excludes, and the ambient BRO_BATCH
            // marker is stripped the same way (only spec.env supplies it)
            const policy = getCredentialScope(env, 'tmux');
            const ambient = Object.entries({ ...process.env, ...spec.env })
              .filter(
                (e): e is [string, string] =>
                  e[1] !== undefined &&
                  /^[A-Za-z_]\w*$/.test(e[0]) &&
                  !envKeyDropped(e[0], workerTmp !== undefined) &&
                  !GIT_REPOSITORY_ENV_KEYS.has(e[0]) &&
                  isAllowedByEnvPolicy(
                    e[0],
                    e[1],
                    'tmux',
                    spec,
                    env,
                    policy,
                    Object.hasOwn(spec.env ?? {}, e[0])
                  )
              )
              .map(([k, v]) => `export ${k}=${shQuote(v)}`)
              .join('\n');
            writePrivateFileSync({ path: envFile, data: `${ambient}\n` });
            const worker = workerWithResume(spec.worker, resumeSessionId);
            const cliBadge = workerCliBadge(worker, command);
            const envArgs = [
              ...agentEnvPins(spec, agentId, promptFile, cliBadge, mol),
              // the tmpdir pin (spec bro-v96mp) — non-secret path, -e is
              // where tmux pins ride
              ...workerTmpEnvPins(workerTmp),
            ].flatMap(([k, v]) => ['-e', `${k}=${v}`]);
            ensureWorkerTmpDir(workerTmp);
            // the pane sources the ambient env and drops the file, then runs
            // the agent; $? lands in the .exit file before the pipeline
            // drains, tee keeps a log the way native's fd redirect does.
            // Session dies with the pane → has-session IS liveness. tmux
            // runs the command through the user's default-shell — a
            // non-POSIX one (fish) would eat the braces, so sh -c pins the
            // dialect the same way native's spawn does.
            // Worker payloads (spec bro-5hx1.1): a 'template' command
            // substitutes wholesale; an 'argv' worker becomes an exec line
            // with every element single-quoted — the provider argv never
            // re-parses into a different program.
            warnNoPromptFile(worker, command);
            const runLine = workerRunLine(worker, command);
            // stderr splits into its own capture when the backend records
            // one; without a capture it folds into the stdout tee so the
            // worker's noise still lands in the .log (docker does the same)
            const stderrRedirect = stderrLog !== undefined ? `2>> ${shQuote(stderrLog)}` : '2>&1';
            const paneScript = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; { ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} ); } ${stderrRedirect} | tee -a ${shQuote(log)}`;
            const paneCmd = `sh -c ${shQuote(paneScript)}`; // NOSONAR — operator-configured agent command (same contract as native/loop)
            const res = tmuxRun(socket, [
              'new-session',
              '-d',
              '-s',
              session,
              '-c',
              spec.repoRoot,
              ...envArgs,
              paneCmd,
            ]);
            if (res.code !== 0) {
              throw new SpawnError(`tmux new-session failed — ${res.err}`, 'unavailable');
            }
          } catch (err) {
            // ANY setup failure after the reservation hands its slots
            // and env file back — a stranded slot starves the quota
            // until its TTL lapses, and the ambient-secret env file
            // must not outlive the failed launch (an unwritable
            // bro-tmp is how this fires, spec bro-v96mp). The rethrow
            // still reaches the outer catch, whose lease release is
            // the existing fourth leg of this cleanup.
            try {
              rmSync(envFile, { force: true });
            } catch {
              // a cleanup failure (an envFile that is a directory
              // needs recursive; EACCES) must not mask the setup
              // error or skip the releases below
            }
            if (reservation !== undefined) {
              releaseSessionSlot(reservation);
            }
            releaseSessionStart(crossKindReservations);
            try {
              patchAgentRegistry(dir, spec.molStep, {
                spawnError: err instanceof Error ? err.message : String(err),
              });
            } catch {
              // the entry landed already — the SpawnError still reports
            }
            throw err;
          }
          // pane pid — a display handle like native's child pid, not the
          // liveness signal (has-session is); pidStart pins its identity
          // anyway so registry-side pidAlive probes (drive's cheap
          // occupancy plane runs no backend list()) can tell a recycled
          // pid from the live pane (bro-i5oq)
          const pp = tmuxRun(socket, ['list-panes', '-t', session, '-F', '#{pane_pid}']);
          const panePid = pp.code === 0 ? Number(pp.out.trim().split('\n')[0]) : Number.NaN;
          const hasPanePid = Number.isInteger(panePid) && panePid > 0;
          const spawned = patchAgentRegistry(
            dir,
            spec.molStep,
            hasPanePid ? { pid: panePid, pidStart: procStat(panePid)?.start ?? null } : {}
          );
          // a readable pane pid is a local liveness probe — downgrade the
          // born-TTL lease to pid governance. No pane pid: the lease keeps
          // its foreign host and the TTL backs it while the pane may still
          // be live
          rebindSpawnLease(dir, lease, hasPanePid ? { host: hostname(), pid: panePid } : {});
          // the slot claims follow the lane's holder — the pane lives
          // exactly as long as the session it hosts (spec bro-x601l)
          if (hasPanePid) {
            retagSessionSlots([reservation, ...crossKindReservations], panePid);
          }
          writeWorkMarker(dir, agentId, spec.molStep, hasPanePid ? panePid : undefined);
          return toTmuxInfo(socket, dir, home, spec.molStep, spawned);
        });
      } catch (err) {
        if (spawnLease !== undefined) {
          releaseSpawnLease(dir, spawnLease);
        }
        throw err;
      }
    },

    async list() {
      // NOSONAR — connector contract is async; the body is sync
      try {
        const ver = tmuxRun(socket, ['-V']);
        if (ver.missing || ver.code !== 0) {
          return { agents: [], degraded: ver.missing ? 'tmux not on PATH' : ver.err };
        }
        const home = agentsHome(dir);
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'tmux'
        );
        // one server round-trip for the whole fleet instead of a
        // has-session per entry — a name absent from a SUCCESSFUL
        // listing is proof of dead, and so is a dead-server error (the
        // server holds its sessions). Any other failure degrades the
        // list rather than reporting live agents as corpses
        const ls = tmuxRun(socket, ['list-sessions', '-F', '#{session_name}']);
        if (ls.code !== 0 && !TMUX_DEAD_ERR.test(ls.err)) {
          return { agents: [], degraded: ls.err !== '' ? ls.err : `tmux exited ${ls.code}` };
        }
        const live = new Set(ls.out.split('\n').filter(s => s !== ''));
        return {
          agents: entries.map(([molStep, e]) => toTmuxInfo(socket, dir, home, molStep, e, live)),
        };
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async status(id: string): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the body is sync
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no tmux agent ${id}`);
      }
      return toTmuxInfo(socket, dir, agentsHome(dir), hit[0], hit[1]);
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      const name = tmuxSessionName(entry);
      if (name !== undefined) {
        tmuxRun(socket, ['kill-session', '-t', name]);
        // let the kill land before recording the stop — 'stopped' on a
        // still-live session would let a respawn run alongside it
        await pollUntilGone(() => tmuxProbe(socket, name).live === 'running');
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      markStoppedEntry({
        dir,
        molStep,
        entry,
        id,
        what: 'tmux session',
        probe: name === undefined ? undefined : () => tmuxProbe(socket, name),
      });
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'none' }),
  };
}

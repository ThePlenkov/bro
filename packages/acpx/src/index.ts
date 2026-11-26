import { spawn } from 'node:child_process';
import type { RetentionVerdict } from '@broject/acp-session';
import type { AcpRuntimeHandle, AcpRuntimeStatus, SessionWatchEvent } from 'acpx/runtime';
import {
  createSharedAcpRuntime,
  type SharedAcpRuntime,
  type SharedAcpRuntimeOptions,
} from 'acpx/runtime';

export type AcpxCommand = 'export' | 'import' | 'prune';

export interface AcpxCliOptions {
  executable?: string;
  cwd?: string;
  signal?: AbortSignal;
}

/** Run an acpx archive command and decode its documented JSON result. */
export function runAcpx<T>(
  command: AcpxCommand,
  args: string[] = [],
  options: AcpxCliOptions = {}
): Promise<T> {
  const executable = options.executable ?? 'acpx';
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [command, ...args, '--format', 'json'], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`acpx ${command} failed (${code ?? 'signal'}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(new Error(`acpx ${command} returned invalid JSON`, { cause: error }));
      }
    });
  });
}

export interface AcpxArchiveClient {
  exportSession(session: string, destination: string): Promise<unknown>;
  importSession(archive: string): Promise<unknown>;
  pruneSession(session: string): Promise<unknown>;
}

/** The archive-only seam; callers never need to construct acpx argv. */
export function createArchiveClient(options: AcpxCliOptions = {}): AcpxArchiveClient {
  return {
    exportSession: (session, destination) =>
      runAcpx('export', [session, '--output', destination], options),
    importSession: archive => runAcpx('import', [archive], options),
    pruneSession: session => runAcpx('prune', [session], options),
  };
}

export interface AcpxFacade {
  runtime: SharedAcpRuntime;
  archive: AcpxArchiveClient;
  findSession(input: {
    sessionKey: string;
    agent: string;
    cwd?: string;
  }): ReturnType<SharedAcpRuntime['findSession']>;
  status(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus>;
  watch(handle: AcpRuntimeHandle, signal?: AbortSignal): AsyncIterable<SessionWatchEvent>;
  close(handle: AcpRuntimeHandle, reason?: string): Promise<void>;
  /** Kept on the facade so ACP consumers have one stable result shape. */
  verdict: (value: RetentionVerdict) => RetentionVerdict;
}

export function createAcpxFacade(
  runtimeOptions: SharedAcpRuntimeOptions,
  cliOptions: AcpxCliOptions = {}
): AcpxFacade {
  const runtime = createSharedAcpRuntime(runtimeOptions);
  return {
    runtime,
    archive: createArchiveClient(cliOptions),
    findSession: input => runtime.findSession(input),
    status: handle => runtime.getStatus({ handle }),
    watch: (handle, signal) => runtime.watchSession({ handle, signal }),
    close: (handle, reason = 'closed by bro') => runtime.close({ handle, reason }),
    verdict: value => value,
  };
}

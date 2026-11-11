#!/usr/bin/env node
/**
 * dist/hooks.js — the slim `bro hooks <event>` entry (review #9,
 * specs/sessions/bro-36sx7.md). Every hook event is a fresh process on
 * the host agent's critical path; the full CLI entry (index.ts)
 * cold-loads the ~81-plugin command registry for a dispatch that needs
 * only the hook runner and the connector plane. This entry keeps the
 * registry out of the static graph:
 *
 *   - connectors.ts registers the built-in connectors at module load —
 *     the same set plugins.ts registers, shared so order can't drift
 *   - external plugin connectors still load through the real
 *     loadExternalPlugins, but only when config actually lists
 *     `plugins` — an empty list makes that call a no-op anyway, so the
 *     dynamic import costs nothing on a stock install
 *   - the otel command span + ambient parent match index.ts, so
 *     hook.event spans keep their `bro.cmd hooks` parent
 *
 * journalCommand is deliberately absent: the hook writes its own perf
 * row through flushPerf (bro-36sx7.9 removes the duplicate for the
 * `bro hooks` spelling too). registerTelegramSink is absent: no sink
 * delivery happens on the hook path.
 */
import { loadConfig } from '@broject/core';
import { otelSpan, setAmbient } from '@broject/providers';
import './connectors.ts';
import { runHooksCommand } from './commands/hooks.ts';

// ISO timestamps on console output — the same env-gated wrap index.ts
// installs (BRO_LOG_TIMESTAMP=1 pinned by daemon/postmerge children
// writing to log files). Hook answers go through writeSync(1) and were
// never affected; this keeps the operator subcommands
// (install/perf/status) byte-identical under the pin.
if (
  process.env.BRO_LOG_TIMESTAMP === '1' &&
  !process.argv.some(
    a => a === '--json' || a === '--jsonl' || a === '-j' || a.startsWith('--json=')
  ) &&
  !process.env.BRO_JSON &&
  !process.env.BRO_MACHINE_OUTPUT
) {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  const ts = (): string => new Date().toISOString();
  console.log = (...args: unknown[]) => origLog(`[${ts()}]`, ...args);
  console.error = (...args: unknown[]) => origErr(`[${ts()}]`, ...args);
  console.warn = (...args: unknown[]) => origWarn(`[${ts()}]`, ...args);
  console.info = (...args: unknown[]) => origInfo(`[${ts()}]`, ...args);
}

// Command telemetry — the same span contract index.ts gives every bro
// command; the ambient ctx is what hooks.ts's hook.event span resolves
// its parent against. No OTLP endpoint configured → enqueue drops
// before any spawn, so this is free on a stock install.
const t0 = Date.now();
const cmdSpan = otelSpan('bro.cmd hooks', { cmd: 'hooks' }, { startMs: t0 });
setAmbient(cmdSpan.ctx);
process.on('exit', code => {
  cmdSpan.endDetached(
    { 'cmd.exit_code': code ?? 0, 'cmd.duration_ms': Date.now() - t0 },
    (code ?? 0) === 0 ? 'ok' : 'error'
  );
});

// External plugin connectors — the one piece of index.ts's prepare the
// hook path cannot skip: a configured plugin's connectors fire inside
// probes. Empty `plugins` makes loadExternalPlugins a no-op, so the
// registry import stays dynamic and pays nothing where no external
// plugin exists; where one does, the full collision semantics apply.
const externalSpecs = loadConfig().plugins;
if (externalSpecs.length > 0) {
  const plugins = await import('./plugins.ts');
  const { reservedWords } = await import('./docs.ts');
  await plugins.loadExternalPlugins(
    undefined,
    externalSpecs,
    new Set([...reservedWords(), ...plugins.pluginGroups().keys()])
  );
}

// argv is already the post-`hooks` spelling the plugin's `run` receives
// (`bro hooks post-tool` → runHooksCommand(['post-tool'])), so
// `node dist/hooks.js post-tool` is the same dispatch. hooks.ts keeps
// its own fail-open contract and never throws CommandError — a
// rejection here is a bug, reported and exited nonzero like
// index.ts's dispatchFatal tail.
try {
  await runHooksCommand(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

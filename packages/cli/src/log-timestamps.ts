/**
 * ISO timestamps on console output — only for processes pinned
 * BRO_LOG_TIMESTAMP=1 (daemon/postmerge children writing to log files —
 * their stdout is the log fd, so a TTY check would disable exactly the
 * path this exists for) AND only human output: --json/--jsonl argv,
 * BRO_JSON, machine-output pins all opt out, so an inherited flag can
 * never corrupt a nested `bro ... --json` (spec bro-7h976).
 *
 * Shared by the index and hooks entries (bro-36sx7.7) so the two
 * dispatch surfaces can't drift on the wrap contract.
 */
export function installLogTimestamps(): void {
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
    console.log = (...args: unknown[]) => {
      origLog(`[${ts()}]`, ...args);
    };
    console.error = (...args: unknown[]) => {
      origErr(`[${ts()}]`, ...args);
    };
    console.warn = (...args: unknown[]) => {
      origWarn(`[${ts()}]`, ...args);
    };
    console.info = (...args: unknown[]) => {
      origInfo(`[${ts()}]`, ...args);
    };
  }
}

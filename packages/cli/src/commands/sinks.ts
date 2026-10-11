/**
 * `bro sinks` — the operator surface for `notify.sinks` (spec:
 * specs/bro-huy5o.8.md). The config is env-indirected on purpose:
 * `list` reports which secrets the sinks NAME and whether each is set —
 * never the values. `test` delivers a probe event and reports the
 * per-sink verdict, so a misconfigured webhook surfaces now instead of
 * at the next HUMAN GATE.
 *
 *   list [--json]   resolved sinks — type, route patterns, secret state
 *   test            deliver a probe event, print per-sink results
 */
import { randomBytes } from 'node:crypto'
import {
  deliverSinks,
  loadConfig,
  sinkMatches,
  sinkSecrets,
  type SinkDef,
} from '@broject/core'

function usage(exitCode = 1): never {
  console.error(`Usage: bro sinks <command> [args…]

Commands:
  list [--json]   Resolved sinks — type, route patterns, secret env state
  test            Deliver a probe event; report per-sink ok/err`)
  process.exit(exitCode)
}

/** Endpoint provenance for `list` — the env var name or "literal",
 *  plus set/unset. Values never print: a webhook URL is itself the
 *  secret for slack-style sinks. */
function endpointOf(sink: SinkDef): { via: string; set: boolean } {
  if (sink.type === 'telegram') {
    const chatVia = sink.chatId !== undefined ? 'chatId literal' : (sink.chatIdEnv ?? '')
    const chatSet =
      sink.chatId !== undefined ||
      (sink.chatIdEnv !== undefined &&
        (process.env[sink.chatIdEnv]?.trim() ?? '') !== '')
    return {
      via: `token ${sink.tokenEnv}${chatVia === '' ? '' : ` · chat ${chatVia}`}`,
      set: (process.env[sink.tokenEnv ?? '']?.trim() ?? '') !== '' && chatSet,
    }
  }
  const envName = sink.urlEnv
  if (envName !== undefined) {
    return { via: envName, set: (process.env[envName]?.trim() ?? '') !== '' }
  }
  return { via: 'url literal', set: true }
}

function cmdList(json: boolean): void {
  const { sinks } = loadConfig(process.cwd()).notify
  if (json) {
    console.log(
      JSON.stringify(
        sinks.map((s) => ({
          ...s,
          // strip anything that could hold a literal secret — list
          // describes the config, it does not leak it
          url: s.url === undefined ? undefined : '<set>',
          chatId: s.chatId === undefined ? undefined : '<set>',
          endpoint: endpointOf(s),
        })),
        null,
        2
      )
    )
    return
  }
  if (sinks.length === 0) {
    console.log(
      'no sinks configured — add "notify.sinks" to ~/.config/bro/config.json or bro.config.local.*'
    )
    return
  }
  for (const [i, s] of sinks.entries()) {
    const ep = endpointOf(s)
    const events = s.events === undefined ? '*' : s.events.join(' ')
    const secrets = sinkSecrets(s)
    const envs =
      secrets.length === 0
        ? ''
        : ` [${secrets.map((e) => `${e}:${(process.env[e]?.trim() ?? '') === '' ? 'UNSET' : 'set'}`).join(' ')}]`
    console.log(
      `${s.name ?? `${s.type}#${i}`}  ${s.type}  events:${events}  via:${ep.via} ` +
        `${ep.set ? 'ready' : 'NOT READY'}${envs}`
    )
  }
}

async function cmdTest(): Promise<void> {
  const dir = process.cwd()
  const { sinks } = loadConfig(dir).notify
  if (sinks.length === 0) {
    console.error('no sinks configured — nothing to test')
    process.exitCode = 1
    return
  }
  // a fresh nonce per probe beats dedup — the operator asked for a
  // live delivery NOW, the state file must not answer "already sent"
  const nonce = randomBytes(3).toString('hex')
  const probe = {
    topic: 'sinks',
    kind: 'test',
    key: 'sinks-test',
    source: 'sinks',
    payload: `bro sinks test — probe ${nonce}`,
  }
  const results = await deliverSinks(dir, probe)
  const sent = new Set(results.map((r) => r.sink))
  for (const [i, s] of sinks.entries()) {
    const id = s.name ?? `${s.type}#${i}`
    if (!sent.has(id) && !sinkMatches(s, probe)) {
      console.log(`${id}  ${s.type}  skipped — no route match for sinks:test`)
    }
  }
  for (const r of results) {
    const line = r.delivered
      ? `ok${r.status === undefined ? '' : ` (${r.status})`}`
      : r.reason === 'deduped'
        ? 'skipped — deduped'
        : `FAILED — ${r.reason ?? 'unknown'}`
    console.log(`${r.sink}  ${r.type}  ${line}`)
  }
  // a failed delivery fails the probe; a skip is a report, not a fault
  if (results.some((r) => !r.delivered && r.reason !== 'deduped')) {
    process.exitCode = 1
  }
}

export async function runSinksCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    usage(sub === undefined ? 1 : 0)
  }
  switch (sub) {
    case 'list':
      cmdList(rest.includes('--json'))
      return
    case 'test':
      await cmdTest()
      return
    default:
      console.error(`error: unknown subcommand "${sub}"`)
      usage()
  }
}

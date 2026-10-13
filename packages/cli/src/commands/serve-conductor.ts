/** Conductor (spec bro-xeozo) — `/v1/*` answers from a configured
 * `providers.<name>` acp entry instead of an HTTP upstream. The model
 * is an agent: `devin acp` carries claude-class models through the
 * operator's existing devin auth — no Anthropic key in the loop.
 *
 *   BRO_PROVIDER_BACKEND=<name>   providers.<name> entry — must be
 *                                 `type: "acp"` (cli entries can't
 *                                 stream a session). Set = conductor;
 *                                 unset = the byte proxy keeps /v1.
 *   BRO_PROVIDER_MODEL=<id>       optional pin — wins over entry.model;
 *                                 the client's requested id is never
 *                                 trusted (provenance maps to served).
 *   BRO_PROVIDER_TIMEOUT_MS       per-call deadline (default 120000).
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { acpConverse, acpModels } from '@broject/providers'
import type { ProviderWireOpts } from '@broject/providers'

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>

export interface ConductorConfig {
  backend: string
  entry: AcpEntry
  model?: string
  cwd: string
  timeoutMs: number
}

/** BRO_PROVIDER_BACKEND resolves to the conductor's acp entry — a name
 *  no registry knows is a loud startup error naming what IS configured,
 *  never a silent fall back to the byte proxy. */
export function conductorConfig(
  env: NodeJS.ProcessEnv,
  dir: string,
  providers?: Record<string, ProviderEntry>
): ConductorConfig | undefined {
  const backend = env.BRO_PROVIDER_BACKEND?.trim()
  if (backend === undefined || backend === '') {
    return undefined
  }
  providers ??= (loadConfig(dir).providers ?? {}) as Record<string, ProviderEntry>
  const entry = providers[backend]
  if (entry === undefined) {
    throw new Error(
      `BRO_PROVIDER_BACKEND=${backend} — providers.${backend} is not configured ` +
        `(configured: ${Object.keys(providers).join(', ') || 'none'})`
    )
  }
  if (entry.type !== 'acp') {
    throw new Error(
      `providers.${backend} is type '${entry.type}' — the conductor needs an 'acp' entry ` +
        `(session-grade wire; cli entries spawn once, they don't converse)`
    )
  }
  const model = env.BRO_PROVIDER_MODEL?.trim()
  const t = Number(env.BRO_PROVIDER_TIMEOUT_MS)
  return {
    backend,
    entry,
    model: model === undefined || model === '' ? entry.model : model,
    cwd: dir,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 120_000,
  }
}

// --- anthropic request shapes (the subset claude-code sends) ----------

interface TextBlock {
  type: 'text'
  text: string
}
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | { text?: string }[]
}
type InBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string }

interface MessagesRequest {
  model?: string
  system?: string | { text?: string }[]
  messages?: { role?: string; content?: string | InBlock[] }[]
  tools?: { name?: string; description?: string; input_schema?: unknown }[]
  stream?: boolean
}

// --- translation -----------------------------------------------------

function blockText(b: InBlock): string {
  if (b.type === 'text') return (b as TextBlock).text
  if (b.type === 'tool_use') {
    const t = b as ToolUseBlock
    return `<tool_call>${JSON.stringify({ name: t.name, input: t.input })}</tool_call>`
  }
  if (b.type === 'tool_result') {
    const r = b as ToolResultBlock
    const body =
      typeof r.content === 'string'
        ? r.content
        : (r.content ?? []).map((c) => c.text ?? '').join('')
    return `<tool_result for="${r.tool_use_id}">${body}</tool_result>`
  }
  return `[${b.type}]`
}

/** The tool contract — the agent's only way to answer tool_use. */
function toolContract(tools: NonNullable<MessagesRequest['tools']>): string {
  const defs = tools
    .filter((t) => typeof t.name === 'string')
    .map(
      (t) =>
        `- ${t.name}: ${t.description ?? ''} input_schema: ${JSON.stringify(t.input_schema ?? {})}`
    )
    .join('\n')
  return [
    '<tools>',
    'Call tools by emitting exactly, one per call:',
    '<tool_call>{"name":"<name>","input":{<args>}}</tool_call>',
    defs === '' ? 'No tools available.' : `Available tools:\n${defs}`,
    '</tools>',
  ].join('\n')
}

function serializeRequest(body: MessagesRequest): string {
  const parts: string[] = []
  const system =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((s) => s.text ?? '').join('')
  if (system !== '') parts.push(`<system>\n${system}\n</system>`)
  if (body.tools !== undefined && body.tools.length > 0) {
    parts.push(toolContract(body.tools))
  }
  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const text =
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map(blockText).join('')
    parts.push(`<turn role="${role}">${text}</turn>`)
  }
  return parts.join('\n\n')
}

const TOOL_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

interface OutBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

/** Reply → ordered anthropic blocks: text segments stay text, each
 *  parseable <tool_call> becomes tool_use (unparseable JSON stays raw
 *  text — the wire never invents a call). */
export function parseReply(text: string): OutBlock[] {
  const out: OutBlock[] = []
  let at = 0
  let n = 0
  for (const m of text.matchAll(TOOL_CALL)) {
    let parsed: { name?: unknown; input?: unknown } | undefined
    try {
      parsed = JSON.parse(m[1])
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || typeof parsed.name !== 'string') continue
    const lead = text.slice(at, m.index)
    if (lead.trim() !== '') out.push({ type: 'text', text: lead })
    const input =
      typeof parsed.input === 'object' && parsed.input !== null && !Array.isArray(parsed.input)
        ? (parsed.input as Record<string, unknown>)
        : parsed.input === undefined
          ? {}
          : { value: parsed.input }
    out.push({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name: parsed.name,
      input,
    })
    n += 1
    at = (m.index ?? 0) + m[0].length
  }
  const tail = text.slice(at)
  if (tail.trim() !== '') out.push({ type: 'text', text: tail })
  if (out.length === 0) out.push({ type: 'text', text: '' })
  void n
  return out
}

// --- response emission -------------------------------------------------

/** Anthropic stop_reasons only — acp reasons outside the enum map to the
 *  nearest honest one, never forwarded raw. */
const STOP_REASON: Record<string, string> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'pause_turn',
  refusal: 'refusal',
  cancelled: 'end_turn',
}

/** chars/4 underestimates CJK several-fold — count wide codepoints
 *  (~1 token each) against the ascii quarter-rate. Estimate only —
 *  never billing, never compaction. */
function estTokens(s: string): number {
  let units = 0
  for (const ch of s) units += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 4 : 1
  return Math.max(1, Math.ceil(units / 4))
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function emitBlocks(
  res: ServerResponse,
  blocks: OutBlock[],
  model: string,
  stopReason: string,
  inputTokens: number
): void {
  const msgId = `msg_${randomBytes(12).toString('hex')}`
  const outTokens = estTokens(JSON.stringify(blocks))
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
  blocks.forEach((b, i) => {
    if (b.type === 'tool_use') {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
      })
    } else {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: b.text },
      })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
  })
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outTokens },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
}

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  res.end(`${JSON.stringify({ type: 'error', error: { type, message } })}\n`)
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }
  return body
}

const AVAIL = /unavailable|timeout|timed out/i

async function messages(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConductorConfig,
  opts: ProviderWireOpts
): Promise<void> {
  let body: MessagesRequest
  try {
    body = JSON.parse(await readBody(req)) as MessagesRequest
  } catch {
    apiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    return
  }
  const prompt = serializeRequest(body)
  const inputTokens = estTokens(prompt)
  // a dropped client cancels the acp turn — no orphan devin session
  const ac = new AbortController()
  res.once('close', () => ac.abort())
  let reply: Awaited<ReturnType<typeof acpConverse>>
  try {
    reply = await acpConverse(
      `conductor:${cfg.backend}`,
      cfg.entry,
      opts,
      prompt,
      () => {},
      Date.now() + cfg.timeoutMs,
      ac.signal
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    apiError(
      res,
      AVAIL.test(msg) ? 529 : 500,
      AVAIL.test(msg) ? 'overloaded_error' : 'api_error',
      `bro conductor: ${msg}`
    )
    return
  }
  const blocks = parseReply(reply.text)
  const stopReason = blocks.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : (STOP_REASON[reply.stopReason] ?? 'end_turn')
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: `msg_${randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: blocks,
        model: reply.model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: estTokens(reply.text) },
      })
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  emitBlocks(res, blocks, reply.model, stopReason, inputTokens)
  res.end()
}

/** The anthropic /v1/models row — the backend's own catalog via
 *  session/new configOptions (the same list `bro providers models`
 *  renders as `<backend>/<id>`). */
async function models(
  res: ServerResponse,
  cfg: ConductorConfig,
  opts: ProviderWireOpts
): Promise<void> {
  try {
    const list = await acpModels(
      `conductor:${cfg.backend}`,
      cfg.entry,
      opts,
      Date.now() + 30_000
    )
    const data = list.map((m) => ({
      type: 'model',
      id: m.value,
      display_name: m.name ?? m.value,
      created_at: '2025-01-01T00:00:00Z',
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        object: 'list',
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      })
    )
  } catch (err) {
    apiError(res, 502, 'api_error', `bro conductor: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `(req, res)` handler for `/v1/*` — the conductor's answer when
 *  `BRO_PROVIDER_BACKEND` resolves an acp provider. Same raw-stream
 *  seat as the byte proxy — Messages bodies exceed the envelope cap. */
export function conductorProxy(
  cfg: ConductorConfig,
  opts: ProviderWireOpts = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const wireOpts: ProviderWireOpts = {
    ...opts,
    model: opts.model ?? cfg.model,
    acp: { cwd: cfg.cwd, ...opts.acp },
  }
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    if (method === 'POST' && path === '/v1/messages') {
      await messages(req, res, cfg, wireOpts)
      return
    }
    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      const raw = await readBody(req)
      apiErrorCountTokens(res, raw)
      return
    }
    if (method === 'GET' && path === '/v1/models') {
      await models(res, cfg, wireOpts)
      return
    }
    apiError(res, 404, 'not_found_error', `bro conductor: no route ${method} ${path}`)
  }
}

function apiErrorCountTokens(res: ServerResponse, raw: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ input_tokens: estTokens(raw) }))
}

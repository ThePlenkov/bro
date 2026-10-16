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
 *   BRO_PROVIDER_CATALOG=<name>   optional providers.<name> entry whose
 *                                 catalog answers GET /v1/models
 *                                 instead of the backend's — for
 *                                 tool-less backends (a summarizer
 *                                 advertises no model option) the
 *                                 catalog is what clients may pick.
 *                                 Any provider kind works (spec
 *                                 bro-wxfls).
 *   BRO_PROVIDER_TIMEOUT_MS       per-call deadline (default 120000).
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { acpOpen, acpPooledTurn, otelEvent, otelParent, otelSpan } from '@broject/providers'
import type { AcpContentBlock, AcpPeer, OtelCtx, PooledTurnOpts, ProviderWireOpts } from '@broject/providers'
import { peerAttrs } from './peer.ts'
import { catalogModels } from './providers.ts'

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>

export interface ConductorConfig {
  backend: string
  entry: AcpEntry
  /** The /v1/models source — defaults to the backend itself; a
   *  BRO_PROVIDER_CATALOG pin points at a different providers entry
   *  (a tool-less backend advertises nothing, the catalog still can). */
  catalog?: { name: string; entry: ProviderEntry }
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
  const catalogName = env.BRO_PROVIDER_CATALOG?.trim()
  let catalog: ConductorConfig['catalog']
  if (catalogName !== undefined && catalogName !== '') {
    const catalogEntry = providers[catalogName]
    if (catalogEntry === undefined) {
      throw new Error(
        `BRO_PROVIDER_CATALOG=${catalogName} — providers.${catalogName} is not configured ` +
          `(configured: ${Object.keys(providers).join(', ') || 'none'})`
      )
    }
    catalog = { name: catalogName, entry: catalogEntry }
  }
  return {
    backend,
    entry,
    catalog,
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

interface ImageBlock {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string; url?: string }
}

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

const turnRole = (m: { role?: string }): string =>
  m.role === 'assistant' ? 'assistant' : 'user'

/** system + tools — the transcript prefix shared by serializeRequest
 *  (one merged text block) and turnsToBlocks (its own leading block). */
function prefixText(body: MessagesRequest): string {
  const parts: string[] = []
  const system =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((s) => s.text ?? '').join('')
  if (system !== '') {
    parts.push(`<system>\n${system}\n</system>`)
  }
  if (body.tools !== undefined && body.tools.length > 0) {
    parts.push(toolContract(body.tools))
  }
  return parts.join('\n\n')
}

function serializeRequest(body: MessagesRequest): string {
  const parts = [prefixText(body)]
  for (const m of body.messages ?? []) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map(blockText).join('')
    parts.push(`<turn role="${turnRole(m)}">${text}</turn>`)
  }
  return parts.filter((p) => p !== '').join('\n\n')
}

/** An inbound image block → ACP image content. Only base64 sources
 *  carry the payload ACP needs (`data` + `mimeType`) — url/file
 *  sources degrade to the `[image]` marker rather than a block the
 *  agent can't read. */
function acpImage(b: InBlock): AcpContentBlock | undefined {
  const s = (b as ImageBlock).source
  if (s?.type === 'base64' && s.data !== undefined && s.media_type !== undefined) {
    return { type: 'image', data: s.data, mimeType: s.media_type }
  }
  return undefined
}

/** The request as ACP content blocks — same transcript as
 *  serializeRequest, but when the agent advertised
 *  promptCapabilities.image the wire carries real image content;
 *  without the capability the request stays one text block with the
 *  `[image]` marker exactly as before (bro-7izjx). */
function serializeBlocks(body: MessagesRequest, imageOk: boolean): AcpContentBlock[] {
  return imageOk ? turnsToBlocks(body) : [{ type: 'text', text: serializeRequest(body) }]
}

/** The image-capable path: the prefix leads, then every turn is its
 *  own text block followed by that turn's image blocks. <turn> tags
 *  stay balanced inside a single text block (amazon-q #558) and
 *  source order holds. */
function turnsToBlocks(body: MessagesRequest): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  const prefix = prefixText(body)
  if (prefix !== '') {
    blocks.push({ type: 'text', text: prefix })
  }
  for (const m of body.messages ?? []) {
    const { text, imgs } = turnParts(m.content)
    blocks.push({ type: 'text', text: `<turn role="${turnRole(m)}">${text}</turn>` }, ...imgs)
  }
  return blocks
}

/** A turn's content → its serialized text (passed-through image
 *  blocks stripped) plus the mappable ACP image blocks, in source
 *  order. Unmappable images stay inline as `[image]`. */
function turnParts(
  content: string | InBlock[] | undefined
): { text: string; imgs: AcpContentBlock[] } {
  if (typeof content === 'string') {
    return { text: content, imgs: [] }
  }
  const imgs: AcpContentBlock[] = []
  const text = (content ?? [])
    .map((b) => {
      const img = b.type === 'image' ? acpImage(b) : undefined
      if (img === undefined) {
        return blockText(b)
      }
      imgs.push(img)
      return ''
    })
    .join('')
  return { text, imgs }
}

const TOOL_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

interface OutBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

/** One completed <tool_call>'s payload — parseable JSON carrying a
 *  string name, else undefined: the markup stays raw text, the wire
 *  never invents a call (shared by the buffered and live splits). */
function toolCall(raw: string): { name: string; input: unknown } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const p = parsed as { name?: unknown; input?: unknown }
  if (typeof p.name !== 'string') return undefined
  const input =
    typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)
      ? p.input
      : p.input === undefined
        ? {}
        : { value: p.input }
  return { name: p.name, input }
}

/** Reply → ordered anthropic blocks: text segments stay text, each
 *  parseable <tool_call> becomes tool_use (unparseable JSON stays raw
 *  text — the wire never invents a call). */
export function parseReply(text: string): OutBlock[] {
  const out: OutBlock[] = []
  let at = 0
  for (const m of text.matchAll(TOOL_CALL)) {
    const call = toolCall(m[1] ?? '')
    if (call === undefined) continue
    const lead = text.slice(at, m.index)
    if (lead.trim() !== '') out.push({ type: 'text', text: lead })
    out.push({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name: call.name,
      input: call.input,
    })
    at = (m.index ?? 0) + m[0].length
  }
  const tail = text.slice(at)
  if (tail.trim() !== '') out.push({ type: 'text', text: tail })
  if (out.length === 0) out.push({ type: 'text', text: '' })
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

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/** Longest suffix of `s` that is a prefix of `tag` — the tail bytes a
 *  tag split across deltas must hold back until more of the turn
 *  arrives (or the turn ends and they flush as plain text). */
function tagSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(-n))) return n
  }
  return 0
}

/** Live SSE emission for a streaming turn (bro-728wl) — message_start
 *  leaves at turn start, text deltas flow inside one open text block,
 *  and each completed <tool_call> swaps to a tool_use block at the
 *  next index. The tag can span deltas, so free text is emitted only
 *  once it is provably outside a tag — parseReply's contract applied
 *  incrementally (bad JSON stays raw text, never an invented call). */
class LiveTurn {
  private idx = 0
  private open = false
  private inCall = false
  private pending = ''
  private sawTool = false
  private acc = ''
  stopReason = 'end_turn'

  constructor(
    private res: ServerResponse,
    model: string,
    inputTokens: number
  ) {
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  }

  readonly onUpdate: NonNullable<PooledTurnOpts['onUpdate']> = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      this.pending += u.content.text
      this.drain(false)
    }
  }

  private blockStart(contentBlock: unknown): void {
    sse(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: this.idx,
      content_block: contentBlock,
    })
  }

  private delta(d: unknown): void {
    sse(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.idx,
      delta: d,
    })
  }

  private blockStop(): void {
    sse(this.res, 'content_block_stop', { type: 'content_block_stop', index: this.idx })
    this.idx++
  }

  private closeBlock(): void {
    if (this.open) {
      this.blockStop()
      this.open = false
    }
  }

  private text(s: string): void {
    if (s === '') return
    if (!this.open) {
      this.blockStart({ type: 'text', text: '' })
      this.open = true
    }
    this.delta({ type: 'text_delta', text: s })
    this.acc += s
  }

  private tool(name: string, input: unknown): void {
    this.closeBlock()
    this.blockStart({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name,
      input: {},
    })
    const json = JSON.stringify(input)
    this.delta({ type: 'input_json_delta', partial_json: json })
    this.blockStop()
    this.sawTool = true
    this.acc += json
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.inCall) {
        const j = this.pending.indexOf(CLOSE_TAG)
        if (j === -1) {
          if (final) {
            this.text(OPEN_TAG + this.pending)
            this.pending = ''
          }
          return
        }
        const raw = this.pending.slice(0, j)
        this.pending = this.pending.slice(j + CLOSE_TAG.length)
        this.inCall = false
        const call = toolCall(raw)
        if (call === undefined) this.text(OPEN_TAG + raw + CLOSE_TAG)
        else this.tool(call.name, call.input)
      } else {
        const i = this.pending.indexOf(OPEN_TAG)
        if (i === -1) {
          const hold = final ? 0 : tagSuffix(this.pending, OPEN_TAG)
          this.text(this.pending.slice(0, this.pending.length - hold))
          this.pending = this.pending.slice(this.pending.length - hold)
          return
        }
        this.text(this.pending.slice(0, i))
        this.pending = this.pending.slice(i + OPEN_TAG.length)
        this.inCall = true
      }
    }
  }

  finish(stopReason: string): void {
    this.drain(true)
    this.closeBlock()
    if (this.idx === 0 && !this.sawTool) {
      // parity with the buffered shape — a silent turn still answers
      // with one (empty) text block
      this.blockStart({ type: 'text', text: '' })
      this.delta({ type: 'text_delta', text: '' })
      this.blockStop()
    }
    this.stopReason = this.sawTool ? 'tool_use' : stopReason
    sse(this.res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens() },
    })
    sse(this.res, 'message_stop', { type: 'message_stop' })
  }

  error(type: string, message: string): void {
    this.drain(true)
    this.closeBlock()
    sse(this.res, 'error', { type: 'error', error: { type, message } })
  }

  outputTokens(): number {
    // estTokens floors at 1 — a genuinely silent turn reports 0, not
    // a phantom token (amazon-q #566)
    return this.acc === '' ? 0 : estTokens(this.acc)
  }
}

/** The model message_start names — the applied pin (a `provider/model`
 *  request id or the configured entry pin) wins; a bare foreign id
 *  (claude-sonnet-*) is a display label and echoes as one. */
function servedModel(
  requestModel: string | undefined,
  opts: ProviderWireOpts,
  cfg: ConductorConfig,
  body: MessagesRequest
): string {
  const id =
    requestModel ??
    opts.model ??
    cfg.entry.model ??
    (typeof body.model === 'string' ? body.model : undefined)
  return id?.split('/').pop() ?? 'unknown'
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
  opts: ProviderWireOpts,
  link: (parent?: OtelCtx) => Promise<AcpPeer>,
  parent?: OtelCtx
): Promise<void> {
  let body: MessagesRequest
  try {
    body = JSON.parse(await readBody(req)) as MessagesRequest
  } catch {
    apiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    return
  }
  const t0 = Date.now()
  // a dropped client cancels the acp turn — no orphan devin session
  const ac = new AbortController()
  res.once('close', () => ac.abort())
  // `provider/model` ids are a real pin — resolved against the agent's
  // own catalog; bare foreign ids (claude-sonnet-*) are display labels
  const requestModel =
    typeof body.model === 'string' && body.model.includes('/') ? body.model : undefined
  const turnOpts: PooledTurnOpts = {
    signal: ac.signal,
    by: `conductor:${cfg.backend}`,
    requestModel,
    parent,
  }
  let reply: Awaited<ReturnType<typeof acpPooledTurn>>
  let live: LiveTurn | undefined
  let inputTokens = 0
  try {
    const peer = await link(parent)
    // image blocks ride the wire only when the agent advertised the
    // prompt capability — serialize after link() so the negotiated
    // caps are known (bro-7izjx)
    const prompt = serializeBlocks(body, peer.caps?.image === true)
    // an image's true token cost is dimension-based, not size-based —
    // base64-length/4 is the rough wire proxy so usage reporting
    // doesn't silently zero a large payload (amazon-q #558)
    inputTokens =
      estTokens(prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')) +
      prompt.reduce((n, b) => n + (b.type === 'image' ? Math.ceil(b.data.length / 4) : 0), 0)
    if (body.stream !== false) {
      // a streamed answer commits to SSE at turn start — headers and
      // message_start leave before the first delta; a failed turn lands
      // as an in-stream error event, the wire's own dead-stream shape.
      // x-accel-buffering:no stops a proxy from re-buffering the stream
      // back into one end-of-turn burst (amazon-q #566)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      live = new LiveTurn(res, servedModel(requestModel, opts, cfg, body), inputTokens)
      turnOpts.onUpdate = live.onUpdate
    }
    reply = await acpPooledTurn(
      peer,
      cfg.entry,
      opts,
      prompt,
      Date.now() + cfg.timeoutMs,
      turnOpts
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (live !== undefined) {
      live.error(
        AVAIL.test(msg) ? 'overloaded_error' : 'api_error',
        `bro conductor: ${msg}`
      )
      res.end()
      otelEvent('conductor.error', {
        backend: cfg.backend,
        status: 200,
        duration_ms: Date.now() - t0,
        error: msg.slice(0, 200),
      })
      return
    }
    const status = AVAIL.test(msg) ? 529 : 500
    otelEvent('conductor.error', {
      backend: cfg.backend,
      status,
      duration_ms: Date.now() - t0,
      error: msg.slice(0, 200),
    })
    apiError(
      res,
      status,
      AVAIL.test(msg) ? 'overloaded_error' : 'api_error',
      `bro conductor: ${msg}`
    )
    return
  }
  live?.finish(STOP_REASON[reply.stopReason] ?? 'end_turn')
  const blocks = live === undefined ? parseReply(reply.text) : []
  const stopReason =
    live?.stopReason ??
    (blocks.some((b) => b.type === 'tool_use')
      ? 'tool_use'
      : (STOP_REASON[reply.stopReason] ?? 'end_turn'))
  otelEvent('conductor.turn', {
    backend: cfg.backend,
    model: reply.model,
    stop_reason: stopReason,
    stream: body.stream !== false,
    input_tokens: inputTokens,
    output_tokens: live?.outputTokens() ?? estTokens(reply.text),
    duration_ms: Date.now() - t0,
  })
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
  res.end()
}

/** The anthropic /v1/models rows — the configured catalog source
 *  (`BRO_PROVIDER_CATALOG`, else the backend itself) through the SAME
 *  `bro providers models` surface, so ids arrive `<entry>/<model>` and
 *  re-pin on /v1/messages. */
async function models(
  res: ServerResponse,
  cfg: ConductorConfig,
  opts: ProviderWireOpts
): Promise<void> {
  try {
    const source = cfg.catalog ?? { name: cfg.backend, entry: cfg.entry }
    const list = await catalogModels(source.name, source.entry, { acp: opts.acp })
    const data = list.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.name ?? m.id,
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
  // warm pool: one acp child serves every /v1/messages turn — spawn +
  // initialize is paid once per listener; session/new per request is
  // cheap and concurrent sessions multiplex on the same connection.
  // A dead transport drops the link so the next request respawns.
  let link: Promise<AcpPeer> | undefined
  let live: AcpPeer | undefined
  const getLink = (parent?: OtelCtx): Promise<AcpPeer> => {
    if (link === undefined) {
      otelEvent('acp.spawn', { backend: cfg.backend })
      link = acpOpen(
        `conductor:${cfg.backend}`,
        cfg.entry,
        wireOpts,
        Date.now() + cfg.timeoutMs,
        parent
      )
      link.then(
        (p) => {
          live = p
          p.signal.addEventListener(
            'abort',
            () => {
              link = undefined
              live = undefined
            },
            { once: true }
          )
        },
        () => (link = undefined)
      )
    }
    return link
  }
  // the pooled child outlives any request — without a close on process
  // exit serve shutdown orphans it on a dead transport (the zombie
  // acp worker of the original incident). close() is sync, safe in an
  // 'exit' handler; an in-flight link resolve is a ms-scale window.
  process.once('exit', () => live?.close())
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    const t0 = Date.now()
    // one session = one trace: an instrumented caller's traceparent
    // parents every span we emit; local agents that don't propagate are
    // still attributed by process tree (peer.*)
    const httpSpan = otelSpan(
      `serve.http ${method} ${path}`,
      { backend: cfg.backend, 'http.method': method, 'http.route': path, ...peerAttrs(req.socket) },
      { parent: otelParent(req.headers.traceparent) }
    )
    res.once('finish', () => {
      httpSpan.end(
        { 'http.status': res.statusCode, 'http.duration_ms': Date.now() - t0 },
        res.statusCode >= 500 ? 'error' : 'ok'
      )
      otelEvent('serve.request', {
        route: `${method} ${path}`,
        status: res.statusCode,
        duration_ms: Date.now() - t0,
        backend: cfg.backend,
      })
    })
    if (method === 'POST' && path === '/v1/messages') {
      await messages(req, res, cfg, wireOpts, getLink, httpSpan.ctx)
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

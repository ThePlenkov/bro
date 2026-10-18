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

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { acpOpen, acpPooledTurn, acpSessionRetain, otelEvent, otelParent, otelSpan } from '@broject/providers'
import type { AcpContentBlock, AcpPeer, AcpRetainedSession, OtelCtx, PooledTurnOpts, ProviderWireOpts } from '@broject/providers'
import { peerAttrs } from './peer.ts'
import { catalogModels } from './providers.ts'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

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

type ClientMessage = NonNullable<MessagesRequest['messages']>[number]

/** One message's canonical serialization — shared by serializeRequest
 *  (the cold prompt) and the conversation-fingerprint hashes, so a
 *  resent byte-identical turn always matches. */
function serTurn(m: ClientMessage): string {
  const text =
    typeof m.content === 'string'
      ? m.content
      : (m.content ?? []).map(blockText).join('')
  return `<turn role="${turnRole(m)}">${text}</turn>`
}

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
    parts.push(serTurn(m))
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

// --- conversation reuse (bro-whn25) ------------------------------------
//
// The Messages API is stateless but claude resends full history anyway:
// keep a retained acp session per conversation and feed ONLY the tail.
// Identity: explicit `x-bro-session` for clients that can send it, else
// a fingerprint of prefix+first turn. Correctness is never key-trusted —
// a candidate re-proves the consumed prefix byte-for-byte (hash over the
// first `consumed` serializations) before its tail is sliced, so an
// edited or replayed history falls back to a fresh session instead of
// poisoning a live one.

/** A live conversation: the retained session plus just enough client
 *  state to slice the next delta and to replay the last reply when a
 *  resent history carries nothing new. */
interface ConvSession {
  live: AcpRetainedSession
  peer: AcpPeer
  /** body.messages count fully accounted for — sent user turns AND
   *  assistant echoes the session already holds. */
  consumed: number
  /** sha256 over prefix+turnHashInput(messages[0..consumed-1]) — the
   *  prefix proof; a changed system/tools fails it and evicts. */
  historyHash: string
  /** raw request-model id the session currently runs — a resend that
   *  pins a different model re-pins instead of replaying. */
  requestModel?: string
  lastReply: { blocks: OutBlock[]; model: string; stopReason: string; inputTokens: number }
  busy: boolean
  lastSeen: number
}

const CONV_TTL_MS = 10 * 60_000
const CONV_CAP = 32

/** What the fingerprint/history proofs hash: the canonical turn text
 *  PLUS a digest of any image payload — `serTurn` collapses images to
 *  `[image]`, so without this two histories differing only in pixels
 *  would collide (codeant #569). */
const turnHashInput = (m: ClientMessage): string => {
  const imgs =
    typeof m.content === 'string'
      ? ''
      : (m.content ?? [])
          .filter((b) => b.type === 'image' && typeof (b as ImageBlock).source?.data === 'string')
          .map((b) =>
            createHash('sha256')
              .update((b as ImageBlock).source?.data ?? '')
              .digest('hex')
          )
          .join(',')
  return `${serTurn(m)}\x00${imgs}`
}

const hashTurns = (prefix: string, msgs: ClientMessage[], n: number): string =>
  createHash('sha256')
    .update(`${prefix}\n${msgs.slice(0, n).map(turnHashInput).join('\n')}`)
    .digest('hex')

/** Where the conversation id comes from: an explicit `x-bro-session`
 *  wins (clients that can pin); the fingerprint is the birth
 *  certificate — prefix + first turn — stable across the whole
 *  conversation since clients prepend, never rewrite the start. */
function conversationKey(req: IncomingMessage, body: MessagesRequest): string | undefined {
  const hdr = req.headers['x-bro-session']
  const named = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim()
  if (named !== undefined && named !== '') {
    // client values ALWAYS land in the h: namespace — accepting a
    // client-supplied f: verbatim would let a caller inject into the
    // fingerprint namespace and collide with another conversation
    return `h:${named.slice(0, 200)}`
  }
  const first = body.messages?.[0]
  if (first === undefined) {
    return undefined
  }
  const fp = createHash('sha256')
    .update(`${prefixText(body)}\n${turnHashInput(first)}`)
    .digest('hex')
  return `f:${fp}`
}

/** Drop a session handle without surfacing transport noise — the
 *  dispose is bookkeeping (eviction, teardown, failure cleanup), never
 *  an error path worth reporting. */
function disposeQuiet(live: { dispose(): void }): void {
  try {
    live.dispose()
  } catch {
    // dead transport — the drop is the point
  }
}

/** Retired sessions must be disposed — a leaked session holds agent
 *  context (and its cost) for nothing. TTL first, then oldest-out to
 *  the cap; the overflow count is captured BEFORE the loop so a live
 *  `size` can't shrink the size-branch mid-iteration. The map is
 *  insertion-ordered and hits re-insert, so front-to-back IS
 *  least-recently-used — overflow evicts the coldest entries. */
function sweepSessions(sessions: Map<string, ConvSession>, now: number): void {
  let overflow = Math.max(0, sessions.size - CONV_CAP)
  for (const [k, s] of sessions) {
    // a session mid-turn is off-limits — disposing a live handle would
    // kill the in-flight prompt; its own failure path evicts it
    if (s.busy) {
      continue
    }
    if (now - s.lastSeen > CONV_TTL_MS || overflow-- > 0) {
      sessions.delete(k)
      disposeQuiet(s.live)
    }
  }
}

/** Every session the transport owns dies with it — clear the whole
 *  map so no stale handle is ever reused on a respawned child. */
function dropSessions(sessions: Map<string, ConvSession>): void {
  for (const s of sessions.values()) {
    disposeQuiet(s.live)
  }
  sessions.clear()
}

/** The turns a reused session has NOT seen: everything past the
 *  consumed boundary, minus assistant messages — those are echoes of
 *  the session's own replies, already in its context. A tail that is
 *  only echoes means a retry, and the replay path answers it. */
function tailTurns(msgs: ClientMessage[], consumed: number): ClientMessage[] {
  return msgs.slice(consumed).filter((m) => m.role !== 'assistant')
}

/** Serialize just the new turns — turnsToBlocks' per-turn shape minus
 *  the prefix (the session saw it on turn one). */
function tailBlocks(msgs: ClientMessage[], imageOk: boolean): AcpContentBlock[] {
  if (!imageOk) {
    return [{ type: 'text', text: msgs.map(serTurn).join('\n\n') }]
  }
  const out: AcpContentBlock[] = []
  for (const m of msgs) {
    const { text, imgs } = turnParts(m.content)
    out.push({ type: 'text', text: `<turn role="${turnRole(m)}">${text}</turn>` }, ...imgs)
  }
  return out
}

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
  let input: unknown
  if (typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)) {
    input = p.input
  } else if (p.input === undefined) {
    input = {}
  } else {
    input = { value: p.input }
  }
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

/** The buffered SSE answer — the whole settled reply emitted as one
 *  anthropic event sequence. Used where no live turn ran: a replayed
 *  resend answers from conv.lastReply, never a fresh pump. */
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

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/** Narration label — a tool_call title can carry a whole command
 *  string; first line only, capped. */
function shortLabel(s: string): string {
  const line = s.split('\n', 1)[0] ?? s
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

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
    private readonly res: ServerResponse,
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
      return
    }
    const line = this.narrateTool(u)
    if (line !== undefined) {
      // pending may hold a held-back partial-tag tail — flush what
      // drain releases first so narration never lands inside buffered
      // text (drain still holds a live tag prefix; that tail completes
      // into a block later, so text order is preserved either way)
      this.drain(false)
      this.text(line)
    }
  }

  private readonly toolStarted = new Set<string>()
  private readonly toolDone = new Set<string>()
  private readonly toolLabels = new Map<string, string>()

  /** The session's own tool_call lifecycle — the client's only view of
   *  agent-side work (exec, file ops, subagent spawns): narrated as
   *  text edges, never tool_use (the tool already ran — a tool_use
   *  would make the client execute it again). One line per start, one
   *  per terminal status; content/plan/usage updates are chatter.
   *  Dedup keys on toolCallId when the agent supplies one — an id-less
   *  update can't be correlated, so it narrates every time. */
  private narrateTool(u: SessionUpdate): string | undefined {
    if (u.sessionUpdate === 'tool_call') return this.narrateStart(u)
    if (u.sessionUpdate === 'tool_call_update') return this.narrateTerminal(u)
    return undefined
  }

  private narrateStart(u: SessionUpdate): string | undefined {
    if (u.sessionUpdate !== 'tool_call') return undefined
    const id = u.toolCallId
    if (id !== undefined) {
      if (this.toolStarted.has(id)) return undefined
      this.toolStarted.add(id)
    }
    const label = shortLabel(u.title ?? u.name ?? u.kind ?? 'tool call')
    if (id !== undefined) this.toolLabels.set(id, label)
    const start = `\n⏺ ${label}\n`
    // a tool_call can itself arrive already terminal — open and close
    // the edge in one update so nothing stays mid-flight forever
    if (u.status !== 'completed' && u.status !== 'failed') return start
    if (id !== undefined) this.toolDone.add(id)
    return `${start}${u.status === 'failed' ? '✗' : '✓'} ${label}\n`
  }

  private narrateTerminal(u: SessionUpdate): string | undefined {
    if (
      u.sessionUpdate !== 'tool_call_update' ||
      (u.status !== 'completed' && u.status !== 'failed')
    ) {
      return undefined
    }
    const id = u.toolCallId
    if (id !== undefined) {
      if (this.toolDone.has(id)) return undefined
      this.toolDone.add(id)
    }
    const known = id !== undefined ? this.toolLabels.get(id) : undefined
    const label = shortLabel(u.title ?? u.name ?? known ?? 'tool call')
    return `\n${u.status === 'failed' ? '✗' : '✓'} ${label}\n`
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
      // each step returns true when the pending buffer stalls on a
      // boundary — the pump keeps going while a tag let it through
      if (this.inCall ? this.drainCall(final) : this.drainText(final)) return
    }
  }

  /** Inside <tool_call>: emit the call on its close tag, else hold —
   *  a final flush turns the unclosed remnant back into plain text. */
  private drainCall(final: boolean): boolean {
    const j = this.pending.indexOf(CLOSE_TAG)
    if (j === -1) {
      if (final) {
        this.text(OPEN_TAG + this.pending)
        this.pending = ''
      }
      return true
    }
    const raw = this.pending.slice(0, j)
    this.pending = this.pending.slice(j + CLOSE_TAG.length)
    this.inCall = false
    const call = toolCall(raw)
    if (call === undefined) this.text(OPEN_TAG + raw + CLOSE_TAG)
    else this.tool(call.name, call.input)
    return false
  }

  /** Free text: emit down to the next open tag — or everything but a
   *  partial-tag tail that more deltas might complete. */
  private drainText(final: boolean): boolean {
    const i = this.pending.indexOf(OPEN_TAG)
    if (i === -1) {
      const hold = final ? 0 : tagSuffix(this.pending, OPEN_TAG)
      this.text(this.pending.slice(0, this.pending.length - hold))
      this.pending = this.pending.slice(this.pending.length - hold)
      return true
    }
    this.text(this.pending.slice(0, i))
    this.pending = this.pending.slice(i + OPEN_TAG.length)
    this.inCall = true
    return false
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

/** text-char + image-wire token estimate — an image's true cost is
 *  dimension-based, not size-based; base64-length/4 is the rough wire
 *  proxy so usage reporting doesn't silently zero a large payload
 *  (amazon-q #558). */
function inputTokensOf(prompt: AcpContentBlock[]): number {
  return (
    estTokens(prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')) +
    prompt.reduce((n, b) => n + (b.type === 'image' ? Math.ceil(b.data.length / 4) : 0), 0)
  )
}

/** One settled reply → the wire, streamed or buffered. `x-bro-session`
 *  echoes ONLY an h: (client-pinned) key — echoing the internal f:
 *  fingerprint would let a client pin back into the fingerprint
 *  namespace it must never inject into. */
function respond(
  res: ServerResponse,
  body: MessagesRequest,
  blocks: OutBlock[],
  model: string,
  stopReason: string,
  inputTokens: number,
  sessionKey?: string
): void {
  const sessionHdr = sessionKey?.startsWith('h:') === true ? { 'x-bro-session': sessionKey } : {}
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json', ...sessionHdr })
    res.end(
      JSON.stringify({
        id: `msg_${randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: blocks,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: estTokens(JSON.stringify(blocks)) },
      })
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...sessionHdr,
  })
  emitBlocks(res, blocks, model, stopReason, inputTokens)
  res.end()
}

/** Evict a conversation — failed turns, stale prefixes, dead repins
 *  all land here: out of the map, handle dropped, never reused. */
function evict(
  sessions: Map<string, ConvSession>,
  key: string | undefined,
  conv: ConvSession
): void {
  if (key !== undefined) {
    sessions.delete(key)
  }
  disposeQuiet(conv.live)
}

type PooledReply = Awaited<ReturnType<typeof acpPooledTurn>>

interface TurnOutcome {
  reply?: PooledReply
  conv?: ConvSession
  reused: boolean
  inputTokens: number
  /** the resend carried nothing new — caller replays conv.lastReply */
  replay: boolean
}

/** Everything one /v1/messages turn shares — built once per request so
 *  the routing helpers stay narrow. */
interface TurnEnv {
  body: MessagesRequest
  msgs: ClientMessage[]
  prefix: string
  peer: AcpPeer
  cfg: ConductorConfig
  opts: ProviderWireOpts
  sessions: Map<string, ConvSession>
  pendingOpens: Set<string>
  key: string | undefined
  parent: OtelCtx | undefined
  requestModel: string | undefined
  deadline: number
  signal: AbortSignal
  by: string
  imageOk: boolean
  /** Called the moment a real turn is chosen (never on replay or a
   *  failed open) — it commits the wire to SSE and hands back the
   *  session-update sink the prompt pump streams deltas into
   *  (bro-728wl). Undefined for `stream:false` requests. */
  openStream?: (inputTokens: number) => PooledTurnOpts['onUpdate']
}

/** A proven continuation — the delta turns only; an empty tail is a
 *  replay (with a repin if the resend pins a different model). */
async function continuationTurn(env: TurnEnv, cand: ConvSession): Promise<TurnOutcome> {
  const tail = tailTurns(env.msgs, cand.consumed)
  if (tail.length === 0) {
    // a pure retry — nothing new for the session; the caller replays
    // the recorded reply. A resend pinning a DIFFERENT model is not a
    // replay — the session re-pins and the recorded answer stays
    // honest (it was generated under the old pin either way).
    if (env.requestModel !== undefined && env.requestModel !== cand.requestModel) {
      try {
        await cand.live.repin(env.requestModel, env.deadline)
        cand.requestModel = env.requestModel
      } catch (err) {
        evict(env.sessions, env.key, cand)
        throw err
      }
    }
    cand.lastSeen = Date.now()
    return { reused: true, inputTokens: 0, replay: true, conv: cand }
  }
  // the delta only — prior turns live in the session's own context
  const prompt = tailBlocks(tail, env.imageOk)
  const inputTokens = inputTokensOf(prompt)
  cand.busy = true
  cand.lastSeen = Date.now()
  try {
    const reply = await cand.live.prompt(prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    return { reply, reused: true, inputTokens, replay: false, conv: cand }
  } catch (err) {
    // a failed turn poisons cacheability — evict and let the retry
    // open a fresh session rather than pile onto unknown state
    evict(env.sessions, env.key, cand)
    throw err
  } finally {
    cand.busy = false
  }
}

/** A first (or restarted) turn — a keyed request retains a session;
 *  a keyless, busy, or already-opening key takes the one-shot path. */
async function freshTurn(env: TurnEnv, candBusy: boolean): Promise<TurnOutcome> {
  // image blocks ride the wire only when the agent advertised the
  // prompt capability — serialize after link() so the negotiated
  // caps are known (bro-7izjx)
  const prompt = serializeBlocks(env.body, env.imageOk)
  const inputTokens = inputTokensOf(prompt)
  const key = env.key
  if (key === undefined || candBusy || env.pendingOpens.has(key)) {
    // a keyless request, or the conversation's own turn is still in
    // flight — one-shot over the same link, nothing stored
    const reply = await acpPooledTurn(env.peer, env.cfg.entry, env.opts, prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    return { reply, reused: false, inputTokens, replay: false }
  }
  // mark BEFORE the await — a concurrent first request on the same key
  // takes the one-shot path instead of opening a twin session whose
  // loser leaks out of the map (codeant #569)
  env.pendingOpens.add(key)
  let live: AcpRetainedSession | undefined
  try {
    live = await acpSessionRetain(env.peer, env.cfg.entry, env.opts, env.deadline, {
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
    })
    const reply = await live.prompt(prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    const conv: ConvSession = {
      live,
      peer: env.peer,
      consumed: env.msgs.length,
      historyHash: hashTurns(env.prefix, env.msgs, env.msgs.length),
      requestModel: env.requestModel,
      lastReply: { blocks: [], model: '', stopReason: '', inputTokens: 0 },
      busy: false,
      lastSeen: Date.now(),
    }
    return { reply, reused: false, inputTokens, replay: false, conv }
  } catch (err) {
    // the first turn died — nothing is cached yet but the acp side
    // still holds the session; drop it before surfacing
    if (live !== undefined) {
      disposeQuiet(live)
    }
    throw err
  } finally {
    env.pendingOpens.delete(key)
  }
}

/** One request's acp turn — proves a stored conversation (or evicts a
 *  stale one), then routes to continuation/fresh/one-shot. */
async function acpTurn(env: TurnEnv): Promise<TurnOutcome> {
  sweepSessions(env.sessions, Date.now())
  const cand = env.key !== undefined ? env.sessions.get(env.key) : undefined
  const usable =
    cand !== undefined &&
    cand.peer === env.peer &&
    !cand.busy &&
    cand.consumed <= env.msgs.length &&
    hashTurns(env.prefix, env.msgs, cand.consumed) === cand.historyHash
  if (usable === true) {
    return continuationTurn(env, cand)
  }
  const candBusy = cand?.busy === true
  if (cand !== undefined && !candBusy && env.key !== undefined) {
    // a stale key — the stored context never proved this client;
    // its session is poison for THIS conversation, retire it
    evict(env.sessions, env.key, cand)
  }
  return freshTurn(env, candBusy)
}

/** The wire surface `messages` needs — one listener's cfg, provider
 *  opts, link factory, and the session maps it owns. */
interface WireCtx {
  cfg: ConductorConfig
  opts: ProviderWireOpts
  link: (parent?: OtelCtx) => Promise<AcpPeer>
  sessions: Map<string, ConvSession>
  pendingOpens: Set<string>
}

/** `provider/model` ids are a real pin — resolved against the agent's
 *  own catalog; bare foreign ids (claude-sonnet-*) are display labels.
 *  Claude pins context variants as `model[1m]` — the bracket suffix is
 *  a client-side opt-in, not a different model; strip it or the
 *  catalog lookup 500s (bro-0g2l3). */
function requestModelOf(body: MessagesRequest): string | undefined {
  const raw = typeof body.model === 'string' ? body.model.trimEnd() : undefined
  const open = raw?.lastIndexOf('[') ?? -1
  const inner = open >= 0 && raw?.endsWith(']') ? raw.slice(open + 1, -1) : undefined
  const m =
    inner !== undefined && /^\d+[km]?$/i.test(inner) ? raw?.slice(0, open).trimEnd() : raw
  return m?.includes('/') ? m : undefined
}

/** A failed turn — on an open SSE stream the failure travels as an
 *  in-stream error event (the wire's own dead-stream shape); pre-commit
 *  it is an anthropic-shaped HTTP status. */
function turnError(
  res: ServerResponse,
  err: unknown,
  live: LiveTurn | undefined,
  backend: string,
  t0: number
): void {
  const msg = err instanceof Error ? err.message : String(err)
  const avail = AVAIL.test(msg)
  if (live !== undefined) {
    live.error(avail ? 'overloaded_error' : 'api_error', `bro conductor: ${msg}`)
    res.end()
    otelEvent('conductor.error', {
      backend,
      status: 200,
      duration_ms: Date.now() - t0,
      error: msg.slice(0, 200),
    })
    return
  }
  const status = avail ? 529 : 500
  otelEvent('conductor.error', {
    backend,
    status,
    duration_ms: Date.now() - t0,
    error: msg.slice(0, 200),
  })
  apiError(
    res,
    status,
    avail ? 'overloaded_error' : 'api_error',
    `bro conductor: ${msg}`
  )
}

/** The turn settled — every client message (including the echoes the
 *  session just proved it holds) is consumed context now. Re-insert on
 *  every hit: insertion order is the LRU order sweepSessions' overflow
 *  eviction relies on. */
function settleConv(
  wire: WireCtx,
  key: string | undefined,
  conv: ConvSession,
  body: MessagesRequest,
  reply: PooledReply,
  blocks: OutBlock[],
  stopReason: string,
  inputTokens: number
): void {
  const all = body.messages ?? []
  conv.consumed = all.length
  conv.historyHash = hashTurns(prefixText(body), all, all.length)
  conv.lastReply = { blocks, model: reply.model, stopReason, inputTokens }
  if (key === undefined) return
  wire.sessions.delete(key)
  wire.sessions.set(key, conv)
}

async function messages(
  req: IncomingMessage,
  res: ServerResponse,
  wire: WireCtx,
  parent: OtelCtx | undefined
): Promise<void> {
  let body: MessagesRequest
  try {
    body = JSON.parse(await readBody(req)) as MessagesRequest
  } catch {
    apiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    return
  }
  const t0 = Date.now()
  const key = conversationKey(req, body)
  // set when a streamed turn actually opens — a replay or a failed
  // session open never commits the wire to SSE
  let live: LiveTurn | undefined
  let out: TurnOutcome
  try {
    const peer = await wire.link(parent)
    const ac = new AbortController()
    // a dropped client cancels the acp turn — no orphan devin session
    res.once('close', () => ac.abort())
    const msgs = body.messages ?? []
    const requestModel = requestModelOf(body)
    out = await acpTurn({
      body,
      msgs,
      prefix: prefixText(body),
      peer,
      cfg: wire.cfg,
      opts: wire.opts,
      sessions: wire.sessions,
      pendingOpens: wire.pendingOpens,
      key,
      parent,
      requestModel,
      deadline: Date.now() + wire.cfg.timeoutMs,
      signal: ac.signal,
      by: `conductor:${wire.cfg.backend}`,
      imageOk: peer.caps?.image === true,
      // a streamed answer commits to SSE at turn start — headers and
      // message_start leave before the first delta; a failed turn lands
      // as an in-stream error event, the wire's own dead-stream shape.
      // x-accel-buffering:no stops a proxy from re-buffering the stream
      // back into one end-of-turn burst (amazon-q #566). The turn layer
      // fires this only once a real pump is chosen — a replay never
      // opens the stream, a failed open still answers an HTTP status.
      openStream:
        body.stream === false
          ? undefined
          : (inputTokens) => {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
                // h: pins echo like respond()'s — the internal f:
                // fingerprint stays server-side
                ...(key?.startsWith('h:') === true ? { 'x-bro-session': key } : {}),
              })
              live = new LiveTurn(
                res,
                servedModel(requestModel, wire.opts, wire.cfg, body),
                inputTokens
              )
              return live.onUpdate
            },
    })
  } catch (err) {
    turnError(res, err, live, wire.cfg.backend, t0)
    return
  }
  // a resend that carried nothing new — replay the recorded reply,
  // no agent round-trip was paid
  if (out.replay === true) {
    const lr = out.conv?.lastReply
    respond(res, body, lr?.blocks ?? [], lr?.model ?? '', lr?.stopReason ?? '', lr?.inputTokens ?? 0, key)
    return
  }
  const reply = out.reply as PooledReply
  const inputTokens = out.inputTokens
  // a live stream pushed the wire deltas as they landed — finish()
  // closes the event shape; parseReply still runs so the settled reply
  // is recorded verbatim for a later replay
  live?.finish(STOP_REASON[reply.stopReason] ?? 'end_turn')
  const blocks = parseReply(reply.text)
  const stopReason =
    live?.stopReason ??
    (blocks.some((b) => b.type === 'tool_use')
      ? 'tool_use'
      : (STOP_REASON[reply.stopReason] ?? 'end_turn'))
  if (out.conv !== undefined) {
    settleConv(wire, key, out.conv, body, reply, blocks, stopReason, inputTokens)
  }
  otelEvent('conductor.turn', {
    backend: wire.cfg.backend,
    model: reply.model,
    stop_reason: stopReason,
    stream: body.stream !== false,
    session_reused: out.reused,
    input_tokens: inputTokens,
    output_tokens: live?.outputTokens() ?? estTokens(reply.text),
    duration_ms: Date.now() - t0,
  })
  if (live !== undefined) {
    // the streamed answer already wrote itself — finish() closed the
    // event sequence; only the socket remains
    res.end()
    return
  }
  respond(res, body, blocks, reply.model, stopReason, inputTokens, key)
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
  // retained conversations — one acp session per client conversation
  // (x-bro-session pin or history fingerprint). Transport death kills
  // every session it carried, so the abort listener drops the map.
  const sessions = new Map<string, ConvSession>()
  // keys whose first session/new is in flight — a concurrent same-key
  // request must not open a twin (the loser would leak unmapped)
  const pendingOpens = new Set<string>()
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
              dropSessions(sessions)
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
      await messages(
        req,
        res,
        { cfg, opts: wireOpts, link: getLink, sessions, pendingOpens },
        httpSpan.ctx
      )
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

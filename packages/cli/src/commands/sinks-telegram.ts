/** Telegram sink delivery policy — the bot-api request builder. Lives
 *  in the plugin layer (bro-mq1t2): core keeps the sink contract and
 *  dispatch; the token-in-URL shape, the chatId/tokenEnv resolution,
 *  and the apiBase https rule are telegram's own policy. The cli entry
 *  calls `registerTelegramSink()` — importing this module alone wires
 *  nothing. */
import {
  registerSinkBuilder,
  renderEventText,
  type EventInput,
  type SinkDef,
  type SinkRequest,
} from '@broject/core'

const TELEGRAM_API = 'https://api.telegram.org'

/** Bot tokens are `<bot-id>:<secret>` — the token rides the URL path, so
 *  anything that can alter the path (`/`, `..`, whitespace, a second
 *  colon) is refused before it reaches the wire. Bounds are generous:
 *  telegram ids/secrets have a documented shape, not a pinned length. */
const TOKEN_SHAPE = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/

export function telegramRequest(
  sink: SinkDef,
  event: EventInput,
  env: NodeJS.ProcessEnv
): SinkRequest {
  const token = sink.tokenEnv !== undefined ? env[sink.tokenEnv]?.trim() : undefined
  if (token === undefined || token === '') {
    return { missing: sink.tokenEnv ?? 'tokenEnv' }
  }
  if (!TOKEN_SHAPE.test(token)) {
    return { refused: 'tokenEnv must hold a telegram bot token (<id>:<secret>)' }
  }
  const chatId =
    sink.chatId ?? (sink.chatIdEnv !== undefined ? env[sink.chatIdEnv]?.trim() : undefined)
  if (chatId === undefined || chatId === '') {
    return { missing: sink.chatIdEnv ?? 'chatId' }
  }
  // linear trim — a `/+$/` regex on operator input is a ReDoS shape
  let base = sink.apiBase ?? TELEGRAM_API
  while (base.endsWith('/')) {
    base = base.slice(0, -1)
  }
  if (!base.toLowerCase().startsWith('https://')) {
    return { refused: 'apiBase must be https:// — the bot token rides the request URL' }
  }
  return {
    url: `${base}/bot${token}/sendMessage`,
    body: {
      chat_id: chatId,
      text: renderEventText(event),
      disable_web_page_preview: true,
    },
  }
}

export function registerTelegramSink(): void {
  registerSinkBuilder('telegram', telegramRequest)
}

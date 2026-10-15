/** Telegram sink delivery policy — the bot-api request builder. Lives
 *  in the plugin layer (bro-mq1t2): core keeps the sink contract and
 *  dispatch; the token-in-URL shape, the chatId/tokenEnv resolution,
 *  and the apiBase https rule are telegram's own policy. Importing
 *  this module registers the builder. */
import {
  registerSinkBuilder,
  renderEventText,
  type EventInput,
  type SinkDef,
  type SinkRequest,
} from '@broject/core'

const TELEGRAM_API = 'https://api.telegram.org'

export function telegramRequest(
  sink: SinkDef,
  event: EventInput,
  env: NodeJS.ProcessEnv
): SinkRequest {
  const token = sink.tokenEnv !== undefined ? env[sink.tokenEnv]?.trim() : undefined
  if (token === undefined || token === '') {
    return { missing: sink.tokenEnv ?? 'tokenEnv' }
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

registerSinkBuilder('telegram', telegramRequest)

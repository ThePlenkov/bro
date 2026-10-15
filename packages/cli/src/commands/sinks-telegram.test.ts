import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderEventText, requestFor, type EventInput } from '@broject/core'
import { registerTelegramSink, telegramRequest } from './sinks-telegram.ts'

registerTelegramSink()

const EVENT: EventInput = {
  topic: 'convoy',
  kind: 'gate',
  key: 'convoy-gate-mol-1',
  source: 'convoy',
  payload: 'convoy mol-1: HUMAN GATE ready — human input needed',
}

// a syntactically valid bot token — the builder validates the shape
const env = {
  TG_TOKEN: '123456789:ABCdef0123456789XYZabc_-DEFghi',
  TG_CHAT: '42',
} as unknown as NodeJS.ProcessEnv

describe('telegram sink policy (plugin layer, bro-mq1t2)', () => {
  test('builds the bot-api sendMessage request', () => {
    const r = requestFor(
      { type: 'telegram', tokenEnv: 'TG_TOKEN', chatIdEnv: 'TG_CHAT' },
      EVENT,
      env
    )
    assert.equal(
      'url' in r && r.url,
      'https://api.telegram.org/bot123456789:ABCdef0123456789XYZabc_-DEFghi/sendMessage'
    )
    const body = 'body' in r && (r.body as Record<string, unknown>)
    assert.equal(body && body.chat_id, '42')
    assert.equal(body && body.text, renderEventText(EVENT))
  })

  test('honors a literal chatId and apiBase', () => {
    const r = requestFor(
      {
        type: 'telegram',
        tokenEnv: 'TG_TOKEN',
        chatId: '7',
        apiBase: 'https://tg.internal.test/',
      },
      EVENT,
      env
    )
    assert.equal(
      'url' in r && r.url,
      'https://tg.internal.test/bot123456789:ABCdef0123456789XYZabc_-DEFghi/sendMessage'
    )
    assert.equal('body' in r && (r.body as Record<string, unknown>).chat_id, '7')
  })

  test('a cleartext apiBase is refused — the token rides the request URL', () => {
    const r = requestFor(
      {
        type: 'telegram',
        tokenEnv: 'TG_TOKEN',
        chatId: '7',
        apiBase: 'http://tg.internal.test',
      },
      EVENT,
      env
    )
    assert.deepEqual(r, {
      refused: 'apiBase must be https:// — the bot token rides the request URL',
    })
  })

  test('missing token or chat env reports the var', () => {
    assert.deepEqual(
      requestFor({ type: 'telegram', tokenEnv: 'NOPE', chatId: '1' }, EVENT, env),
      { missing: 'NOPE' }
    )
    assert.deepEqual(
      requestFor({ type: 'telegram', tokenEnv: 'TG_TOKEN', chatIdEnv: 'NOPE2' }, EVENT, env),
      { missing: 'NOPE2' }
    )
  })

  test('a malformed token is refused — path injection never reaches the wire', () => {
    const e = { T: 'not-a-token' } as unknown as NodeJS.ProcessEnv
    assert.deepEqual(
      telegramRequest({ type: 'telegram', tokenEnv: 'T', chatId: '1' }, EVENT, e),
      { refused: 'tokenEnv must hold a telegram bot token (<id>:<secret>)' }
    )
    const evil = { T: '1:abc/../admin' } as unknown as NodeJS.ProcessEnv
    assert.equal(
      'refused' in telegramRequest({ type: 'telegram', tokenEnv: 'T', chatId: '1' }, EVENT, evil),
      true
    )
  })
})

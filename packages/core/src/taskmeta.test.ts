import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bodyMeta, broTrailer, stripMeta, withMeta } from './taskmeta.ts'

describe('broTrailer', () => {
  test('a trailer at the end of the body is metadata', () => {
    const t = broTrailer('the work\n\n<!-- bro: {"type":"bug"} -->')
    assert.equal(t?.json, '{"type":"bug"}')
  })

  test('a bro: comment mid-prose is an example, not metadata', () => {
    assert.equal(broTrailer('see <!-- bro: {"x":1} --> above'), null)
    assert.equal(broTrailer('notes\n<!-- bro: {"x":1} -->\nmore notes'), null)
  })

  test('a bro: comment glued to a prose line is still prose', () => {
    assert.equal(broTrailer('docs end with <!-- bro: {"x":1} -->'), null)
    assert.equal(broTrailer('notes\n  <!-- bro: {"x":1} -->'), null)
  })

  test('a bro: comment inside a trailing code fence stays an example', () => {
    assert.equal(broTrailer('format:\n```\n<!-- bro: {"x":1} -->\n```\n'), null)
  })

  test('trailing whitespace after the trailer is fine', () => {
    assert.equal(broTrailer('work\n<!-- bro: {"x":1} -->\n\n')?.json, '{"x":1}')
  })

  test('a body that is only the trailer is metadata', () => {
    assert.equal(broTrailer('<!-- bro: {"x":1} -->')?.json, '{"x":1}')
    assert.equal(broTrailer('<!--bro:{"x":1}-->')?.json, '{"x":1}')
  })

  test('the last of several candidates wins', () => {
    const body = 'notes\n<!-- bro: {"x":1} -->\n\n<!-- bro: {"x":2} -->'
    assert.equal(broTrailer(body)?.json, '{"x":2}')
  })

  test('non-bro comments are ignored', () => {
    assert.equal(broTrailer('a <!-- note --> b\n<!-- bro: {"x":1} -->')?.json, '{"x":1}')
  })

  test('text after the last bro: comment demotes it to an example', () => {
    assert.equal(broTrailer('<!-- bro: {"x":1} -->\nappended by a human edit'), null)
  })
})

describe('bodyMeta / stripMeta', () => {
  test('a real trailer parses and strips', () => {
    const body = 'the work\n\n<!-- bro: {"type":"bug","priority":1} -->'
    assert.deepEqual(bodyMeta(body), { type: 'bug', priority: 1 })
    assert.equal(stripMeta(body), 'the work')
  })

  test('mid-prose bro: comments stay in the description and yield no meta', () => {
    const body = 'uses the format <!-- bro: {"x":1} --> in docs'
    assert.deepEqual(bodyMeta(body), {})
    assert.equal(stripMeta(body), body)
  })

  test('malformed or non-object JSON degrades to absent', () => {
    assert.deepEqual(bodyMeta('x\n\n<!-- bro: {nope} -->'), {})
    assert.deepEqual(bodyMeta('x\n\n<!-- bro: [1,2] -->'), {})
    assert.deepEqual(bodyMeta('x\n\n<!-- bro: 42 -->'), {})
    assert.deepEqual(bodyMeta(undefined), {})
  })
})

describe('withMeta', () => {
  test('writes the trailer last', () => {
    assert.equal(withMeta('the work', { type: 'bug' }), 'the work\n\n<!-- bro: {"type":"bug"} -->')
    assert.equal(withMeta('', { type: 'bug' }), '<!-- bro: {"type":"bug"} -->')
  })

  test('a prose bro: comment is preserved while the real trailer lands last', () => {
    const out = withMeta('docs mention <!-- bro: {"x":9} --> inline', { x: 1 })
    assert.equal(out, 'docs mention <!-- bro: {"x":9} --> inline\n\n<!-- bro: {"x":1} -->')
    assert.deepEqual(bodyMeta(out), { x: 1 })
  })

  test('empty meta returns the stripped body', () => {
    assert.equal(withMeta('work\n\n<!-- bro: {"x":1} -->', {}), 'work')
  })
})

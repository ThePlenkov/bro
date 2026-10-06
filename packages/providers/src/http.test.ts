import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { apiVersionedBase } from './http.ts'

describe('apiVersionedBase', () => {
  test('a bare host root mounts /v1; a base already versioned keeps its own', () => {
    assert.equal(apiVersionedBase('https://h.example'), 'https://h.example/v1')
    assert.equal(apiVersionedBase('https://h.example/'), 'https://h.example/v1')
    assert.equal(apiVersionedBase('https://h.example/api'), 'https://h.example/api/v1')
    assert.equal(apiVersionedBase('https://h.example/v1'), 'https://h.example/v1')
    assert.equal(apiVersionedBase('https://h.example/v2beta'), 'https://h.example/v2beta')
  })

  test('a version segment ending in a digit is still versioned — /v1beta1 gets no spurious /v1', () => {
    assert.equal(apiVersionedBase('https://h.example/v1beta1'), 'https://h.example/v1beta1')
    assert.equal(apiVersionedBase('https://h.example/api/v10alpha2'), 'https://h.example/api/v10alpha2')
    // …but a letter-only /v- segment is not a version — /v1 mounts anyway
    assert.equal(apiVersionedBase('https://h.example/vx'), 'https://h.example/vx/v1')
  })
})

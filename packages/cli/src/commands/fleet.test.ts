import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConvoyStep } from '@broject/convoy'
import type { AgentInfo } from '@broject/core'
import { agentCell } from './fleet.ts'

const step = (state: ConvoyStep['state']): ConvoyStep => ({
  id: 'bro-x',
  title: 't',
  description: '',
  type: 'agent',
  kind: 'agent',
  state,
  blockedBy: [],
})

const agent = (state: AgentInfo['state'], pid?: number): AgentInfo => ({
  id: 'native-ab12',
  molStep: 'bro-x',
  backend: 'native',
  state,
  pid,
})

describe('agentCell', () => {
  test('running agent renders state + pid', () => {
    assert.equal(agentCell(step('in_progress'), agent('running', 4242), 'me', false), 'running (pid 4242)')
  })

  test('a dead agent on a claimed step is the respawn surface', () => {
    assert.equal(
      agentCell(step('in_progress'), agent('lost', 4242), 'me', false),
      'lost — respawn?'
    )
  })

  test('a dead agent on an unclaimed step is just lost', () => {
    assert.equal(agentCell(step('ready'), agent('lost'), undefined, false), 'lost')
  })

  test('a degraded backend read renders unknown, never lost', () => {
    assert.equal(agentCell(step('in_progress'), undefined, 'me', true), 'unknown')
  })

  test('a claimed step with no agent names the assignee', () => {
    assert.equal(agentCell(step('in_progress'), undefined, 'alice', false), 'claimed — alice')
    assert.equal(agentCell(step('in_progress'), undefined, undefined, false), 'claimed — ?')
  })

  test('an unclaimed step with no agent is empty', () => {
    assert.equal(agentCell(step('ready'), undefined, undefined, false), '—')
    assert.equal(agentCell(step('blocked'), undefined, undefined, false), '—')
  })

  test('exited and stopped render plainly', () => {
    assert.equal(agentCell(step('done'), agent('exited'), undefined, false), 'exited')
    assert.equal(agentCell(step('in_progress'), agent('stopped'), undefined, false), 'stopped')
  })
})

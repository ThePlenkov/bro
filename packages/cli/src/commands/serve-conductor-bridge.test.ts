/** The bridge — an agent's tool call, in the client's vocabulary
 *  (spec bro-sy4q3). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientCall } from './serve-conductor-bridge.ts';
import { clientTools } from './serve-conductor-tools.ts';

const CLAUDE_TOOLS = clientTools([
  {
    name: 'Bash',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
]);

test('the capability decides the tool — the name never does', () => {
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls -la' } },
    CLAUDE_TOOLS
  );
  assert.equal(call?.name, 'Bash');
  assert.deepEqual(call?.input, { command: 'ls -la' });
});

test("the agent's 'path' is the client's 'file_path'", () => {
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x' } },
    CLAUDE_TOOLS
  );
  assert.equal(call?.name, 'Read');
  assert.deepEqual(call?.input, { file_path: '/tmp/x' });
});

test('the first candidate whose required fields are covered wins', () => {
  const edit = clientCall(
    {
      sessionUpdate: 'tool_call',
      kind: 'edit',
      rawInput: { path: '/tmp/x', old_string: 'a', new_string: 'b' },
    },
    CLAUDE_TOOLS
  );
  assert.equal(edit?.name, 'Edit');
  assert.deepEqual(edit?.input, { file_path: '/tmp/x', old_string: 'a', new_string: 'b' });
  // the same kind, an input only the Write can take
  const write = clientCall(
    { sessionUpdate: 'tool_call', kind: 'edit', rawInput: { path: '/tmp/x', content: 'hi' } },
    CLAUDE_TOOLS
  );
  assert.equal(write?.name, 'Write');
  assert.deepEqual(write?.input, { file_path: '/tmp/x', content: 'hi' });
});

test('a call the client cannot run is not invented', () => {
  // no tool of that capability
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'search', rawInput: { q: 'x' } }, CLAUDE_TOOLS),
    undefined
  );
  // the client offers nothing at all
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls' } }, []),
    undefined
  );
  // a required field the call does not carry — no invented argument
  assert.equal(
    clientCall(
      { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { timeout: 5 } },
      CLAUDE_TOOLS
    ),
    undefined
  );
  // not a tool call at all
  assert.equal(
    clientCall({ sessionUpdate: 'agent_message_chunk', kind: 'execute' }, CLAUDE_TOOLS),
    undefined
  );
  // the raw input is not an object
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'execute', rawInput: 'ls' }, CLAUDE_TOOLS),
    undefined
  );
});

test("the kind is the agent's — an inherited name is not a capability", () => {
  // every object carries "toString" and "constructor": a plain lookup finds
  // the prototype's function there and hands it to the tool matcher
  for (const kind of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.equal(
      clientCall({ sessionUpdate: 'tool_call', kind, rawInput: { command: 'ls' } }, CLAUDE_TOOLS),
      undefined
    );
  }
});

test("the schema's own shape wins — the extra fields are dropped", () => {
  const call = clientCall(
    {
      sessionUpdate: 'tool_call',
      kind: 'execute',
      rawInput: { command: 'ls', description: 'list it', sandbox: 'off' },
    },
    CLAUDE_TOOLS
  );
  assert.deepEqual(call?.input, { command: 'ls', description: 'list it' });
});

test("the vocabulary reads the request's own definitions", () => {
  const tools = clientTools([
    { name: 'Bash', input_schema: { properties: { command: {} }, required: ['command'] } },
    { name: '' },
    { description: 'no name' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'Bash');
  assert.deepEqual(tools[0]?.required, ['command']);
  assert.deepEqual(tools[0]?.properties, ['command']);
  assert.deepEqual(clientTools(undefined), []);
});

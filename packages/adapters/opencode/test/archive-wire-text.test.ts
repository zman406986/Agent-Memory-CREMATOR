// 1f diagnosis FIX 1, restated on the ISSUE-509 geometry: a unit archives the
// host's exact wire text.
//
// The unit body is the result's decoded text (`snapshot.ts` `opencodeUnitText`),
// so the archive holds exactly what the host sends and the bench's own lowering
// (`archivedResultWireText`) equals it byte for byte. Key order is therefore the
// host's: a cancelled `question` error keeps `error` before `content`, and a
// key-sorted spelling of the same value is a different byte string.
//
// The older envelope geometry (`{"input":…,"name":…,"result":…}`) hid that
// comparison behind JSON escaping and made every unit one line, which is what
// made a partial `keeplines` unaddressable. It is gone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
// The bench's plain-JS module has no declaration file; this test compares the
// archive with the bench's own lowering on purpose, so the import is the point.
// @ts-expect-error the bench module is JavaScript without a `.d.ts`
import { archivedResultWireText } from '../../../../dev/bench/opencode-run.mjs';
import {
  assistantMessage, errorResult, jsonResult, sessionId, text, textResult, toolCall,
  toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { OpencodeMessage, OpencodeToolResultPart, OpencodeToolResultValue } from '../src/host.js';
import { deriveOpencodeSnapshot } from '../src/snapshot.js';

/** The host's cancelled-`question` envelope: `error` first, `content` second. */
const CANCELLED_QUESTION = {
  error: {
    type: 'tool.execution',
    message: 'This non-interactive run cannot ask the user questions. '
      + 'Continue without an answer; make reasonable assumptions and state them.',
  },
  content: [],
};

/** One conversation carrying one structured `error` result. */
function errorConversation(value: unknown): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Audit the repository.')]),
    assistantMessage('msg_a1', [
      text('I hit a hard limit.'),
      toolCall('call_question', 'question', {
        questions: [{ question: 'Bounded audit or multi-session audit?' }],
      }),
    ]),
    toolMessage('msg_t1', [
      toolResult('call_question', 'question', { type: 'error', value } as OpencodeToolResultValue),
    ]),
    assistantMessage('msg_a2', [text('Continuing without an answer.')]),
  ];
}

/** The one result part of one conversation. */
function resultPartOf(messages: readonly OpencodeMessage[]): OpencodeToolResultPart {
  const part = messages[2]?.content[0];
  assert.ok(part !== undefined && part.type === 'tool-result', 'the fixture holds one result');
  return part as OpencodeToolResultPart;
}

/** The exact bytes the archive holds for one unit. */
function archivedUnitText(messages: readonly OpencodeMessage[]): string {
  const node = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .find(candidate => candidate.kind === 'tool-result');
  assert.ok(node !== undefined && node.kind === 'tool-result', 'the result is one unit');
  return new TextDecoder().decode(node.bytes);
}

test('1f FIX 1: a structured error result archives the host\'s wire text byte for byte', () => {
  const messages = errorConversation(CANCELLED_QUESTION);
  const hostWire = JSON.stringify(CANCELLED_QUESTION);
  assert.equal(archivedUnitText(messages), hostWire,
    'the archive body is the host\'s wire text, byte for byte');
  assert.equal(archivedResultWireText(resultPartOf(messages).result), hostWire,
    'the bench\'s own lowering of the same tagged value agrees');
  assert.equal(Buffer.from(archivedUnitText(messages), 'utf8').equals(Buffer.from(hostWire, 'utf8')),
    true, 'the comparison is over the exact UTF-8 bytes, not a parsed value');
  // The key order the old rule sorted away is the archive's own text.
  assert.equal(archivedUnitText(messages).includes('{"error":{"type":"tool.execution"'), true,
    'the value keeps the host\'s key order');
  // The old rule's spelling is the one that could never match.
  const sorted = JSON.stringify({
    content: CANCELLED_QUESTION.content, error: CANCELLED_QUESTION.error,
  });
  assert.notEqual(sorted, hostWire, 'the sorted text is a different byte string');
});

test('1f FIX 1: a string result is unchanged', () => {
  const body = '# Note\n\nbody\n';
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
    assistantMessage('msg_a2', [text('Read.')]),
  ];
  assert.equal(archivedUnitText(messages), body,
    'a text result archives its own bytes, newlines and all');
  assert.equal(archivedResultWireText(resultPartOf(messages).result), body,
    'the bench\'s lowering agrees');
});

test('1f FIX 1: the rule is wire text, so key order is preserved, not canonicalized', () => {
  const reordered = {
    content: CANCELLED_QUESTION.content,
    error: CANCELLED_QUESTION.error,
  };
  assert.equal(archivedUnitText(errorConversation(CANCELLED_QUESTION)),
    JSON.stringify(CANCELLED_QUESTION),
    'the first spelling matches its own host wire text');
  assert.equal(archivedUnitText(errorConversation(reordered)), JSON.stringify(reordered),
    'the reordered spelling matches its own host wire text');
  assert.notEqual(JSON.stringify(CANCELLED_QUESTION), JSON.stringify(reordered),
    'two key orders are two wire texts under the named basis (not one canonical text)');
  assert.equal(archivedUnitText(errorConversation(reordered))
    .includes('{"content":[],"error":{'), true,
  'the reordered value keeps its own order in the archive');
});

test('1f FIX 1: json results use the same rule as error results', () => {
  const value = { zeta: 1, alpha: { beta: 2, gamma: 3 } };
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('List it.')]),
    assistantMessage('msg_a1', [
      text('Listing.'),
      toolCall('call_json', 'glob', { pattern: '**/*.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_json', 'glob', jsonResult(value))]),
    assistantMessage('msg_a2', [text('Listed.')]),
  ];
  assert.equal(archivedUnitText(messages), JSON.stringify(value),
    'a json result archives the host\'s JSON text, key order included');
  assert.equal(archivedResultWireText(resultPartOf(messages).result), JSON.stringify(value),
    'the bench\'s lowering agrees');
  // A `json` result is JSON text whatever its value's type (audit F1).
  const stringValue: OpencodeMessage[] = [
    userMessage('msg_u1', [text('List it.')]),
    assistantMessage('msg_a1', [
      text('Listing.'),
      toolCall('call_json', 'glob', { pattern: '**/*.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_json', 'glob', jsonResult('abc'))]),
    assistantMessage('msg_a2', [text('Listed.')]),
  ];
  assert.equal(archivedUnitText(stringValue), '"abc"',
    'a json string value archives as its quoted JSON text, not the bare string');
  assert.equal(archivedResultWireText(resultPartOf(stringValue).result), '"abc"',
    'the bench\'s lowering agrees: a json string value is its JSON text');
});

test('1f FIX 1: an error result with a string value archives that string', () => {
  const messages = errorConversation(CANCELLED_QUESTION);
  const part = toolResult('call_question', 'question', errorResult('tool failed'));
  const stringMessages = messages.map((message) => message.id === 'msg_t1'
    ? { ...message, content: [part] } : message);
  assert.equal(archivedUnitText(stringMessages), 'tool failed',
    'a string error value keeps the host\'s lowering');
  assert.equal(archivedResultWireText(resultPartOf(stringMessages).result), 'tool failed',
    'the bench\'s lowering agrees');
});

test('1f FIX 1: a content result archives the host\'s joined text, empty entries dropped', () => {
  const content = {
    type: 'content',
    value: [
      { type: 'text', text: 'one' },
      { type: 'text', text: '' },
      { type: 'text', text: 'two' },
    ],
  } as OpencodeToolResultValue;
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read both.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', content)]),
    assistantMessage('msg_a2', [text('Read.')]),
  ];
  assert.equal(archivedUnitText(messages), 'one\ntwo',
    'the empty text entry is dropped before the newline join');
  assert.equal(archivedResultWireText(resultPartOf(messages).result), 'one\ntwo',
    'the bench\'s lowering agrees');
});

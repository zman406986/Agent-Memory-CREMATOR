// Snapshot gate for the 2.4.0 message model (ISSUE-192; ADR-0044):
// host `Message[]` → core `SessionSnapshot`.
//
// Table 1 owns identity, units and ordering: which host id (or position) becomes
// which node id, what an assistant message declares, how a call and its result
// become one unit, and how turn and step advance. Table 2 owns content: what each
// content part becomes — bytes on a node, or evidence attached to its neighbour.
// Table 3 owns the revision. The corpus stays its own test, because its claim is
// total accounting of a 2.4.0-shaped request rather than one shape.
//
// Every assertion names its row, so a red run says which shape broke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnitTracker, byteRangeForLines, isRefusedPruneAnchor, readJsonl20NoKeepallAnswer,
} from '@cremator/core';
import type { NodeId, PathEvidence, ToolResultNode, TranscriptNode } from '@cremator/core';
import { opencodeResultText, opencodeTextPayload } from '../src/apply.js';
import { OPENCODE_ASK_FLOOR_BYTES, askPromptOf, buildOpencodePassPlan } from '../src/ask.js';
import { createOpencodeToolClassifier } from '../src/classifier.js';
import type {
  OpencodeMessage, OpencodeToolResultPart, OpencodeToolResultValue,
} from '../src/host.js';
import {
  OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot, opencodeMessageNodeId, opencodePartNodeId,
  opencodeToolNodeId, opencodeUnitText,
} from '../src/snapshot.js';
import type { OpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, compactionPart, effortPart, errorResult, jsonResult, mediaPart,
  minimalConversation, reasoning, replayCorpus, sessionId, text, textResult, toolCall, toolMessage,
  toolResult, userMessage,
} from './fixtures.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';

const derive = (messages: readonly OpencodeMessage[]): OpencodeSnapshot =>
  deriveOpencodeSnapshot(messages, { sessionId });

const ids = (snapshot: OpencodeSnapshot): readonly NodeId[] =>
  snapshot.snapshot.nodes.map(node => node.id);

/** The one node with this id, or a failure that names the row asking for it. */
function nodeOf(snapshot: OpencodeSnapshot, id: NodeId, at: Label): TranscriptNode {
  const node = snapshot.snapshot.nodes.find(candidate => candidate.id === id);
  if (node === undefined) throw new Error(at(`no node ${id}`));
  return node;
}

/** The part keys attached to one node, in attachment order. */
function attachedKeys(snapshot: OpencodeSnapshot, id: NodeId): string[] {
  return (snapshot.attached.get(id) ?? []).map(evidence => evidence.partKey);
}

/**
 * Table 1 — identity, units and ordering. Each row is one host shape: the node
 * ids it must produce (written out, never derived from the derivation under
 * test), what its declaration nodes declare, and the ordinals the result holds.
 */
const IDENTITY_ROWS: readonly Row[] = [
  { name: 'the minimal conversation: host ids, one unit at its call, and its ordinals',
    run(at) {
      const snapshot = derive(minimalConversation());
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:msg:msg_u1',
        'oc:ses_test:part:msg_a1:0',
        'oc:ses_test:tool:call_1',
        'oc:ses_test:part:msg_a2:0',
      ], at('every node id is a message id, a part position, or a call id'));
      assert.deepEqual(ids(snapshot), [
        opencodeMessageNodeId(sessionId, 'msg_u1'),
        opencodePartNodeId(sessionId, 'msg_a1', 0),
        opencodeToolNodeId(sessionId, 'call_1'),
        opencodePartNodeId(sessionId, 'msg_a2', 0),
      ], at('the id helpers build the ids the snapshot carries'));
      // The text part is before the call, so it is the declarer; no stand-in.
      const head = nodeOf(snapshot, opencodePartNodeId(sessionId, 'msg_a1', 0), at);
      assert.deepEqual(head.kind === 'message' && head.toolCallIds, ['call_1'],
        at('the text node before the call declares it'));
      const unit = nodeOf(snapshot, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(unit.kind, 'tool-result', at('the call and result are one unit'));
      assert.equal(unit.kind === 'tool-result' && unit.callId, 'call_1',
        at('the unit names the call id'));
      assert.deepEqual(
        snapshot.snapshot.nodes.map(node => [node.turnOrdinal, node.stepOrdinal]),
        [[0, 0], [0, 1], [0, 1], [0, 2]],
        at('one assistant message is one step; the unit shares its call\'s step'),
      );
      assert.equal(snapshot.snapshot.currentTurnOrdinal, 0, at('one prompt leaves turn 0 current'));
      assert.equal(snapshot.snapshot.currentStepOrdinal, 2, at('the closing answer is the current step'));
      // The result message contributes no node: its one result is the unit.
      assert.equal(ids(snapshot).filter(id => id.includes('msg_t1')).length, 0,
        at('a role: tool message has no message node of its own'));
    } },
  { name: 'a message without an id is keyed by its position',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        { role: 'user', content: [text('anonymous')] },
        assistantMessage('msg_a1', [text('answer')]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:msg:pos:0',
        'oc:ses_test:part:msg_a1:0',
      ], at('the message with no id uses pos:<index>; the next host id is untouched'));
      const first = nodeOf(snapshot, 'oc:ses_test:msg:pos:0', at);
      assert.equal(new TextDecoder().decode(first.bytes), 'anonymous', at('its bytes are still read'));
    } },
  { name: 'a receipt marker is a record node and its content never becomes a prompt',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [text('go')]),
        userMessage('msg_r1', [text('[not retained] a.ts · necromancy recall:x')], {
          [OPENCODE_RECORD_ID_FIELD]: 'racoons-record:intent-1:0',
        }),
      ];
      const snapshot = derive(messages);
      const record = nodeOf(snapshot, opencodeMessageNodeId(sessionId, 'msg_r1'), at);
      assert.equal(record.kind, 'racoons-record', at('the receipt is a record node'));
      assert.equal(record.kind === 'racoons-record' && record.recordId,
        'racoons-record:intent-1:0', at('the record id is the marker'));
      assert.equal(record.bytes.byteLength > 0, true, at('the record carries the receipt bytes'));
      assert.equal(snapshot.snapshot.currentTurnOrdinal, 0, at('a record never opens a turn'));
      assert.equal(ids(snapshot).length, 2, at('the receipt content is not a node of its own'));
    } },
  { name: 'a tool-only assistant message declares on a bytes-empty stand-in',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [text('go')]),
        assistantMessage('msg_a1', [
          toolCall('call_1', 'read', { filePath: 'a.ts' }),
          toolCall('call_2', 'read', { filePath: 'b.ts' }),
        ]),
        toolMessage('msg_t1', [
          toolResult('call_1', 'read', textResult('a')),
          toolResult('call_2', 'read', textResult('b')),
        ]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:msg:msg_u1',
        'oc:ses_test:msg:msg_a1',
        'oc:ses_test:tool:call_1',
        'oc:ses_test:tool:call_2',
      ], at('the stand-in stands ahead of its two units'));
      const head = nodeOf(snapshot, opencodeMessageNodeId(sessionId, 'msg_a1'), at);
      assert.deepEqual(head.kind === 'message' && head.toolCallIds, ['call_1', 'call_2'],
        at('the stand-in declares both calls, in order'));
      assert.equal(head.byteLength, 0, at('the stand-in carries no bytes of its own'));
      // Every result names a call declared on a node before it.
      const nodes = snapshot.snapshot.nodes;
      for (const [index, node] of nodes.entries()) {
        if (node.kind !== 'tool-result') continue;
        const declarers = nodes.slice(0, index).filter(candidate => candidate.kind === 'message')
          .flatMap(candidate => candidate.kind === 'message' ? candidate.toolCallIds : []);
        assert.ok(declarers.includes(node.callId), at(`${node.id} has no preceding call`));
      }
    } },
  { name: 'a text part before the call is the declarer, so no stand-in is made',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          text('calling'),
          toolCall('call_x', 'read', { filePath: 'a.ts' }),
        ]),
        toolMessage('msg_t1', [toolResult('call_x', 'read', textResult('a'))]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:part:msg_a1:0',
        'oc:ses_test:tool:call_x',
      ], at('one text node and one unit, no stand-in'));
      const head = nodeOf(snapshot, opencodePartNodeId(sessionId, 'msg_a1', 0), at);
      assert.deepEqual(head.kind === 'message' && head.toolCallIds, ['call_x'],
        at('the text node declares the call'));
    } },
  { name: 'two prompts: the second opens turn 1, and steps never restart or decrease',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [text('one')]),
        assistantMessage('msg_a1', [text('first')]),
        userMessage('msg_u2', [text('two')]),
        assistantMessage('msg_a2', [text('second')]),
      ];
      const two = derive(messages);
      assert.deepEqual(two.snapshot.nodes.map(node => [node.turnOrdinal, node.stepOrdinal]),
        [[0, 0], [0, 1], [1, 1], [1, 2]], at('the second prompt opens turn 1 at the same step'));
      assert.equal(two.snapshot.currentTurnOrdinal, 1, at('turn 1 is the current turn'));
      assert.equal(two.snapshot.currentStepOrdinal, 2, at('steps stay global across turns'));
      for (let index = 1; index < two.snapshot.nodes.length; index += 1) {
        const previous = two.snapshot.nodes[index - 1];
        const node = two.snapshot.nodes[index];
        assert.ok(previous !== undefined && node !== undefined, at('both neighbours exist'));
        assert.ok(node.turnOrdinal >= previous.turnOrdinal, at(`turn decreases at index ${String(index)}`));
        assert.ok(node.stepOrdinal >= previous.stepOrdinal, at(`step decreases at index ${String(index)}`));
      }
    } },
  { name: 'a system message is a message node, opens no turn and advances no step',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        { role: 'system', id: 'msg_s1', content: [text('be brief')] },
        userMessage('msg_u1', [text('go')]),
        assistantMessage('msg_a1', [text('done')]),
      ];
      const snapshot = derive(messages);
      const system = nodeOf(snapshot, opencodeMessageNodeId(sessionId, 'msg_s1'), at);
      assert.equal(system.kind === 'message' && system.role, 'system', at('the role is system'));
      assert.deepEqual(system.kind === 'message'
        ? [system.turnOrdinal, system.stepOrdinal] : [], [0, 0],
      at('the system message sits at turn 0 step 0'));
      assert.equal(snapshot.snapshot.currentTurnOrdinal, 0, at('it opened no turn'));
      assert.equal(snapshot.snapshot.currentStepOrdinal, 1, at('only the assistant message advanced'));
    } },
  { name: 'a repeated call id is a hard error, never two nodes with one id',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          toolCall('call_x', 'read', { filePath: 'a.ts' }),
          toolCall('call_x', 'read', { filePath: 'b.ts' }),
        ]),
      ];
      assert.throws(() => derive(messages), /carried by 2 call parts/u,
        at('two call parts under one id refuse'));
    } },
  { name: 'a result before its call is a hard error',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        toolMessage('msg_t1', [toolResult('call_x', 'read', textResult('a'))]),
        assistantMessage('msg_a1', [toolCall('call_x', 'read', { filePath: 'a.ts' })]),
      ];
      assert.throws(() => derive(messages), /precedes its call/u,
        at('a result that precedes its call refuses'));
    } },
];

/** Five lines, each long enough that the read is one above-floor unit. */
const FIVE_LINES = [
  `line one ${'-'.repeat(120)}`,
  `line two ${'-'.repeat(120)}`,
  `line three ${'-'.repeat(120)}`,
  `line four ${'-'.repeat(120)}`,
  `line five ${'-'.repeat(120)}`,
];
const FIVE_LINE_BODY = `${FIVE_LINES.join('\n')}\n`;

/** One prompt, one read of `result`, one closing answer. */
function readConversation(result: OpencodeToolResultValue): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read NOTES.md.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', result)]),
    assistantMessage('msg_a2', [text('Read.')]),
  ];
}

/** The one result part of `readConversation`'s array. */
function readResultPart(messages: readonly OpencodeMessage[]): OpencodeToolResultPart {
  const part = messages[2]?.content[0];
  assert.ok(part !== undefined && part.type === 'tool-result', 'the fixture holds one result part');
  return part as OpencodeToolResultPart;
}

/** One prompt, one read returning a `content` result, one closing answer. */
function contentConversation(value: readonly unknown[]): OpencodeMessage[] {
  return readConversation({
    type: 'content', value,
  } as unknown as OpencodeToolResultValue);
}

/**
 * Table 2 — content and attachment. Each row is one content class: the bytes a
 * node carries, the kind it reports, or the evidence it leaves on a neighbour. A
 * part is never both, and never dropped.
 */
const CONTENT_ROWS: readonly Row[] = [
  { name: 'a user message joins its text parts and keeps media as evidence',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [text('one '), text('two'), mediaPart('a.ts')]),
      ];
      const snapshot = derive(messages);
      const user = nodeOf(snapshot, opencodeMessageNodeId(sessionId, 'msg_u1'), at);
      assert.equal(new TextDecoder().decode(user.bytes), 'one two', at('the parts join in content order'));
      assert.equal(user.kind === 'message' && user.role, 'user', at('a user message is a user node'));
      const attached = snapshot.attached.get(user.id) ?? [];
      assert.deepEqual(attached.map(evidence => evidence.partType), ['media'],
        at('media is evidence, not bytes'));
      assert.equal(attached[0]?.displayPath, 'a.ts', at('the evidence keeps the host filename'));
    } },
  { name: 'assistant text and reasoning are one node each, reasoning kept verbatim',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [text('why?')]),
        assistantMessage('msg_a1', [reasoning('first thought'), text('the answer')]),
      ];
      const snapshot = derive(messages);
      const thought = nodeOf(snapshot, opencodePartNodeId(sessionId, 'msg_a1', 0), at);
      const answer = nodeOf(snapshot, opencodePartNodeId(sessionId, 'msg_a1', 1), at);
      assert.equal(thought.kind, 'message', at('reasoning is a message node'));
      assert.equal(new TextDecoder().decode(thought.bytes), 'first thought',
        at('the reasoning text is verbatim'));
      assert.equal(thought.kind === 'message' && thought.role, 'assistant',
        at('reasoning is the assistant speaking'));
      assert.equal(new TextDecoder().decode(answer.bytes), 'the answer',
        at('the text part keeps its own bytes'));
    } },
  { name: 'one unit per call id, its body the result\'s decoded text',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          text('calling'),
          toolCall('call_ok', 'read', { filePath: 'a.ts' }),
          toolCall('call_bad', 'grep', { pattern: 'needle' }),
        ]),
        toolMessage('msg_t1', [
          toolResult('call_ok', 'read', textResult('body')),
          toolResult('call_bad', 'grep', errorResult('no such dir')),
        ]),
      ];
      const snapshot = derive(messages);
      const results = snapshot.snapshot.nodes.filter((node): node is ToolResultNode =>
        node.kind === 'tool-result');
      assert.deepEqual(results.map(node => node.callId), ['call_ok', 'call_bad'],
        at('both terminal results are units'));
      assert.deepEqual(results.map(node => node.id), [
        opencodeToolNodeId(sessionId, 'call_ok'),
        opencodeToolNodeId(sessionId, 'call_bad'),
      ], at('each unit is keyed by its call id'));
      assert.equal(new TextDecoder().decode(results[0]?.bytes ?? new Uint8Array()), 'body',
        at('a text result is its own text, not a {"input","name","result"} envelope'));
      assert.equal(new TextDecoder().decode(results[1]?.bytes ?? new Uint8Array()), 'no such dir',
        at('an error result is its text too, never a flattened tag'));
      // Evidence reads the call, not the result.
      assert.equal(results[0]?.evidence.kind, 'read', at('the call name decides the kind'));
      assert.deepEqual(results[0]?.evidence.target, { key: 'a.ts', label: 'a.ts' },
        at('the call input decides the target'));
      assert.equal(results[0]?.evidence.paths[0]?.lineCount, 1,
        at('a one-line body measures one line'));
      assert.equal(results[0]?.evidence.paths[0]?.byteLength, 4,
        at('the evidence measures the body text'));
    } },
  { name: 'a multi-line text read is N lines and keeplines 2-3 addresses its real bytes',
    run(at) {
      const messages = readConversation(textResult(FIVE_LINE_BODY));
      const snapshot = derive(messages);
      const node = nodeOf(snapshot, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(node.kind, 'tool-result', at('the read is one unit'));
      if (node.kind !== 'tool-result') return;
      assert.equal(new TextDecoder().decode(node.bytes), FIVE_LINE_BODY,
        at('the unit body is the result text the host sends'));

      const units = new UnitTracker({ sessionId, barBytes: OPENCODE_ASK_FLOOR_BYTES })
        .units(snapshot.snapshot);
      const unit = units[0];
      assert.equal(units.length, 1, at('an above-floor read is one unit'));
      assert.deepEqual(unit?.span.lineRange, { startLine: 1, endLineInclusive: 5 },
        at('the unit is as many lines as the result text, not one'));

      const plan = buildOpencodePassPlan({
        sessionId, snapshot: snapshot.snapshot, messages, round: 1,
      });
      assert.equal(plan?.askRows.length, 1, at('the read is tabled'));
      assert.match(askPromptOf(plan?.askRows ?? [], true), /\[5 lines\]/u,
        at('the asked table states the result\'s real line count'));
      const anchor = plan?.askRows[0]?.anchor;
      assert.ok(anchor !== undefined && !isRefusedPruneAnchor(anchor),
        at('the row carries a readable anchor'));
      if (anchor !== undefined && !isRefusedPruneAnchor(anchor)) {
        assert.match(anchor.anchors.join(' '), /of 5\b|of 5$/u,
          at('the anchor counts the result text\'s own lines'));
        assert.doesNotMatch(anchor.anchors.join(' '), /"input"|"name"|"result"/u,
          at('the anchor quotes the result text, not the old envelope'));
      }

      // A partial `keeplines` for lines 2-3: the reader accepts it against L=5,
      // and the core's own line arithmetic maps it onto the result's bytes.
      const reading = readJsonl20NoKeepallAnswer(
        '{"1":{"keeplines":[[2,3]],"summary":"None"}}', [1], new Map([[1, 5]]));
      assert.equal(reading.rows[0]?.status, 'answered',
        at('the reader accepts a partial keep inside 1..5'));
      const range = byteRangeForLines(node.bytes, [{ startLine: 2, endLineInclusive: 3 }])[0];
      assert.ok(range !== undefined, at('lines 2-3 have a byte range'));
      if (range === undefined) return;
      assert.equal(
        new TextDecoder().decode(node.bytes.slice(range.startByte, range.endByteExclusive)),
        `${FIVE_LINES[1]}\n${FIVE_LINES[2]}\n`,
        at('the range is those two lines of the result text'));
      assert.equal(node.evidence.paths[0]?.lineCount, 5,
        at('the path evidence measures the same five lines'));
      assert.equal(opencodeTextPayload(readResultPart(messages))?.text, FIVE_LINE_BODY,
        at('the apply can re-emit exactly the text the archive holds'));
    } },
  { name: 'a single-line result is one line, and an empty one is the host\'s own literal',
    run(at) {
      const single = readConversation(textResult('only line'));
      const oneUnit = new UnitTracker({ sessionId, barBytes: 0 })
        .units(derive(single).snapshot);
      assert.deepEqual(oneUnit[0]?.span.lineRange, { startLine: 1, endLineInclusive: 1 },
        at('a one-line body is one line'));
      const singleNode = nodeOf(derive(single), opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(singleNode.kind === 'tool-result' && singleNode.evidence.paths[0]?.lineCount, 1,
        at('its evidence count is one, never null'));

      const empty = readConversation(textResult(''));
      const emptyNode = nodeOf(derive(empty), opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(emptyNode.bytes), '(no tool output)',
        at('an empty text result is the literal the host substitutes on the wire'));
      const emptyUnits = new UnitTracker({ sessionId, barBytes: 0 })
        .units(derive(empty).snapshot);
      assert.deepEqual(emptyUnits[0]?.span.lineRange, { startLine: 1, endLineInclusive: 1 },
        at('the host literal is one line'));
    } },
  { name: 'a json or error result keeps the safe whole-unit behavior',
    run(at) {
      const jsonMessages = readConversation(jsonResult(['a', 'b']));
      const jsonNode = nodeOf(derive(jsonMessages), opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(jsonNode.kind === 'tool-result'
        && new TextDecoder().decode(jsonNode.bytes), '["a","b"]',
      at('a json result body is its JSON text'));
      assert.equal(jsonNode.kind === 'tool-result' && jsonNode.evidence.paths[0]?.lineCount, 1,
        at('the JSON text measures one line'));
      assert.equal(opencodeTextPayload(readResultPart(jsonMessages)), null,
        at('a json result cannot carry kept lines'));

      const errorMessages = readConversation(errorResult('ENOENT: no such file'));
      const errorNode = nodeOf(derive(errorMessages), opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(errorNode.kind === 'tool-result'
        && new TextDecoder().decode(errorNode.bytes), 'ENOENT: no such file',
      at('an error result body is its text'));
      assert.equal(errorNode.kind === 'tool-result'
        && errorNode.evidence.paths[0]?.outcome, 'miss',
      at('the error tag is still a miss'));
      assert.equal(errorNode.kind === 'tool-result'
        && errorNode.evidence.paths[0]?.lineCount, null,
      at('a miss measures no file lines'));
      assert.equal(opencodeTextPayload(readResultPart(errorMessages)), null,
        at('an error result cannot carry kept lines'));
    } },
  { name: 'the unit text is the apply path\'s result text for every tag',
    run(at) {
      const cases: readonly (readonly [string, OpencodeToolResultValue, string])[] = [
        ['text', textResult('a\nb\n'), 'a\nb\n'],
        ['empty text', textResult(''), '(no tool output)'],
        ['content', { type: 'content', value: [
          { type: 'text', text: 'one' },
          { type: 'text', text: '' },
          { type: 'text', text: 'two' },
        ] } as OpencodeToolResultValue, 'one\ntwo'],
        ['file-only content', { type: 'content', value: [
          { type: 'file', path: 'a.ts' },
        ] } as unknown as OpencodeToolResultValue, ''],
        ['json', jsonResult({ a: 1 }), '{"a":1}'],
        ['json string', jsonResult('abc'), '"abc"'],
        ['json null', jsonResult(null), 'null'],
        ['error string', errorResult('boom'), 'boom'],
        ['error number', { type: 'error', value: 5 } as OpencodeToolResultValue, '5'],
        ['error structured', { type: 'error', value: { code: 'E' } } as OpencodeToolResultValue,
          '{"code":"E"}'],
        ['malformed content string',
          { type: 'content', value: 'abc' } as unknown as OpencodeToolResultValue, '"abc"'],
      ];
      for (const [label, result, expected] of cases) {
        const part = toolResult('call_1', 'read', result) as OpencodeToolResultPart;
        assert.equal(opencodeUnitText(part), expected, at(`${label}: the unit text is the host text`));
        assert.equal(opencodeUnitText(part), opencodeResultText(part),
          at(`${label}: the snapshot decoder and the apply decoder agree`));
      }
    } },
  { name: 'a call with no result is evidence, never a node',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          text('calling'),
          toolCall('call_open', 'read', { filePath: 'a.ts' }),
        ]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:part:msg_a1:0',
      ], at('the unfinished call adds no node'));
      const attached = snapshot.attached.get(opencodePartNodeId(sessionId, 'msg_a1', 0)) ?? [];
      assert.deepEqual(attached.map(evidence => [evidence.partType, evidence.partKey, evidence.status]),
        [['tool-call', 'call_open', 'call']],
        at('the call is evidence on the text node, with the call id and a call status'));
    } },
  { name: 'a result with no call is still a unit, and its apply refusal is named',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        toolMessage('msg_t1', [
          toolResult('call_orphan', 'read', textResult('a')),
          toolResult('call_orphan_json', 'glob', jsonResult('abc')),
        ]),
      ];
      const snapshot = derive(messages);
      const orphan = nodeOf(snapshot, opencodeToolNodeId(sessionId, 'call_orphan'), at);
      assert.equal(orphan.kind, 'tool-result', at('the result is projected'));
      assert.equal(orphan.kind === 'tool-result' && orphan.callId, 'call_orphan',
        at('its call id is carried'));
      assert.equal(orphan.kind === 'tool-result'
        && new TextDecoder().decode(orphan.bytes), 'a',
      at('an orphan body is its decoded text, not a {name,result} envelope'));
      // The orphan lane uses the same decoding as a paired unit: a `json`
      // string value is JSON text (audit F1).
      const jsonOrphan = nodeOf(snapshot, opencodeToolNodeId(sessionId, 'call_orphan_json'), at);
      assert.equal(jsonOrphan.kind === 'tool-result'
        && new TextDecoder().decode(jsonOrphan.bytes), '"abc"',
      at('a json orphan body is the host\'s JSON text'));
      assert.equal(ids(snapshot).length, 2, at('one result is one unit'));
    } },
  { name: 'a tool part in a user or system message is refused, not silently dropped',
    run(at) {
      assert.throws(() => derive([
        userMessage('msg_u1', [text('go'), toolCall('call_1', 'read', { filePath: 'a.ts' })]),
      ]), /carries a tool part/u, at('a user message with a call refuses'));
      assert.throws(() => derive([
        { role: 'system', id: 'msg_s1',
          content: [toolResult('call_1', 'read', textResult('a'))] },
      ]), /carries a tool part/u, at('a system message with a result refuses'));
    } },
  { name: 'evidence ahead of the first node attaches forward',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [mediaPart('a.ts'), text('the prompt')]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(attachedKeys(snapshot, opencodeMessageNodeId(sessionId, 'msg_u1')), ['p0'],
        at('a part with no previous node attaches to the next one'));
    } },
  { name: 'no node at all: every part is reported unanchored, never invented into a node',
    run(at) {
      const snapshot = derive([assistantMessage('msg_only', [mediaPart('a.ts')])]);
      assert.deepEqual(ids(snapshot), [], at('a media-only assistant message makes no node'));
      assert.deepEqual(snapshot.unanchored.map(evidence => evidence.partKey), ['p0'],
        at('the unplaceable part is reported, not dropped'));
    } },
  { name: 'unknown parts, compaction and effort are evidence on the nearest node',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        userMessage('msg_u1', [
          text('go'),
          { type: 'dialogue-table', rows: 3 },
          compactionPart(),
          effortPart(),
        ]),
        assistantMessage('msg_a1', [
          { type: 'brand-new-part' },
          text('done'),
        ]),
      ];
      const snapshot = derive(messages);
      assert.deepEqual(ids(snapshot), [
        'oc:ses_test:msg:msg_u1',
        'oc:ses_test:part:msg_a1:1',
      ], at('the unmodelled parts add no node'));
      assert.deepEqual(attachedKeys(snapshot, opencodeMessageNodeId(sessionId, 'msg_u1')),
        ['p1', 'p2', 'p3', 'p0'],
        at('the user parts and the assistant unknown part attach to the prompt'));
      const compaction = (snapshot.attached.get(opencodeMessageNodeId(sessionId, 'msg_u1')) ?? [])
        .find(evidence => evidence.partType === 'compaction');
      assert.equal(compaction?.hostCompaction, true, at('a compaction part is flagged, never interpreted'));
      const attached = [...snapshot.attached.values()].flat().map(evidence => evidence.partKey);
      assert.deepEqual(attached.slice().sort(), ['p0', 'p1', 'p2', 'p3'],
        at('every non-node part is accounted for'));
      assert.deepEqual(snapshot.unanchored, [], at('nothing is left unplaceable'));
    } },
  { name: 'unknown part types and JSON results digest deterministically',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          text('calling'),
          toolCall('call_1', 'glob', { pattern: '**/*.md', options: { hidden: false } }),
        ]),
        toolMessage('msg_t1', [toolResult('call_1', 'glob', jsonResult(['b.md', 'a.md']))]),
      ];
      const first = derive(messages);
      const second = derive(structuredClone(messages) as OpencodeMessage[]);
      assert.deepEqual(first, second, at('the same request derives the same snapshot'));
      const unit = nodeOf(first, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(unit.bytes), '["b.md","a.md"]',
        at('a json result is the JSON text the host sends'));
    } },
  { name: 'the classifier the caller supplies is the one the evidence uses',
    run(at) {
      const messages: readonly OpencodeMessage[] = [
        assistantMessage('msg_a1', [
          text('searching'),
          toolCall('call_x', 'my-search', { pattern: 'needle' }),
        ]),
        toolMessage('msg_t1', [toolResult('call_x', 'my-search', textResult(''))]),
      ];
      const evidenceOf = (snapshot: OpencodeSnapshot) => {
        const node = snapshot.snapshot.nodes.find(candidate => candidate.kind === 'tool-result');
        if (node === undefined || node.kind !== 'tool-result') throw new Error(at('no result node'));
        return node.evidence;
      };
      assert.equal(evidenceOf(derive(messages)).kind, 'other',
        at('the shipped classifier does not know the tool'));
      const search = evidenceOf(deriveOpencodeSnapshot(messages, {
        sessionId, classifier: createOpencodeToolClassifier({ table: { 'my-search': 'search' } }),
      }));
      assert.equal(search.kind, 'search', at('the supplied table decides the kind'));
      assert.deepEqual(search.target, { key: 'needle', label: 'needle' },
        at('the supplied kind still reads the target from the call'));
    } },
];

/**
 * Table 3 — the revision. The same array twice is the same snapshot; any body
 * change moves the revision even when no node id moves.
 */
const REVISION_ROWS: readonly Row[] = [
  { name: 're-deriving the same array twice is a deep-equal snapshot, revision included',
    run(at) {
      const first = derive(minimalConversation());
      const second = derive(minimalConversation());
      assert.deepEqual(first, second, at('the same array derives the same snapshot'));
      assert.equal(first.snapshot.revision, second.snapshot.revision, at('the revision repeats'));
      const messages = minimalConversation();
      const before = structuredClone(messages);
      derive(messages);
      assert.deepEqual(messages, before, at('deriving never writes the input'));
      assert.match(first.snapshot.revision, /^oc:4:[0-9a-f]{64}$/u,
        at('the revision is oc:<message count>:<digest>'));
    } },
  { name: 'a body-only result change moves the revision and leaves the ids alone',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      const result = changed[2]?.content[0];
      assert.ok(result !== undefined && result['type'] === 'tool-result',
        at('the fixture has a result part'));
      (result['result'] as { value: unknown }).value = 'a different body';
      const next = derive(changed);
      assert.notEqual(next.snapshot.revision, base.snapshot.revision,
        at('a result-body update moves the revision'));
      assert.deepEqual(ids(next), ids(base), at('no node id moved'));
    } },
  { name: 'a call-input change moves the revision through the call digest',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      const call = changed[1]?.content[1];
      assert.ok(call !== undefined && call['type'] === 'tool-call', at('the fixture has a call part'));
      (call['input'] as Record<string, unknown>)['filePath'] = 'OTHER.md';
      const next = derive(changed);
      assert.notEqual(next.snapshot.revision, base.snapshot.revision,
        at('the body is the result text now, so the call declaration is its own digest entry'));
      assert.deepEqual(ids(next), ids(base), at('the unit id is still the call id'));
    } },
  { name: 'a tool-name change moves the revision',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      const call = changed[1]?.content[1];
      assert.ok(call !== undefined && call['type'] === 'tool-call', at('the fixture has a call part'));
      (call as Record<string, unknown>)['name'] = 'shell';
      const next = derive(changed);
      assert.notEqual(next.snapshot.revision, base.snapshot.revision,
        at('the tool name is part of the call declaration digest'));
      assert.deepEqual(ids(next), ids(base), at('no node id moved'));
    } },
  { name: 'a namespace-only change moves the revision, on the call or the result',
    run(at) {
      const base = derive(minimalConversation());
      const onCall = structuredClone(minimalConversation()) as OpencodeMessage[];
      const call = onCall[1]?.content[1];
      assert.ok(call !== undefined && call['type'] === 'tool-call', at('the fixture has a call part'));
      (call as Record<string, unknown>)['namespace'] = 'file';
      const callNext = derive(onCall);
      assert.notEqual(callNext.snapshot.revision, base.snapshot.revision,
        at('the call namespace is part of the digest'));
      assert.deepEqual(ids(callNext), ids(base), at('no node id moved'));
      const onResult = structuredClone(minimalConversation()) as OpencodeMessage[];
      const result = onResult[2]?.content[0];
      assert.ok(result !== undefined && result['type'] === 'tool-result',
        at('the fixture has a result part'));
      (result as Record<string, unknown>)['namespace'] = 'file';
      const resultNext = derive(onResult);
      assert.notEqual(resultNext.snapshot.revision, base.snapshot.revision,
        at('the result namespace is part of the digest too'));
      assert.deepEqual(ids(resultNext), ids(base), at('no node id moved'));
    } },
  { name: 'an absent input and a null input are two revisions',
    run(at) {
      const withNull = structuredClone(minimalConversation()) as OpencodeMessage[];
      const nullCall = withNull[1]?.content[1];
      assert.ok(nullCall !== undefined && nullCall['type'] === 'tool-call',
        at('the fixture has a call part'));
      (nullCall as Record<string, unknown>)['input'] = null;
      const withAbsent = structuredClone(minimalConversation()) as OpencodeMessage[];
      const absentCall = withAbsent[1]?.content[1];
      assert.ok(absentCall !== undefined && absentCall['type'] === 'tool-call',
        at('the fixture has a call part'));
      delete (absentCall as Record<string, unknown>)['input'];
      const base = derive(minimalConversation());
      const nulled = derive(withNull);
      const absent = derive(withAbsent);
      assert.notEqual(nulled.snapshot.revision, base.snapshot.revision,
        at('a null input moves the revision'));
      assert.notEqual(absent.snapshot.revision, base.snapshot.revision,
        at('an absent input moves the revision'));
      assert.notEqual(absent.snapshot.revision, nulled.snapshot.revision,
        at('an absent input is not the same request as a null one'));
    } },
  { name: 'a result-tag change moves the revision though the body bytes do not',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      const result = changed[2]?.content[0] as unknown as
        { result: { type: string } } | undefined;
      assert.ok(result !== undefined, at('the fixture has a result part'));
      result.result.type = 'error';
      const next = derive(changed);
      const before = nodeOf(base, opencodeToolNodeId(sessionId, 'call_1'), at);
      const after = nodeOf(next, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(after.bytes),
        new TextDecoder().decode(before.bytes),
        at('text and error carry the same value, so the body is unchanged'));
      assert.notEqual(next.snapshot.revision, base.snapshot.revision,
        at('the result tag is part of the declaration digest: hit becomes miss'));
      assert.deepEqual(ids(next), ids(base), at('no node id moved'));
    } },
  { name: 'a dropped content entry moves the revision though the body bytes do not',
    run(at) {
      const textOnly = derive(contentConversation([{ type: 'text', text: 'x' }]));
      const textOnlyNode = nodeOf(textOnly, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(textOnlyNode.bytes), 'x',
        at('the fixture body is its one text entry'));
      // A file entry contributes no text, so the body is still `x`; it makes the
      // result non-carryable for a partial keep.
      const withFile = derive(contentConversation([
        { type: 'text', text: 'x' },
        { type: 'file', uri: 'file:///a.ts', mime: 'text/plain' },
      ]));
      const fileNode = nodeOf(withFile, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(fileNode.bytes), 'x',
        at('a file entry leaves the body text unchanged'));
      assert.notEqual(withFile.snapshot.revision, textOnly.snapshot.revision,
        at('a non-text content entry is part of the declaration digest'));
      assert.deepEqual(ids(withFile), ids(textOnly), at('no node id moved'));
      // An empty text entry is dropped before the join and refused by the apply
      // for the same reason, so it is residue too.
      const withEmpty = derive(contentConversation([
        { type: 'text', text: 'x' },
        { type: 'text', text: '' },
      ]));
      const emptyNode = nodeOf(withEmpty, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(emptyNode.bytes), 'x',
        at('an empty text entry leaves the body text unchanged'));
      assert.notEqual(withEmpty.snapshot.revision, textOnly.snapshot.revision,
        at('an empty text entry is part of the declaration digest'));
      assert.deepEqual(ids(withEmpty), ids(textOnly), at('no node id moved'));
    } },
  { name: 'a result-part-name-only change moves the revision',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      const result = changed[2]?.content[0];
      assert.ok(result !== undefined && result['type'] === 'tool-result',
        at('the fixture has a result part'));
      (result as Record<string, unknown>)['name'] = 'shell';
      const next = derive(changed);
      const before = nodeOf(base, opencodeToolNodeId(sessionId, 'call_1'), at);
      const after = nodeOf(next, opencodeToolNodeId(sessionId, 'call_1'), at);
      assert.equal(new TextDecoder().decode(after.bytes),
        new TextDecoder().decode(before.bytes), at('the body is unchanged'));
      assert.notEqual(next.snapshot.revision, base.snapshot.revision,
        at('the result part name is part of the declaration digest'));
      assert.deepEqual(ids(next), ids(base), at('no node id moved'));
    } },
  { name: 'a part that becomes evidence moves the revision',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      changed[3]?.content.push(effortPart('high'));
      assert.notEqual(derive(changed).snapshot.revision, base.snapshot.revision,
        at('a new evidence part is a new request'));
    } },
  { name: 'a body-only change to an evidence part moves the revision',
    run(at) {
      const base = derive(minimalConversation());
      const changed = structuredClone(minimalConversation()) as OpencodeMessage[];
      changed[0]?.content.push(compactionPart('summary one'));
      const first = derive(changed);
      const second = structuredClone(changed) as OpencodeMessage[];
      const part = second[0]?.content[1];
      assert.ok(part !== undefined, at('the fixture has the compaction part'));
      (part as Record<string, unknown>)['text'] = 'summary two';
      assert.deepEqual(ids(derive(second)), ids(first), at('the node id list is identical'));
      assert.notEqual(derive(second).snapshot.revision, first.snapshot.revision,
        at('a body-only change to an evidence part moves the revision'));
    } },
];

test('node identity, units, declarations and ordinals — one row per host shape', async () => {
  await runRows(IDENTITY_ROWS);
});

test('what each content part becomes — bytes, a node kind, or attached evidence', async () => {
  await runRows(CONTENT_ROWS);
});

test('the revision: deterministic over one request, moved by any body change', async () => {
  await runRows(REVISION_ROWS);
});

/** One read conversation whose result and arguments are the fact under test. */
function oneRead(
  callId: string, input: Readonly<Record<string, unknown>>, result: OpencodeToolResultValue,
): OpencodeMessage[] {
  return [
    userMessage('msg_u_read', [text('Read the file.')]),
    assistantMessage(`msg_a_${callId}`, [toolCall(callId, 'read', input)]),
    toolMessage(`msg_t_${callId}`, [toolResult(callId, 'read', result)]),
    assistantMessage('msg_a_read_end', [text('Read it.')]),
  ];
}

/** The read unit's first path evidence, from the adapter's own derivation. */
function readPathEvidence(
  messages: readonly OpencodeMessage[], callId: string,
): PathEvidence {
  const snapshot = derive(messages);
  const node = snapshot.snapshot.nodes.find(candidate =>
    candidate.id === opencodeToolNodeId(sessionId, callId));
  if (node === undefined || node.kind !== 'tool-result') {
    throw new Error(`no read unit node for ${callId}`);
  }
  const path = node.evidence.paths[0];
  if (path === undefined) throw new Error(`no path evidence for ${callId}`);
  return path;
}

test('a stale completed-turn fact cannot lower currentTurn - 1', () => {
  /*
   * ISSUE-300 G2: the idle fact may be stale by the time a later transform
   * runs. The snapshot takes max(supplied, currentTurn - 1), so turn 0 being
   * complete never pulls the completed-through ordinal below the projection's
   * own default (turn 1 is complete once turn 2 opens).
   */
  const messages = [
    userMessage('msg_u1', [text('one')]),
    userMessage('msg_u2', [text('two')]),
    userMessage('msg_u3', [text('three')]),
  ];
  const snapshot = deriveOpencodeSnapshot(messages, {
    sessionId, completedThroughTurnOrdinal: 0,
  }).snapshot;
  assert.equal(snapshot.currentTurnOrdinal, 2, 'three user messages: turns 0, 1 and 2');
  assert.equal(snapshot.completedThroughTurnOrdinal, 1,
    'max(stale 0, currentTurn - 1 = 1) keeps the projection default');
});

test('a completed-turn fact cannot exceed the rebuilt array current turn', () => {
  /*
   * ISSUE-300 G6: an idle at turn 1, then a truncated or compacted rebuild of
   * one turn. The fact must clamp to the rebuilt current ordinal; core refuses
   * `completedThroughTurnOrdinal > currentTurnOrdinal` (`invalid-plan`,
   * transcript ordinal), which would stop every later at-rest and prune plan.
   */
  const messages = [userMessage('msg_u1', [text('one')])];
  const snapshot = deriveOpencodeSnapshot(messages, {
    sessionId, completedThroughTurnOrdinal: 1,
  }).snapshot;
  assert.equal(snapshot.currentTurnOrdinal, 0, 'one user message: turn 0');
  assert.equal(snapshot.completedThroughTurnOrdinal, 0,
    'a fact one turn ahead is clamped to the current turn');
  assert.equal(snapshot.completedThroughTurnOrdinal <= snapshot.currentTurnOrdinal, true,
    'the ordinal pair is inside the range core accepts');
});

test('a read result states its outcome and coverage from host data', () => {
  /*
   * The snapshot used to mark every read a hit and never set coverage. Each
   * row below is one host fact: the structured error tag, a range argument,
   * the host's truncation notice, and an ordinary whole read. The error,
   * ranged and whole rows fail if the derivation is removed; the truncated
   * row fails if a hit is ever claimed full without checking the notice.
   */
  const miss = readPathEvidence(oneRead('call_miss', { filePath: 'GONE.md' },
    errorResult('ENOENT: no such file or directory')), 'call_miss');
  assert.equal(miss.outcome, 'miss', 'the structured error tag is a miss');
  assert.equal(Object.hasOwn(miss, 'coverage'), false, 'a miss carries no coverage');

  const ranged = readPathEvidence(oneRead('call_ranged',
    { filePath: 'BIG.md', offset: 10, limit: 5 }, textResult('lines 10-14')), 'call_ranged');
  assert.equal(ranged.outcome, 'hit', 'a successful ranged read is a hit');
  assert.equal(ranged.coverage, 'partial', 'offset/limit names a partial read');

  const truncated = readPathEvidence(oneRead('call_truncated', { filePath: 'BIG.md' },
    textResult('head\n[showing lines 1-2000 of 5000; full output saved to /tmp/full.txt]\n')),
  'call_truncated');
  assert.equal(truncated.outcome, 'hit', 'a truncated read is still a hit');
  assert.equal(Object.hasOwn(truncated, 'coverage'), false,
    'the host truncation notice means no full coverage claim');

  const whole = readPathEvidence(oneRead('call_whole', { filePath: 'OK.md' },
    textResult('the whole file')), 'call_whole');
  assert.equal(whole.outcome, 'hit', 'an ordinary read is a hit');
  assert.equal(whole.coverage, 'full', 'an untruncated, unranged read is full');

  // The miss comes from the tag, never a text search: a successful body that
  // contains the word ENOENT is still a hit.
  const word = readPathEvidence(oneRead('call_word', { filePath: 'LOG.md' },
    textResult('the log says ENOENT but the file exists')), 'call_word');
  assert.equal(word.outcome, 'hit', 'the word ENOENT in a success body is not a miss');
  assert.equal(word.coverage, 'full', 'the successful whole read stays full');
});

test('every 2.4.0 read-truncation notice form withholds the full-coverage claim', () => {
  /*
   * ISSUE-536: 2.4.0 builds the notice from one template with four forms. The
   * adapter matched only the plain saved form, so a cut last line, a failed
   * save, or a zero-line cut was recorded as a whole-file read and the core
   * could remove an earlier whole read as superseded. Every form must claim no
   * coverage; an ordinary untruncated read still claims full.
   */
  const cases: readonly (readonly [string, string])[] = [
    ['plain', '[showing lines 1-2000 of 5000; full output saved to /tmp/full.txt]'],
    ['last line cut',
      '[showing lines 1-2000 (last line cut) of 5000; full output saved to /tmp/full.txt]'],
    ['save failed', '[showing lines 1-2000 of 5000; full output could not be saved: EACCES]'],
    ['zero lines', '[showing 0 lines of 5000; full output saved to /tmp/full.txt]'],
  ];
  for (const [label, notice] of cases) {
    const read = readPathEvidence(oneRead('call_notice', { filePath: 'BIG.md' },
      textResult(`head\n${notice}\n`)), 'call_notice');
    assert.equal(read.outcome, 'hit', `${label}: a truncated read is still a hit`);
    assert.equal(Object.hasOwn(read, 'coverage'), false,
      `${label}: the truncation notice means no full-coverage claim`);
  }
  const whole = readPathEvidence(oneRead('call_whole_536', { filePath: 'OK.md' },
    textResult('the whole file')), 'call_whole_536');
  assert.equal(whole.coverage, 'full', 'an untruncated read still claims full coverage');
});

test('a failed tool result carries the failure flag on its evidence', () => {
  /*
   * ISSUE-328 parity with dsh: the host's structured error tag travels on
   * ToolEvidence as `failed`, whatever the tool's kind, so the core proof and
   * invalidation lanes can refuse a failed write as proof a path changed.
   * Success declares nothing: the property is absent, never false-by-guess.
   */
  const evidenceOf = (callId: string, name: string, result: OpencodeToolResultValue) => {
    const messages: OpencodeMessage[] = [
      userMessage('msg_u_flag', [text('Do the tool call.')]),
      assistantMessage(`msg_a_${callId}`, [toolCall(callId, name, { filePath: 'OUT.md', content: 'x' })]),
      toolMessage(`msg_t_${callId}`, [toolResult(callId, name, result)]),
    ];
    const snapshot = derive(messages);
    const node = snapshot.snapshot.nodes.find(candidate =>
      candidate.id === opencodeToolNodeId(sessionId, callId));
    if (node === undefined || node.kind !== 'tool-result') {
      throw new Error(`no tool-result node for ${callId}`);
    }
    return node.evidence;
  };
  const failedWrite = evidenceOf('call_w_fail', 'write', errorResult('EACCES: permission denied'));
  assert.equal(failedWrite.kind, 'write', 'a failed write keeps its kind');
  assert.equal(failedWrite.failed, true, 'the structured error tag travels as the failure flag');
  const okWrite = evidenceOf('call_w_ok', 'write', textResult('wrote 1 line'));
  assert.equal(okWrite.failed, undefined, 'a successful write declares no failure');
  const failedRead = evidenceOf('call_r_fail', 'read', errorResult('ENOENT: no such file'));
  assert.equal(failedRead.failed, true, 'a failed read carries the same flag (dsh parity)');
});

test('the replay corpus parses with zero dropped nodes and zero unread parts', () => {
  const corpus = replayCorpus();
  const snapshot = deriveOpencodeSnapshot(corpus.messages, { sessionId: corpus.sessionId });
  const counts = corpus.meta.counts;
  const parts = corpus.messages.reduce((total, message) => total + message.content.length, 0);
  assert.equal(corpus.messages.length, counts.messages);
  assert.equal(parts, counts.parts);
  assert.equal(snapshot.snapshot.nodes.length, counts.nodes);
  // Every part is accounted for: a node-bearing part, a result folded into its
  // unit, or attached evidence. A part in none of the counts was dropped.
  const attached = [...snapshot.attached.values()].flat();
  assert.equal(attached.length + snapshot.unanchored.length, counts.evidenceParts);
  assert.equal(counts.nodeParts + counts.evidenceParts, counts.parts,
    'the corpus counts must account for every part before the test can');
  assert.equal(counts.nodeParts + counts.entryNodes,
    counts.nodes + counts.unitResultParts,
    'each node is a unit call or a part; a result part adds no node of its own');
  // No assistant message needs a stand-in in this corpus: every call follows text.
  const declarers = snapshot.snapshot.nodes.filter(node => node.kind === 'message'
    && node.role === 'assistant' && node.byteLength === 0 && node.toolCallIds.length > 0);
  assert.equal(declarers.length, counts.entryNodes);
  // The one deliberately unknown part type is filed as evidence, not as a node.
  const unknown = attached.filter(evidence => evidence.partType === 'dialogue-table');
  assert.equal(unknown.length, counts.unknownPartTypes);
  // The corpus replays deterministically.
  assert.deepEqual(deriveOpencodeSnapshot(corpus.messages, { sessionId: corpus.sessionId }), snapshot);
});

// ISSUE-400, restated by ISSUE-509: the archived body IS the host's wire text.
// The unit body is the decoded result (never an envelope), so its key order —
// including the order inside a structured value's JSON text — is the host's,
// and a key-sorted spelling is a different byte string. Uses only product src +
// fixtures so the minimal public release covers the rule without the bench
// launcher.
function archivedUnitText(messages: readonly OpencodeMessage[]): string {
  const node = derive(messages).snapshot.nodes
    .find(candidate => candidate.kind === 'tool-result');
  assert.ok(node !== undefined && node.kind === 'tool-result', 'the result is one unit');
  return new TextDecoder().decode(node.bytes);
}

test('the archived body is the host\'s own wire text, never a sorted spelling', () => {
  const cancelled = {
    error: {
      type: 'tool.execution',
      message: 'This non-interactive run cannot ask the user questions. '
        + 'Continue without an answer; make reasonable assumptions and state them.',
    },
    content: [],
  };
  const errorConversation = (value: unknown): OpencodeMessage[] => [
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
  assert.equal(archivedUnitText(errorConversation(cancelled)), JSON.stringify(cancelled),
    'a structured error body is its JSON text in the host\'s key order');
  assert.equal(archivedUnitText(errorConversation(cancelled))
    .includes('{"error":{"type":"tool.execution"'), true,
  'the error key still comes first, as the host wrote it');
  const reordered = { content: cancelled.content, error: cancelled.error };
  assert.equal(archivedUnitText(errorConversation(reordered)), JSON.stringify(reordered),
    'the reordered value keeps its own order in the archive');
  const jsonMessages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('List it.')]),
    assistantMessage('msg_a1', [text('Listing.'), toolCall('call_json', 'glob', { pattern: '**/*.md' })]),
    toolMessage('msg_t1', [toolResult('call_json', 'glob', jsonResult({ zeta: 1, alpha: { beta: 2, gamma: 3 } }))]),
    assistantMessage('msg_a2', [text('Listed.')]),
  ];
  assert.equal(archivedUnitText(jsonMessages),
    '{"zeta":1,"alpha":{"beta":2,"gamma":3}}',
    'neither the result nor its nested object is sorted');
  const body = '# Note\n\nbody\n';
  const stringMessages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [text('Reading.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
    assistantMessage('msg_a2', [text('Read.')]),
  ];
  assert.equal(archivedUnitText(stringMessages), body,
    'a text result archives its exact bytes, newlines and all');
});

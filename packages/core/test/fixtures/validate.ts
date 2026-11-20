import assert from 'node:assert/strict';
import type { FixtureData } from './format.js';

type Fields = Record<string, unknown>;

function object(value: unknown, label: string): Fields {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  return value as Fields;
}

function text(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && value.length > 0, `${label}: expected nonempty string`);
}

function ordinal(value: unknown, label: string): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `${label}: expected nonnegative integer`);
}

function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label}: expected array`);
  return value;
}

function choice(value: unknown, choices: readonly string[], label: string): void {
  assert(typeof value === 'string' && choices.includes(value), `${label}: expected ${choices.join(' | ')}`);
}

function ids(value: unknown, label: string): void {
  list(value, label).forEach((id) => text(id, label));
}

function ranges(value: unknown, label: string, withNode: boolean): void {
  for (const item of list(value, label)) {
    const entry = object(item, label);
    if (withNode) text(entry.nodeId, `${label}.nodeId`);
    const range = withNode ? object(entry.range, `${label}.range`) : entry;
    ordinal(range.startByte, `${label}.startByte`);
    ordinal(range.endByteExclusive, `${label}.endByteExclusive`);
    assert(range.endByteExclusive >= range.startByte, `${label}: reversed byte range`);
  }
}

function evidence(value: unknown, label: string): void {
  const item = object(value, label);
  choice(item.kind, ['read', 'search', 'glob', 'write', 'other'], `${label}.kind`);
  if (item.target !== null) {
    const target = object(item.target, `${label}.target`);
    text(target.key, `${label}.target.key`);
    text(target.label, `${label}.target.label`);
  }
  assert(item.sourceRecallId === null || typeof item.sourceRecallId === 'string', `${label}.sourceRecallId: expected string or null`);
  for (const path of list(item.paths, `${label}.paths`)) {
    const entry = object(path, `${label}.paths`);
    text(entry.pathKey, `${label}.pathKey`);
    text(entry.displayPath, `${label}.displayPath`);
    assert(entry.title === null || typeof entry.title === 'string', `${label}.title: expected string or null`);
    if (entry.lineCount !== null) ordinal(entry.lineCount, `${label}.lineCount`);
    if (entry.byteLength !== null) ordinal(entry.byteLength, `${label}.byteLength`);
    choice(entry.outcome, ['hit', 'miss', 'unknown'], `${label}.outcome`);
  }
}

// The signature narrows JSON only after every required input field is checked.
export function validateFixture(value: unknown): asserts value is FixtureData {
  const data = object(value, 'fixture');
  assert.equal(data.version, 1, 'fixture.version: expected 1');
  text(data.sessionId, 'sessionId');
  text(data.revision, 'revision');
  ordinal(data.currentTurnOrdinal, 'currentTurnOrdinal');
  ordinal(data.completedThroughTurnOrdinal, 'completedThroughTurnOrdinal');
  ordinal(data.currentStepOrdinal, 'currentStepOrdinal');
  assert(data.completedThroughTurnOrdinal <= data.currentTurnOrdinal, 'completed turn exceeds current turn');
  const nodes = list(data.nodes, 'nodes');
  assert(nodes.length > 0, 'nodes: expected at least one node');
  const seen = new Set<string>();
  let lastTurn = -1;
  let lastStep = -1;
  for (const [index, raw] of nodes.entries()) {
    const label = `nodes[${index}]`;
    const node = object(raw, label);
    text(node.id, `${label}.id`);
    assert(!seen.has(node.id), `${label}: duplicate node id ${node.id}`);
    seen.add(node.id);
    ordinal(node.turnOrdinal, `${label}.turnOrdinal`);
    ordinal(node.stepOrdinal, `${label}.stepOrdinal`);
    assert(node.turnOrdinal >= lastTurn && node.stepOrdinal >= lastStep, `${label}: nodes out of order`);
    assert(node.turnOrdinal <= data.currentTurnOrdinal, `${label}: future turn`);
    assert(node.stepOrdinal <= data.currentStepOrdinal, `${label}: future step`);
    lastTurn = node.turnOrdinal;
    lastStep = node.stepOrdinal;
    const content = object(node.content, `${label}.content`);
    assert(typeof content.utf8 === 'string', `${label}.content.utf8: expected string`);
    if (content.repeat !== undefined) {
      ordinal(content.repeat, `${label}.content.repeat`);
      assert(content.repeat > 0, `${label}.content.repeat: expected positive integer`);
    }
    choice(node.kind, ['message', 'tool-result'], `${label}.kind`);
    if (node.kind === 'message') {
      choice(node.role, ['system', 'developer', 'user', 'assistant'], `${label}.role`);
      ids(node.toolCallIds, `${label}.toolCallIds`);
    } else {
      text(node.callId, `${label}.callId`);
      evidence(node.evidence, `${label}.evidence`);
      ranges(node.embeddedRecords, `${label}.embeddedRecords`, false);
    }
  }
  const cache = object(data.cache, 'cache');
  choice(cache.kind, ['warm', 'cold', 'unknown'], 'cache.kind');
  if (cache.kind === 'warm') {
    ordinal(cache.watermarkNodeIndex, 'cache.watermarkNodeIndex');
    assert(cache.watermarkNodeIndex <= nodes.length, 'cache watermark exceeds node count');
  } else if (cache.kind === 'cold') {
    const boundary = object(cache.boundary, 'cache.boundary');
    choice(boundary.kind, ['resume', 'idle-past-ttl', 'model-switch'], 'cache.boundary.kind');
    ordinal(boundary.observedAtMs, 'cache.boundary.observedAtMs');
  }
}

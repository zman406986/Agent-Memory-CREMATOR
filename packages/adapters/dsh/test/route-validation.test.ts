/**
 * The fixed judge route, validated once at mount (ISSUE-427).
 *
 * A route object is trusted configuration only after one string check in the
 * old code, so a non-string field reached `askEntryBatch` and threw out of its
 * no-throw contract, and a blank pair meant "off" in one lane and "not
 * configured" in the other. These tests pin the two halves of the fix: the typed
 * refusal by field, and one journal name for one absent route in both lanes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { askEntryBatch } from '../src/entry-ask.js';
import { JudgeRouteError, normalizeJudgeRoute } from '../src/route.js';

const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

function fakeLlm(): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        yield { type: 'text-delta', index: 0, text: '{"keepall":true}' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  return {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error('surface replace out of range');
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp } });
      log.push(event);
      return event;
    },
  };
}

function landResult(session: FakeSession): void {
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' }, id: 'sys-1' } }, { surfaceOp: 'append' });
  session.append('user/message', { content: [{ type: 'text', text: 'read big.txt' }],
    source: { kind: 'user' }, role: 'user', id: 'user-1' }, { surfaceOp: 'append' });
  const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: 'c1',
    name: 'read', arguments: JSON.stringify({ file_path: 'big.txt' }) }).seq;
  session.append('assistant/message', { turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'c1', name: 'read',
        arguments: JSON.stringify({ file_path: 'big.txt' }) }], id: 'asst-c1' } },
  { surfaceOp: 'append' });
  session.append('tool/result', { turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
      content: [{ type: 'text', text: BODY }], isError: false, id: 'result-c1' } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: 1, step: 1 });
}

const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }] },
  ],
};

interface JournalLine { readonly kind: string; readonly [field: string]: unknown }

function mountWith(route: unknown, journal: JournalLine[], llm: FakeLlm) {
  return createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 64, capBytes: 1 << 20,
      episodeNoNewPathSteps: null, entryAskTrigger: { mode: 'count' },
      entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: llm as never,
    // A JS caller can hand any runtime value; the mount validates it once.
    judgeRoute: route as never,
  });
}

test('a non-string route field is a typed refusal naming the field', () => {
  const badProvider = { provider: 42, model: 'm' };
  const badModel = { provider: 'p', model: null };
  assert.throws(() => normalizeJudgeRoute(badProvider),
    (error: unknown) => error instanceof JudgeRouteError && error.field === 'provider'
      && error.code === 'invalid-route-field');
  assert.throws(() => normalizeJudgeRoute(badModel),
    (error: unknown) => error instanceof JudgeRouteError && error.field === 'model');
  assert.deepEqual(normalizeJudgeRoute({ provider: ' p ', model: ' m ' }),
    { provider: 'p', model: 'm' }, 'a valid pair is trimmed, not guessed');
  assert.equal(normalizeJudgeRoute({ provider: '  ', model: 'm' }), null,
    'a blank pair is the one off reading');
  assert.equal(normalizeJudgeRoute(undefined), null, 'no fixed route is null');
});

test('an invalid route journals before the step tail and never throws into it', async () => {
  const journal: JournalLine[] = [];
  const llm = fakeLlm();
  const mount = mountWith({ provider: 42, model: 'm' }, journal, llm);
  try {
    const invalid = journal.filter(line => line.kind === 'route-invalid');
    assert.equal(invalid.length, 1, 'one line names the invalid route at mount');
    assert.equal(invalid[0]?.['field'], 'provider', 'the line names the field');
    const session = fakeSession('s-route-invalid');
    landResult(session);
    for (const event of session.log) mount.observe(session, event);
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'm', ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    // The step must settle; an invalid route reads as "no route", never a throw.
    await mount.runStep(session, { turn: 1, step: 2 });
    const off = journal.filter(line => line.kind === 'entry-ask-off');
    assert.ok(off.length > 0, 'the entry lane stood down by name');
    assert.equal(off[0]?.['reason'], 'not-configured', 'the entry lane names the absent route');
    assert.equal(llm.calls.length, 0, 'no request left an invalid route');
    const prune = await mount.runPrune(session);
    assert.equal(prune?.refusedFor, 'not-configured', 'the prune names the absent route');
    const pruneOff = journal.filter(line => line.kind === 'prune-off');
    assert.equal(pruneOff[0]?.['reason'], 'not-configured', 'the prune lane names the same condition');
  } finally {
    await mount.close();
  }
});

test('a blank route is off in entry and prune under one journal name', async () => {
  const journal: JournalLine[] = [];
  const llm = fakeLlm();
  const mount = mountWith({ provider: '', model: '' }, journal, llm);
  try {
    const session = fakeSession('s-route-blank');
    landResult(session);
    for (const event of session.log) mount.observe(session, event);
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'm', ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    await mount.runStep(session, { turn: 1, step: 2 });
    const entryOff = journal.filter(line => line.kind === 'entry-ask-off');
    assert.ok(entryOff.length > 0, 'the entry lane stood down');
    const prune = await mount.runPrune(session);
    assert.equal(prune?.refusedFor, 'not-configured', 'the prune names the absent route');
    const pruneOff = journal.filter(line => line.kind === 'prune-off');
    assert.ok(pruneOff.length > 0, 'the prune lane stood down');
    assert.equal(entryOff[0]?.['reason'], pruneOff[0]?.['reason'],
      'one journal name for the same blank-route condition');
    assert.equal(entryOff[0]?.['reason'], 'not-configured');
    assert.equal(llm.calls.length, 0, 'a blank route spends no request');
  } finally {
    await mount.close();
  }
});

test('askEntryBatch keeps its no-throw contract on an unvalidated malformed route', async () => {
  const outcome = await askEntryBatch({
    rows: [{ index: 1, call: 'read big.txt', resultBytes: new TextEncoder().encode(BODY),
      resultNodeId: 'result-c1' }],
    seed: null,
    llm: fakeLlm() as never,
    // A direct JS caller can bypass the mount's validation; the seam must not throw.
    route: { provider: 42, model: 'm' } as never,
  });
  assert.deepEqual(outcome, { status: 'off' },
    'a malformed route reads as not armed, exactly as a blank pair does');
});

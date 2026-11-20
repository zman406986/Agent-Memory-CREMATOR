/**
 * The manual forget tool (PRD §6.2; ISSUE-045 chunk D2), end to end through the
 * shipped mount.
 *
 * What this file proves, in order of what would break first:
 *
 * 1. The tool's argument surface is the one `DSH_TOOL_SPECS` declares, and a
 *    malformed CALL is a failed tool result rather than a content refusal.
 * 2. A request that resolves to one held unit is scheduled, and the mount
 *    applies it at its next boundary as one content-only surface replacement
 *    whose receipt names a minted recall id; the archive is banked and the
 *    recall tool restores the bytes exactly.
 * 3. A request core's lookup refuses (no held unit, two held units) answers
 *    with that lookup's own sentence, verbatim, and nothing is applied: the
 *    transcript is untouched and the engine never sees the event.
 *
 * The happy paths resolve through `read` results (whose own meta reports the
 * lines they returned — ISSUE-051; before that fix a read derived `unknown`
 * and could never resolve a forget). A `grep` result is output about a path,
 * never a copy of its bytes, so a forget backed only by search evidence is
 * refused (ISSUE-327, aligning the lookup with `holdsFileBytes`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshMountContext, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsMount, createRacoonsPlugin, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { createDshTools, registerDshTools } from '../src/tools.js';

const BODY = 'alpha line\nbeta line\ngamma line\n';
const BAR = 8;

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** A minimal append-only dsh session, the shape the mount is written against. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
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
        if (start < 0 || end < 0) {
          throw new Error(`surface replace: seq out of surface (${String(op.startSeq)}..${String(op.endSeq)})`);
        }
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options['sourceEventSeqs'];
      const event: DshMountEvent = Object.freeze({
        type, seq, data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined
          ? {} : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) },
      });
      log.push(event);
      for (const listener of listeners) listener(session, event);
      return event;
    },
    on(listener: (session: FakeSession, event: DshMountEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return session;
}

/** One grep result whose host meta proves a hit: output about the path, never file bytes (ISSUE-327). */
function searchStep(session: FakeSession, params: {
  turn: number; step: number; callId: string; path?: string; pattern?: string;
}): void {
  const path = params.path ?? 'big.txt';
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('user/message', {
    content: [{ type: 'text', text: `task ${String(params.turn)}` }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}`,
  }, { surfaceOp: 'append' });
  const input = { pattern: params.pattern ?? 'alpha', path };
  const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
    callId: params.callId, name: 'grep', arguments: JSON.stringify(input) }).seq;
  session.append('assistant/message', { turn: params.turn, step: params.step,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: params.callId, name: 'grep',
        arguments: JSON.stringify(input) }], id: `asst-${params.callId}` } },
  { surfaceOp: 'append' });
  session.append('tool/result', { turn: params.turn, step: params.step,
    message: { role: 'tool', source: { kind: 'tool', callId: params.callId },
      toolCallId: params.callId, content: [{ type: 'text', text: BODY }],
      isError: false, id: `result-${params.callId}` },
    meta: { shape: 'matches', truncated: false, total: 1,
      files: [{ path, matches: [{ line: 1 }] }] } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: params.turn, step: params.step });
}

/** The three lines `readStep` asks for and returns; a partial read covers all of them. */
const READ_BODY = BODY;

/** One read result whose host meta proves the span it returned (ISSUE-051). */
function readStep(session: FakeSession, params: {
  turn: number; step: number; callId: string; path?: string; offset?: number; text?: string;
}): void {
  const path = params.path ?? 'notes.txt';
  const offset = params.offset ?? 1;
  const text = params.text ?? READ_BODY;
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('user/message', {
    content: [{ type: 'text', text: `task ${String(params.turn)}` }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}`,
  }, { surfaceOp: 'append' });
  const input = { file_path: path };
  const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
    callId: params.callId, name: 'read', arguments: JSON.stringify(input) }).seq;
  session.append('assistant/message', { turn: params.turn, step: params.step,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: params.callId, name: 'read',
        arguments: JSON.stringify(input) }], id: `asst-${params.callId}` } },
  { surfaceOp: 'append' });
  // The live dsh read shape: offset is the 1-based number of the first line, and
  // `lines` holds one entry per returned line.
  session.append('tool/result', { turn: params.turn, step: params.step,
    message: { role: 'tool', source: { kind: 'tool', callId: params.callId },
      toolCallId: params.callId, content: [{ type: 'text', text }],
      isError: false, id: `result-${params.callId}` },
    meta: { path, offset, totalLines: 3,
      lines: readBodyLines(offset, text) } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: params.turn, step: params.step });
}

/** `meta.lines`: one entry per line of the body, numbered from `offset`. */
function readBodyLines(offset: number, text: string = READ_BODY): { number: number; text: string }[] {
  return text.replace(/\n$/u, '').split('\n')
    .map((line, index) => ({ number: offset + index, text: line }));
}

/** The registered tools by name, keeping the host's `render` so a test reads the answer text. */
interface RegisteredTool {
  readonly name: string;
  execute(args: unknown): Promise<unknown>;
  readonly output: { render(args: unknown, value: unknown): { text: string }[] };
}

function toolHost(): { readonly tools: Map<string, RegisteredTool>;
  register(tool: unknown): () => void } {
  const tools = new Map<string, RegisteredTool>();
  return { tools, register(tool: unknown): () => void {
    const named = tool as RegisteredTool;
    tools.set(named.name, named);
    return () => { tools.delete(named.name); };
  } };
}

function tool(host: { readonly tools: Map<string, RegisteredTool> }, name: string): RegisteredTool {
  const found = host.tools.get(name);
  assert.ok(found !== undefined, `${name} is registered`);
  return found;
}

/** The mount plus the two boundaries a forget needs, with the plugin's listeners wired. */
async function mounted(options: {
  readonly session: FakeSession;
  readonly host: ReturnType<typeof toolHost>;
  readonly journal: { kind: string; [field: string]: unknown }[];
}): Promise<{ boundary(turn: number): Promise<void>; dispose(): Promise<void> }> {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: (() => unknown)[] = [];
  const plugin = createRacoonsPlugin({ journal: record => options.journal.push(record),
    storage: { databasePath: ':memory:' }, config: { barBytes: BAR } });
  await plugin.apply({
    logger: { warn: () => {} },
    tools: options.host as never,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
  } as DshMountContext, {});
  options.session.on((session, event) => {
    const listener = listeners.get('session/event');
    if (listener !== undefined) (listener as (s: FakeSession, e: DshMountEvent) => void)(session, event);
  });
  const preStep = listeners.get('agent/pre-step') as
    (payload: unknown, next: () => unknown) => Promise<unknown>;
  return {
    boundary: async turn => {
      await preStep({ agent: { session: options.session }, messages: [], turn, step: 1, signal: {} },
        async () => ({ kind: 'enter', messages: [] }));
    },
    dispose: async () => { for (const fn of cleanups) await fn(); },
  };
}

/** Every surface replacement the mount wrote, in log order. */
function replacements(session: FakeSession): DshMountEvent[] {
  return session.log.filter(event => event.type === 'tool/result'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null);
}

test('the forget spec is the declared surface, and a malformed call is a failed tool result', async () => {
  const tools = createDshTools({ recall: async () => { throw new Error('unused'); },
    forget: async () => { throw new Error('unused'); } });
  assert.deepEqual(tools.map(candidate => candidate.spec.name), ['forget', 'necromancy'],
    'forget and recall have handlers, so both are registered');
  const forget = tools[0];
  assert.ok(forget !== undefined);
  // PRD §6.2 / the spec: one required path, optional 1-based line ranges.
  assert.deepEqual(forget.spec.parameters['required'], ['path']);
  assert.deepEqual(Object.keys(forget.spec.parameters['properties'] as object), ['path', 'ranges']);
  // A malformed CALL is the model's own error; it never becomes a content refusal.
  for (const bad of [{}, { path: '' }, { path: 'a', ranges: 'x' },
    { path: 'a', ranges: [{ startLine: 0, endLine: 1 }] },
    { path: 'a', ranges: [{ startLine: 2, endLine: 1 }] },
    { path: 'a', ranges: [{ startLine: 1.5, endLine: 2 }] }]) {
    await assert.rejects(async () => forget.execute(bad), /forget expects/u);
  }
});

test('a forget of one held unit applies as one revert, banks the bytes and recalls them', async () => {
  const dirScratch = resolveStorage(undefined);
  assert.deepEqual(dirScratch, { databasePath: ':memory:', blobRoot: ':memory:' });
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const host = toolHost();
  const session = fakeSession('session-forget');
  const mount = createRacoonsMount({ config: resolvePluginConfig({ barBytes: BAR }),
    storage: resolveStorage(undefined), journal: record => journal.push(record) });
  const wired = await mounted({ session, host, journal });
  try {
    readStep(session, { turn: 1, step: 1, callId: 'r1', path: 'big.txt' });
    session.append('turn/end', { turn: 1 });
    // One boundary delivers the captured result; the forget resolves against
    // the transcript that boundary settled.
    await wired.boundary(1);
    const original = session.log.find(event => event.type === 'tool/result'
      && event.surfaceOp === 'append');
    assert.ok(original !== undefined);
    const answer = await tool(host, 'forget').execute({ path: 'big.txt' });
    assert.deepEqual(answer, { status: 'scheduled', path: 'big.txt', ranges: [] },
      'the tool answers what it proved: one held unit holds these lines');
    // Nothing moved during the call: a revert there would re-emit its own
    // unanswered tool call, which dsh refuses (`tool-pair-imbalance`).
    assert.equal(replacements(session).length, 0, 'a tool call never applies its own removal');
    await wired.boundary(2);
    const replaced = replacements(session);
    assert.equal(replaced.length, 1, 'the forget applied exactly one surface replacement');
    assert.deepEqual(replaced[0]?.surfaceOp,
      { op: 'replace', startSeq: original.seq, endSeq: original.seq });
    assert.deepEqual([...(replaced[0]?.sourceEventSeqs ?? [])], [original.seq],
      'the replacement names exactly the node it shadowed');
    const content = (replaced[0]?.data as { message: { content: { type: string; text: string }[] } })
      .message.content;
    assert.equal(content.length, 1, 'content-only: the call pairing is untouched');
    assert.match(content[0]?.text ?? '', /^\[not retained\] big\.txt · necromancy recall:sha256:[0-9a-f]{64}$/u,
      'the receipt is the floor line: path, no ranges, one recall id');
    // The forgotten bytes left the live surface: the node the model reads is
    // the receipt, not a copy of the body. The check reads message content —
    // the replacement is content-only, so the host's own `meta` (which for a
    // read quotes the returned lines) rides along untouched by design.
    const surfaceText = (session.surface?.nodes ?? []).map(seq => {
      const data = session.eventAt?.(seq)?.data as
        { message?: { content?: { text?: string }[] } };
      return (data.message?.content ?? []).map(part => part.text ?? '').join('\n');
    }).join('\n');
    assert.equal(surfaceText.includes('beta line'), false, 'the forgotten body left the surface');
    assert.equal(surfaceText.includes('[not retained] big.txt'), true, 'the receipt is on the surface');
    // One journal line for the request, and it reports the engine's own status.
    const lines = journal.filter(line => line['kind'] === 'forget');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.['status'], 'applied');
    assert.equal(lines[0]?.['path'], 'big.txt');
    // Banked and recallable: the recall tool restores the exact forgotten bytes.
    const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(content[0]?.text ?? '')?.[1];
    assert.ok(recallId !== undefined);
    const restored = await tool(host, 'necromancy').execute({ id: recallId }) as Record<string, unknown>;
    assert.equal(restored['text'], BODY, 'recall returns the forgotten bytes exactly');
    assert.equal(restored['byteLength'], new TextEncoder().encode(BODY).length);
    // Exactly one node left the surface, and no second copy of the receipt appeared.
    assert.equal(journal.filter(line => line['kind'] === 'forget').length, 1,
      'one request, one application');
    // A second boundary adds no journal line: the queue was drained once, so the
    // mount never re-asks the engine about a request it already settled. (The
    // engine's own event-id dedupe would also answer `applied` here, so the
    // journal — the mount's own record — is what names a replay.)
    const after = replacements(session).length;
    await wired.boundary(3);
    assert.equal(replacements(session).length, after, 'no second surface replacement');
    assert.equal(journal.filter(line => line['kind'] === 'forget').length, 1,
      'the queue is drained, never replayed');
    void mount;
  } finally {
    await wired.dispose();
  }
});

test('the turn-end boundary drains a forget too, so a one-shot run still applies it', async () => {
  // In a one-shot run no pre-step follows the turn's last step, so a request
  // queued there would never land if only `runStep` drained the queue.
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const host = toolHost();
  const session = fakeSession('session-forget-turn-end');
  const mount = createRacoonsMount({ config: resolvePluginConfig({ barBytes: BAR }),
    storage: resolveStorage(undefined), journal: record => journal.push(record) });
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: (() => unknown)[] = [];
  const plugin = createRacoonsPlugin({ journal: record => journal.push(record),
    storage: { databasePath: ':memory:' }, config: { barBytes: BAR } });
  try {
    await plugin.apply({
      logger: { warn: () => {} },
      tools: host as never,
      on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
      effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    } as DshMountContext, {});
    session.on((s, event) => {
      const listener = listeners.get('session/event');
      if (listener !== undefined) (listener as (s: FakeSession, e: DshMountEvent) => void)(s, event);
    });
    readStep(session, { turn: 1, step: 1, callId: 'r1', path: 'big.txt' });
    const preStep = listeners.get('agent/pre-step') as
      (payload: unknown, next: () => unknown) => Promise<unknown>;
    await preStep({ agent: { session }, messages: [], turn: 1, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(await tool(host, 'forget').execute({ path: 'big.txt' }),
      { status: 'scheduled', path: 'big.txt', ranges: [] });
    assert.equal(replacements(session).length, 0, 'queued, not applied, inside the call');
    // The turn closes; no further pre-step follows it.
    session.append('turn/end', { turn: 1 });
    const turnStopping = listeners.get('agent/turn-stopping') as
      (payload: unknown) => Promise<void>;
    await turnStopping({ turn: 1, agent: { session } });
    assert.equal(replacements(session).length, 1,
      'the turn-end boundary applied the queued forget');
    assert.equal(journal.filter(line => line['kind'] === 'forget')[0]?.['status'], 'applied');
    void mount;
  } finally {
    for (const fn of cleanups) await fn();
  }
});

test('a forget resolves through a READ result, applies, and the bytes come back by recall id', async () => {
  // ISSUE-051: a read's own meta is what proves the hit. Before the fix this
  // exact path answered `refused: absent`, because only search/glob results
  // carried a count.
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const host = toolHost();
  const session = fakeSession('session-forget-read');
  const wired = await mounted({ session, host, journal });
  try {
    readStep(session, { turn: 1, step: 1, callId: 'r1' });
    session.append('turn/end', { turn: 1 });
    await wired.boundary(1);
    const original = session.log.find(event => event.type === 'tool/result'
      && event.surfaceOp === 'append');
    assert.ok(original !== undefined);
    // The read's evidence is a hit on the path it named, with the covered span.
    const answer = await tool(host, 'forget')
      .execute({ path: 'notes.txt', ranges: [{ startLine: 1, endLine: 2 }] });
    assert.deepEqual(answer, { status: 'scheduled', path: 'notes.txt',
      ranges: [{ startLine: 1, endLine: 2 }] },
    'a read result is held content: the request resolves instead of being refused');
    assert.equal(replacements(session).length, 0, 'a tool call never applies its own removal');
    await wired.boundary(2);
    const replaced = replacements(session);
    assert.equal(replaced.length, 1, 'the read-sourced forget applied one surface replacement');
    assert.deepEqual(replaced[0]?.surfaceOp,
      { op: 'replace', startSeq: original.seq, endSeq: original.seq });
    const content = (replaced[0]?.data as { message: { content: { type: string; text: string }[] } })
      .message.content;
    // The unit is the whole result, so the receipt is the floor line for the path
    // the request spelled — the read's own `file_path`.
    assert.match(content[0]?.text ?? '',
      /^\[not retained\] notes\.txt · necromancy recall:sha256:[0-9a-f]{64}$/u);
    assert.equal(journal.filter(line => line['kind'] === 'forget')[0]?.['status'], 'applied');
    const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(content[0]?.text ?? '')?.[1];
    assert.ok(recallId !== undefined);
    const restored = await tool(host, 'necromancy').execute({ id: recallId }) as Record<string, unknown>;
    assert.equal(restored['text'], READ_BODY, 'the forgotten read bytes are restorable by recall id');
  } finally {
    await wired.dispose();
  }
});

test('a forget two held units answer names the ambiguity and applies nothing', async () => {
  const journalLines: { kind: string; [field: string]: unknown }[] = [];
  const host = toolHost();
  const session = fakeSession('session-forget-ambiguous');
  const wired = await mounted({ session, host, journal: journalLines });
  try {
    // Two reads of one path with different bytes: the path alone names two
    // held units. (Identical bytes would let the superseded-read rule burn the
    // earlier copy, leaving one unit and nothing ambiguous.)
    readStep(session, { turn: 1, step: 1, callId: 'r1', path: 'big.txt' });
    readStep(session, { turn: 1, step: 2, callId: 'r2', path: 'big.txt',
      text: 'alpha line\nbeta line\nCHANGED line\n' });
    session.append('turn/end', { turn: 1 });
    await wired.boundary(2);
    const answer = await tool(host, 'forget').execute({ path: 'big.txt' });
    assert.equal((answer as Record<string, unknown>)['status'], 'refused');
    assert.equal((answer as Record<string, unknown>)['reason'], 'ambiguous');
    assert.match(String((answer as Record<string, unknown>)['detail']),
      /^2 held units of big\.txt contain the requested ranges; a forget names one$/u);
    await wired.boundary(3);
    assert.equal(replacements(session).length, 0, 'nothing is guessed, so nothing applies');
  } finally {
    await wired.dispose();
  }
});

test('a forget backed only by grep output is refused: search hits are not file content', async () => {
  // ISSUE-327: only a read holds a copy of the file's bytes. A grep hit proves
  // the path matched a pattern, never that the result holds the content a
  // forget names, so the lookup refuses with its own `absent` sentence.
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const host = toolHost();
  const session = fakeSession('session-forget-grep');
  const wired = await mounted({ session, host, journal });
  try {
    searchStep(session, { turn: 1, step: 1, callId: 's1' });
    session.append('turn/end', { turn: 1 });
    await wired.boundary(1);
    const answer = await tool(host, 'forget').execute({ path: 'big.txt' }) as Record<string, unknown>;
    assert.equal(answer['status'], 'refused', 'grep output is not a copy of the file');
    assert.equal(answer['reason'], 'absent', "the lookup's own reason is carried");
    await wired.boundary(2);
    assert.equal(replacements(session).length, 0, 'nothing resolves, so nothing applies');
    assert.equal(journal.filter(line => line['kind'] === 'forget').length, 0,
      'no forget event is scheduled');
  } finally {
    await wired.dispose();
  }
});

test('registration stays all-or-nothing: a refused second tool leaves neither registered', () => {
  const registered: string[] = [];
  const undone: string[] = [];
  assert.throws(() => registerDshTools({ register: tool => {
    registered.push(tool.spec.name);
    if (tool.spec.name === 'necromancy') throw new Error('the host refused recall');
    return () => { undone.push(tool.spec.name); };
  } }, createDshTools({ recall: async () => { throw new Error('unused'); },
    forget: async () => { throw new Error('unused'); } })), /refused recall/u);
  assert.deepEqual(registered, ['forget', 'necromancy']);
  assert.deepEqual(undone, ['forget'], 'the tool that did register was undone');
});

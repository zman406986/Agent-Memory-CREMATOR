// Slice-B checks for the tier-2 replay converter. Run with the rig glob:
//   node --test "dev/dsh-rig/**/*.test.mjs"
//
// These tests build synthetic transcripts in memory and in temp dirs. The
// committed fixture is exercised through the same converter, so a redaction
// regression fails here before any live run.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONVERTER_VERSION,
  canonicalScript,
  convertTranscript,
  countToolResults,
  groupTurns,
  lastAssistantToolNames,
  leakScan,
  mapToolCall,
  NOOP_TOOLS,
  redact,
  WITHHELD_COMMAND,
} from './replay.mjs';

const REPLAY = fileURLToPath(new URL('./replay.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/replay-session.json', import.meta.url));

/** One transcript line. */
function line(event) {
  return `${JSON.stringify(event)}\n`;
}

/** A minimal transcript: a turn that calls `read`, then a turn that answers. */
function syntheticTranscript({ assistantText = 'done' } = {}) {
  const base = { sessionId: 'sess_0123456789abcdef', turnId: 'turn_abcdef0123456789' };
  return [
    line({ ...base, type: 'turn_started', payload: { turnNumber: 0, input: 'planted task' } }),
    line({
      ...base,
      type: 'model_request',
      payload: {
        messages: [
          { role: 'system', content: 'You are a test agent' },
          { role: 'user', content: 'planted task' },
        ],
        iteration: 0,
      },
    }),
    line({
      ...base,
      type: 'tool_call_scheduled',
      payload: {
        toolCallId: 'call_aaaaaaaaaaaaaaaaaaaaaaaa',
        toolName: 'Read',
        input: { file_path: 'C:\\Users\\TZhen\\Desktop\\Spreadsheets in space\\notes.md' },
      },
    }),
    line({ ...base, type: 'model_complete', payload: { content: '', stopReason: 'tool-calls', toolCallCount: 1 } }),
    line({
      ...base,
      type: 'model_request',
      payload: {
        messages: [
          { role: 'system', content: 'You are a test agent' },
          { role: 'user', content: 'planted task' },
          { role: 'assistant', content: [], toolCalls: [{ id: 'call_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Read', input: {} }] },
          { role: 'tool', content: 'file body', toolCallId: 'call_aaaaaaaaaaaaaaaaaaaaaaaa' },
        ],
        iteration: 1,
      },
    }),
    line({ ...base, type: 'model_complete', payload: { content: assistantText, stopReason: 'stop', toolCallCount: 0 } }),
  ].join('');
}

describe('redaction', () => {
  it('removes every planted secret form', () => {
    const planted = [
      'anthropic sk-ant-api03-ABCDEFGH12345678',
      'openai sk-abcdefghijklmnop1234',
      'github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'slack xoxb-1234567890-abcdefghij',
      'aws AKIAIOSFODNN7EXAMPLE',
      'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'api_key = "0123456789abcdef"',
    ].join('\n');
    const out = redact(planted);
    for (const needle of ['sk-ant-api03', 'ghp_ABCDEF', 'AKIAIOSFODNN', 'eyJhbGciOiJIUzI1NiJ9', '0123456789abcdef']) {
      assert.ok(!out.includes(needle), `unredacted ${needle} survived: ${out}`);
    }
    assert.match(out, /sk-\.\.\./u);
    assert.match(out, /AKIA\.\.\./u);
  });

  it('turns every home-path spelling into <home>', () => {
    const planted = [
      'C:\\Users\\TZhen\\Desktop\\x.md',
      'C:/Users/TZ/Desktop/x.md',
      '/c/Users/AAAAA/Desktop/x.md',
      'Users\\AAAAA\\AppData',
    ].join('\n');
    const out = redact(planted);
    assert.ok(!/AAAAA|Users[\\/]TZ/u.test(out), `a home path survived: ${out}`);
    assert.equal(out.split('<home>').length - 1, 4);
  });

  it('turns project names into stable tokens before the path pass', () => {
    const out = redact('repo at C:\\Users\\TZhen\\Desktop\\Spreadsheets in space and Miliastra');
    assert.match(out, /<home>\\Desktop\\<proj-a>/u);
    assert.match(out, /<proj-c>/u);
    assert.doesNotMatch(out, /Spreadsheets|Miliastra/u);
  });

  it('counts each rule bucket', () => {
    const counters = { secrets: 0, project_names: 0, home_paths: 0 };
    redact('sk-abcdefghijklmnop1234 at C:\\Users\\TZhen\\Desktop\\Genshin Impact', counters);
    assert.deepEqual(counters, { secrets: 1, project_names: 1, home_paths: 1 });
  });

  it('reports a leak when a secret survives', () => {
    assert.equal(leakScan('nothing here').length, 0);
    const hits = leakScan('token sk-abcdefghijklmnop1234 here');
    assert.ok(hits.some((hit) => hit.kind.startsWith('secrets:')), JSON.stringify(hits));
  });
});

describe('tool mapping', () => {
  const state = () => ({ rewrittenPaths: new Map() });

  it('maps zcode names to dsh names and keeps ids', () => {
    const { call } = mapToolCall({ toolCallId: 'call_1', toolName: 'Bash', input: { command: 'ls' } }, state());
    assert.equal(call.name, 'pwsh');
    assert.equal(call.id, 'call_1');
  });

  it('withholds a command that is not a single read-only invocation', () => {
    const { call, notes } = mapToolCall({ toolCallId: 'c', toolName: 'Bash', input: { command: 'rm -rf /' } }, state());
    assert.equal(call.input.command, WITHHELD_COMMAND);
    assert.ok(notes.includes('command-withheld'));
  });

  it('rewrites file paths to a stable work-relative form', () => {
    const shared = state();
    const first = mapToolCall({ toolCallId: 'a', toolName: 'Read', input: { file_path: 'C:\\Users\\TZ\\Desktop\\r\\notes.md' } }, shared);
    const second = mapToolCall({ toolCallId: 'b', toolName: 'Read', input: { file_path: 'C:\\Users\\TZ\\Desktop\\r\\notes.md' } }, shared);
    assert.equal(first.call.input.file_path, 'replay/notes.md');
    assert.equal(second.call.input.file_path, 'replay/notes.md');
    assert.ok(!JSON.stringify(first.call).includes('Users'));
  });

  it('drops a tool with no dsh equivalent', () => {
    const { call } = mapToolCall({ toolCallId: 'x', toolName: 'Telepathy', input: {} }, state());
    assert.equal(call, null);
  });

  it('withholds a read-only command whose own text leaks a path or project name', () => {
    const { call, notes } = mapToolCall({
      toolCallId: 'c', toolName: 'Bash',
      input: { command: 'ls "/c/Users/AAAAA/Desktop/Spreadsheets in space/docs"' },
    }, state());
    assert.equal(call.input.command, WITHHELD_COMMAND);
    assert.ok(notes.includes('command-withheld'));
    assert.equal(leakScan(JSON.stringify(call)).length, 0);
  });

  it('maps TodoWrite to a no-op todo_write that keeps the call shape, never the prose', () => {
    const { call, notes } = mapToolCall({
      toolCallId: 'call_1', toolName: 'TodoWrite',
      input: { todos: [
        { content: 'Read Spreadsheets in space notes', status: 'completed', priority: 'high' },
        { content: 'Patch C:\\Users\\TZhen\\Desktop\\x', status: 'in_progress', priority: 'high' },
      ] },
    }, state());
    assert.equal(call.name, 'todo_write');
    assert.ok(notes.includes('noop'));
    // dsh's schema rejects undeclared item keys, so `priority` cannot survive.
    assert.deepEqual(call.input, { todos: [
      { content: 'replay todo 1', status: 'completed' },
      { content: 'replay todo 2', status: 'in_progress' },
    ] });
    assert.equal(leakScan(JSON.stringify(call)).length, 0);
  });

  it('coerces an unknown todo status and keeps a zero-item list', () => {
    const odd = mapToolCall({ toolCallId: 'a', toolName: 'TodoWrite', input: { todos: [{ content: 'x', status: 'blocked' }] } }, state());
    assert.equal(odd.call.input.todos[0].status, 'pending');
    const empty = mapToolCall({ toolCallId: 'b', toolName: 'TodoWrite', input: { todos: [] } }, state());
    assert.deepEqual(empty.call.input, { todos: [] });
  });

  it('names the no-op family so a caller can count what it mapped', () => {
    assert.deepEqual([...NOOP_TOOLS].sort(), ['job_list', 'todo_write']);
  });

  it('maps TaskOutput and TaskStop to the argument-free no-op job_list', () => {
    for (const toolName of ['TaskOutput', 'TaskStop']) {
      const { call } = mapToolCall({
        toolCallId: 'c', toolName,
        input: { task_id: 'sess_AAAAA_agent_secret', block: true, timeout: 5 },
      }, state());
      assert.equal(call.name, 'job_list', toolName);
      assert.deepEqual(call.input, {}, toolName);
    }
  });
});

describe('transcript mapping', () => {
  it('groups requests with the tool calls that follow them', () => {
    const turns = groupTurns([
      { type: 'model_request', payload: { messages: [] } },
      { type: 'tool_call_scheduled', payload: { toolCallId: 'a', toolName: 'Read', input: {} } },
      { type: 'model_complete', payload: { content: '', stopReason: 'tool-calls' } },
      { type: 'model_request', payload: { messages: [] } },
      { type: 'model_complete', payload: { content: 'done', stopReason: 'stop' } },
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].calls.length, 1);
    assert.equal(turns[1].calls.length, 0);
    assert.equal(turns[1].completion.payload.content, 'done');
  });

  it('counts tool results and reads the last assistant tool names', () => {
    const messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [], toolCalls: [{ name: 'Read' }, { name: 'Bash' }] },
      { role: 'tool', content: 'a' },
      { role: 'tool', content: 'b' },
    ];
    assert.equal(countToolResults(messages), 2);
    assert.deepEqual(lastAssistantToolNames(messages), ['Read', 'Bash']);
  });

  it('maps a two-turn transcript into two replies keyed on (count, names)', () => {
    const { script, stats } = convertTranscript(syntheticTranscript());
    assert.equal(script.replies.length, 2);
    assert.equal(stats.turns.model_requests, 2);
    assert.equal(stats.turns.mapped, 2);
    assert.deepEqual(script.replies[0].match, { tools_length: 'present', tool_results_count: 0 });
    assert.equal(script.replies[0].reply.type, 'tool_use');
    assert.equal(script.replies[0].reply.calls[0].name, 'read');
    assert.equal(script.replies[0].reply.calls[0].input.file_path, 'replay/notes.md');
    assert.deepEqual(script.replies[1].match, {
      tools_length: 'present',
      tool_results_count: 1,
      last_assistant_tool_names: ['read'],
    });
    assert.equal(script.replies[1].reply.type, 'text');
    assert.equal(script.replies[1].reply.text, 'done');
  });

  it('records converter version, source digest and caps', () => {
    const { script, stats } = convertTranscript(syntheticTranscript(), { textCap: 32, sourceName: 't.jsonl' });
    assert.equal(script.meta.converter_version, CONVERTER_VERSION);
    assert.equal(script.meta.source.name, 't.jsonl');
    assert.match(script.meta.source.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(stats.caps.text_chars, 32);
  });

  it('caps long assistant text and marks the cut', () => {
    const { script } = convertTranscript(syntheticTranscript({ assistantText: 'x'.repeat(200) }), { textCap: 20 });
    assert.equal(script.replies[1].reply.text, `${'x'.repeat(20)}\u2026[truncated]`);
  });

  it('stops at the first turn with no completion and counts the rest as dropped', () => {
    const lines = syntheticTranscript().split('\n').filter((entry) => entry !== '');
    // A request with no completion: the process died mid-turn.
    lines.push(JSON.stringify({ type: 'model_request', payload: { messages: [] } }));
    lines.push(JSON.stringify({ type: 'model_request', payload: { messages: [{ role: 'user', content: 'later' }] } }));
    const { script, stats } = convertTranscript(lines.join('\n'));
    assert.equal(script.replies.length, 2);
    assert.equal(stats.turns.model_requests, 4);
    assert.equal(stats.turns.skipped.no_completion, 1);
    assert.equal(stats.turns.dropped_after_blocker, 1);
    assert.equal(stats.turns.blocker, 'no_completion');
  });

  it('skips malformed lines without failing the conversion', () => {
    const text = `${syntheticTranscript()}{not json}\n`;
    const { script, stats } = convertTranscript(text);
    assert.equal(stats.source.malformed_lines, 1);
    assert.equal(script.replies.length, 2);
  });

  it('is deterministic: the same transcript yields the same canonical script', () => {
    const first = canonicalScript(convertTranscript(syntheticTranscript()).script);
    const second = canonicalScript(convertTranscript(syntheticTranscript()).script);
    assert.equal(first, second);
  });

  it('leaves no secret or home path in the converted script', () => {
    const { script, stats } = convertTranscript(syntheticTranscript({
      assistantText: 'read C:\\Users\\TZhen\\Desktop\\Spreadsheets in space\\notes.md with sk-abcdefghijklmnop1234',
    }));
    const text = canonicalScript(script);
    assert.equal(stats.leaks.length, 0, JSON.stringify(stats.leaks));
    assert.doesNotMatch(text, /AAAAA|sk-abcdefghijklmnop1234|Spreadsheets/u);
  });
});

describe('committed fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('carries no source prose: every assistant text is a length marker', () => {
    const texts = fixture.replies.map((entry) => entry.reply.text).filter((text) => text !== '');
    assert.ok(texts.length > 0, 'fixture has no assistant text at all');
    for (const text of texts) assert.match(text, /^<replay turn \d+: \d+ chars>$/u);
  });

  it('leaks nothing and declares its provenance', () => {
    const hits = leakScan(JSON.stringify(fixture));
    assert.deepEqual(hits, []);
    assert.equal(fixture.meta.converter_version, CONVERTER_VERSION);
    assert.match(fixture.meta.source.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(fixture.meta.source.bytes > 0);
  });

  it('produces matcher keys the mock accepts and no duplicate key', () => {
    const keys = new Set();
    for (const entry of fixture.replies) {
      const match = entry.match ?? {};
      assert.equal(match.tools_length, 'present');
      assert.equal(typeof match.tool_results_count, 'number');
      const key = `${match.tool_results_count}|${(match.last_assistant_tool_names ?? []).join(',')}`;
      assert.ok(!keys.has(key), `duplicate matcher key ${key}`);
      keys.add(key);
    }
    assert.ok(fixture.replies.length >= 2, `fixture has only ${fixture.replies.length} turn(s)`);
  });

  it('round-trips through canonical serialization unchanged', () => {
    // core.autocrlf=true materializes the committed LF blob as CRLF on a
    // Windows checkout (ISSUE-368). Line endings are a checkout artifact, so
    // both sides are compared in LF form; every other byte still must match.
    const lf = (text) => text.replace(/\r\n/gu, '\n');
    assert.equal(lf(`${canonicalScript(fixture)}\n`), lf(readFileSync(FIXTURE, 'utf8')));
  });
});

describe('CLI', () => {
  function run(args) {
    return spawnSync(process.execPath, [REPLAY, ...args], { encoding: 'utf8' });
  }

  it('writes a script and a stats file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-replay-'));
    const input = join(dir, 'transcript.jsonl');
    writeFileSync(input, syntheticTranscript());
    const out = join(dir, 'script.json');
    const statsPath = join(dir, 'stats.json');
    const result = run(['--in', input, '--out', out, '--stats', statsPath, '--check']);
    assert.equal(result.status, 0, result.stderr);
    const script = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(script.replies.length, 2);
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    assert.equal(stats.turns.mapped, 2);
    assert.equal(stats.leaks.length, 0);
  });

  it('exits 2 on a bad argument', () => {
    assert.equal(run(['--out', 'x.json']).status, 2);
  });

  it('exits 2 on a missing input', () => {
    const result = run(['--in', join(tmpdir(), 'definitely-absent.jsonl'), '--out', join(tmpdir(), 'x.json')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot read/u);
  });
});

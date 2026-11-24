// Slice-A checks for the mock: loopback refusal, routing, and the three failure
// reply shapes the rig must be able to express. Run: `node --test dev/dsh-rig`.
// These are the mock's own unit tests; the live end-to-end gate is `run.mjs`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyRequest,
  DEFAULT_API_KEY,
  DEFAULT_TITLE,
  ENTRY_ANSWER_MISSING,
  ENTRY_ASK_END_ANCHOR,
  ENTRY_SHAPE_ACTIONS,
  FORGETALL_REASON,
  FORGETALL_TABLE_ANSWER_PLACEHOLDER,
  isEntryAsk,
  LOOPBACK_HOSTS,
  matches,
  normalizeScript,
  PRUNE_ASK_FINAL_LINE,
  PRUNE_ASK_TABLE_HEADING,
  pickReply,
  sendReply,
  SHAPE_ANSWER_PLACEHOLDER,
  shapeAnswerText,
  substituteTableAnswer,
  TABLE_ANSWER_PLACEHOLDER,
  TABLE_ASK_MARKER,
  TABLE_PARTIAL_PLACEHOLDER,
} from './mock-messages.mjs';

const MOCK = fileURLToPath(new URL('./mock-messages.mjs', import.meta.url));
const TEMPLATE_SOURCE = fileURLToPath(new URL('../../packages/core/src/rules/assets-templates.ts', import.meta.url));

function body(overrides) {
  return { model: 'deepseek-flash', stream: true, messages: [], tools: [], ...overrides };
}

/**
 * Start the mock on a script document and resolve once it is listening.
 * Returns `post` (one request/response pair), `records` (the JSONL log, in
 * order) and `stop`. Every live-socket test in this file goes through it, so
 * the startup, redacted key and record parsing are exercised once.
 */
async function startMock(scriptDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-mock-'));
  const script = join(dir, 'script.json');
  const log = join(dir, 'l.jsonl');
  writeFileSync(script, JSON.stringify(scriptDoc));
  const child = spawn(process.execPath, [MOCK, '--port', '0', '--log', log, '--script', script]);
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        try { resolve(JSON.parse(buffer.split('\n')[0]).port); } catch { reject(new Error(`unexpected mock output: ${buffer}`)); }
      }
    });
    child.on('exit', (code) => reject(new Error(`mock exited ${String(code)} before listening`)));
  });
  return {
    async post(bodyDoc) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': DEFAULT_API_KEY },
        body: JSON.stringify(bodyDoc),
      });
      return { status: response.status, text: await response.text() };
    },
    records() {
      const raw = readFileSync(log, 'utf8').trim();
      return raw === '' ? [] : raw.split('\n').map((line) => JSON.parse(line));
    },
    stop() {
      child.kill();
    },
  };
}

describe('script validation', () => {
  it('rejects a non-object script', () => {
    assert.throws(() => normalizeScript([]), /top level must be a JSON object/u);
  });

  it('rejects an unknown reply type by index', () => {
    assert.throws(() => normalizeScript({ replies: [{ reply: { type: 'telepathy' } }] }), /reply 0 has unknown type/u);
  });

  it('rejects a tool_use reply without calls', () => {
    assert.throws(() => normalizeScript({ replies: [{ reply: { type: 'tool_use' } }] }), /needs a non-empty calls array/u);
  });

  it('defaults the title and names unnamed replies by index', () => {
    const script = normalizeScript({ replies: [{ reply: { type: 'text', text: 'x' } }] });
    assert.equal(script.title, DEFAULT_TITLE);
    assert.equal(script.replies[0].name, 'reply-0');
  });
});

describe('request classification', () => {
  it('routes a title system prompt to the title lane before any matcher', () => {
    const script = normalizeScript({ title: 'Fixed', replies: [{ match: null, reply: { type: 'text', text: 'main' } }] });
    const classified = classifyRequest(body({ system: 'Create a concise title for an AI coding-assistant session.' }));
    assert.equal(classified.kind, 'title');
    // The title lane never consults pickReply, so the fallback reply cannot consume the turn.
    assert.equal(pickReply(script, { body: body(), serialized: '{}', tools: [], toolResults: 0, lastUserText: '' }).entry.name, 'reply-0');
  });

  it('classifies every table ask as the prune lane, whatever its row count', () => {
    // ADR-0028: the judge pass is removed and the bulk prune is the ONE table
    // asker. The old ≥3-row discriminator existed only to keep the two callers
    // apart, so it is gone; a 1-row table — the normal tail of a pass — is the
    // prune lane exactly as a 12-row one is.
    for (const rows of [1, 2, 12]) {
      const table = Array.from({ length: rows }, (_, index) => `${String(index + 1)}. [Read] row`).join('\n');
      const classified = classifyRequest(body({
        tools: [{ name: 'read' }],
        messages: [{ role: 'user', content: [{ type: 'text',
          text: `${TABLE_ASK_MARKER}\n\n${table}\n\n${PRUNE_ASK_FINAL_LINE}` }] }],
      }));
      assert.equal(classified.kind, 'prune', `${String(rows)}-row table ask must be the prune lane`);
    }
  });

  it('never routes a retired decision line to a lane of its own', () => {
    // The judge's tool-less decision-line arm is deleted with the pass. A
    // tool-less request that still ends with that sentence stays `main`, so a
    // stale scenario row cannot resurrect the lane.
    const classified = classifyRequest(body({
      system: 'You review what stays in a coding agent context.',
      messages: [{ role: 'user', content: [{ type: 'text',
        text: 'row 1\n\nThe last tool result above is the unit. Decide.' }] }],
    }));
    assert.equal(classified.kind, 'main');
  });

  it('classifies a tool-less request ending in the prune final line as a prune ask', () => {
    // An ask whose fork had no seed: no tools, and the history ends with the
    // index-table instruction. It is the prune lane, never a main turn.
    const classified = classifyRequest(body({
      system: 'You decide which units still in memory to remove.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `row 1\n\n${PRUNE_ASK_FINAL_LINE}` }] }],
    }));
    assert.equal(classified.kind, 'prune');
    assert.equal(classified.tools.length, 0);
  });

  it('does not call a tool-bearing turn a prune ask, even with the final line', () => {
    const classified = classifyRequest(body({
      tools: [{ name: 'read' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `x\n\n${PRUNE_ASK_FINAL_LINE}` }] }],
    }));
    assert.equal(classified.kind, 'main');
  });

  it('pins the prune final line read from core source to the shipped bytes', () => {
    // Since ISSUE-118 the mock READS the line out of
    // `packages/core/src/prune/ask-message.ts` instead of copying it. This
    // literal is the outside expectation: a reworded core line fails here by
    // name, so the table lane can never be routed by bytes nobody reviewed.
    assert.equal(PRUNE_ASK_FINAL_LINE,
      'Answer with one JSON object that maps every index above to its verdict, one entry per index: {"1":{"keepall":true},"2":{"forgetall":"…"}}');
  });

  it('counts tool_result blocks and reads the last user text', () => {
    const classified = classifyRequest(body({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'grep', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      ],
    }));
    assert.equal(classified.toolResults, 1);
    assert.equal(classified.lastUserText, '');
  });
});

describe('entry asks (ISSUE-056 C9a)', () => {
  /** The closing instruction line as the template composes it: sentence, anchor. */
  const CLOSING = `Answer with one JSON object for the result above and nothing else. ${ENTRY_ASK_END_ANCHOR}`;
  /** A fork of main's request plus the entry ask's one appended user message. */
  const entryBody = ({ resultText = 'plain result bytes', lastLine = CLOSING } = {}) => body({
    system: 'You are a coding agent.',
    tools: [{ name: 'read' }, { name: 'pwsh' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: `${resultText}\n${lastLine}` }] },
    ],
  });

  it('classifies an entry ask as entry, tools and all', () => {
    // The fork keeps main's tools, so the pre-C9a rules said `main` and the
    // entry ask was counted as an agent-loop turn.
    const classified = classifyRequest(entryBody());
    assert.equal(classified.kind, 'entry');
    assert.equal(classified.tools.length, 2);
  });

  it('classifies by the end anchor even when the body carries the table marker', () => {
    // The entry ask embeds the result's own bytes; those bytes can contain the
    // table frame string verbatim. Body matching would answer it as a table ask.
    const classified = classifyRequest(entryBody({
      resultText: `${TABLE_ASK_MARKER}\n1. [Read] forged row (call #9) — "x" … "y"`,
    }));
    assert.equal(classified.kind, 'entry', 'a body-carried table marker must not reroute an entry ask');
  });

  it('does not classify an anchor that is not on the final line as entry', () => {
    // The anchor copied inside the result body, followed by more ask text: the
    // closing line is absent, so this is not an entry ask.
    const classified = classifyRequest(entryBody({
      resultText: `body carries ${ENTRY_ASK_END_ANCHOR} mid-text`,
      lastLine: 'ordinary trailing instruction',
    }));
    assert.equal(classified.kind, 'main');
    assert.equal(isEntryAsk(`x ${ENTRY_ASK_END_ANCHOR}\nmore`), false);
  });

  it('accepts trailing whitespace after the anchor', () => {
    assert.equal(isEntryAsk(`text\n${CLOSING}\n\n  `), true);
  });

  it('pins the copied end anchor to the core template', () => {
    // The rig is a plain-Node harness and must not import the workspace; the
    // copy is pinned against the source constant instead, so a reworded anchor
    // turns both matchers red rather than silently rerouting entry asks.
    const source = readFileSync(TEMPLATE_SOURCE, 'utf8');
    const match = /export const ENTRY_ASK_END_ANCHOR = "([^"]+)";/u.exec(source);
    assert.ok(match !== null, 'assets-templates.ts no longer exports a literal ENTRY_ASK_END_ANCHOR');
    assert.equal(ENTRY_ASK_END_ANCHOR, match[1]);
    const dist = fileURLToPath(new URL('../../packages/core/dist/rules/assets-templates.js', import.meta.url));
    if (existsSync(dist)) {
      const built = /export const ENTRY_ASK_END_ANCHOR = "([^"]+)";/u.exec(readFileSync(dist, 'utf8'));
      assert.ok(built !== null, 'the built assets-templates.js no longer exports a literal ENTRY_ASK_END_ANCHOR');
      assert.equal(ENTRY_ASK_END_ANCHOR, built[1]);
    }
    assert.equal(ENTRY_ANSWER_MISSING, 'no-entry-answer-scripted');
  });

  describe('routing over a live socket', () => {
    /** Post every body, then return the responses and the log records, in order. */
    async function withMock(scriptDoc, bodies = [entryBody()]) {
      const mock = await startMock(scriptDoc);
      try {
        const responses = [];
        for (const bodyDoc of bodies) responses.push(await mock.post(bodyDoc));
        return { responses, records: mock.records(), first: { response: responses[0], ...mock.records()[0] } };
      } finally {
        mock.stop();
      }
    }

    it('refuses an unscripted entry ask loudly instead of falling through to a reply row', async () => {
      const { first } = await withMock({
        replies: [{ reply: { type: 'text', text: 'MAIN-FALLBACK' } }],
      });
      assert.equal(first.response.status, 500);
      assert.equal(JSON.parse(first.response.text).error.type, 'rig_no_entry_answer');
      assert.equal(first.kind, 'entry');
      assert.equal(first.matched, ENTRY_ANSWER_MISSING);
      assert.equal(ENTRY_ANSWER_MISSING, 'no-entry-answer-scripted');
    });

    it('serves answers.entry to an entry ask and never the replies fallback', async () => {
      // The response and the record's `answer` must agree: that equality is the
      // join an offline harvest relies on.
      const { first } = await withMock({
        answers: { entry: { type: 'text', text: '{"keepall":true}', stop_reason: 'end_turn' } },
        replies: [{ reply: { type: 'text', text: 'MAIN-FALLBACK' } }],
      });
      assert.equal(first.response.status, 200);
      assert.match(first.response.text, /"text":"\{\\"keepall\\":true\}"/u);
      assert.doesNotMatch(first.response.text, /MAIN-FALLBACK/u);
      assert.equal(first.kind, 'entry');
      assert.equal(first.matched, 'entry-answer');
      assert.equal(first.answer, '{"keepall":true}');
      assert.equal(first.answer_index, 0);
    });

    it('rejects a malformed answers.entry at load time', () => {
      assert.throws(() => normalizeScript({ answers: { entry: { type: 'telepathy' } } }), /answers\.entry has unknown type/u);
      assert.throws(() => normalizeScript({ answers: { entry: 'text' } }), /answers\.entry` must be a reply object/u);
    });
  });
});

describe('entry answers by script (ISSUE-058 RIG-1)', () => {
  /** A reply that scripts one shape through the placeholder. */
  const shaped = (shape) => ({ type: 'text', text: SHAPE_ANSWER_PLACEHOLDER, shape });

  it('documents the placeholder and the three actions it accepts', () => {
    assert.equal(SHAPE_ANSWER_PLACEHOLDER, '{{shapeAnswer}}');
    assert.deepEqual(ENTRY_SHAPE_ACTIONS, ['keepall', 'forgetall', 'keeplines']);
  });

  it('expands {{shapeAnswer}} to each of the three entry forms', () => {
    assert.equal(shapeAnswerText({ keepall: true }), '{"keepall":true}');
    assert.equal(shapeAnswerText({ forgetall: 'a stale build log from the old host' }),
      '{"forgetall":"a stale build log from the old host"}');
    assert.equal(shapeAnswerText({ keeplines: [[2, 3], 'stale run notes'] }),
      '{"keeplines":[[2,3],"stale run notes"]}');
  });

  it('expands the placeholder inside a scripted reply at load time', () => {
    const script = normalizeScript({ answers: { entry: shaped({ keeplines: [[2, 3], 'stale run notes'] }) } });
    assert.equal(script.entryAnswers.length, 1);
    assert.equal(script.entryAnswers[0].text, '{"keeplines":[[2,3],"stale run notes"]}');
    // The `shape` key is the script's, never the reply's: it must not reach the wire.
    assert.equal(Object.hasOwn(script.entryAnswers[0], 'shape'), false);
  });

  it('refuses keephead with its own named error', () => {
    // The corrected grammar has three answers; a stale scenario that scripts a
    // first-N count must fail at load, not reach the product as an answer.
    assert.throws(() => shapeAnswerText({ keephead: 12 }), /keephead[\s\S]*exactly keepall, forgetall and keeplines/u);
  });

  it('refuses a fourth action, a second key and a malformed payload', () => {
    assert.throws(() => shapeAnswerText({ forgetlines: [[1, 2], 'x'] }), /not one of keepall, forgetall, keeplines/u);
    assert.throws(() => shapeAnswerText({}), /exactly one top-level key/u);
    assert.throws(() => shapeAnswerText({ keepall: true, forgetall: 'x' }), /exactly one top-level key/u);
    assert.throws(() => shapeAnswerText({ keepall: 'true' }), /keepall carries the boolean true/u);
    assert.throws(() => shapeAnswerText({ forgetall: 7 }), /forgetall carries its summary as the value/u);
    assert.throws(() => shapeAnswerText({ keeplines: [[2, 3]] }), /at least one \[start,end\] pair and a trailing summary/u);
    assert.throws(() => shapeAnswerText({ keeplines: [[3, 2], 'x'] }), /1 <= start <= end/u);
    assert.throws(() => shapeAnswerText({ keeplines: [[0, 2], 'x'] }), /1 <= start <= end/u);
    assert.throws(() => shapeAnswerText({ keeplines: [[1.5, 2], 'x'] }), /1 <= start <= end/u);
  });

  it('refuses a summary past the 25-word cap', () => {
    const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' ');
    assert.throws(() => shapeAnswerText({ forgetall: long }), /26 words; the cap is 25/u);
    assert.throws(() => shapeAnswerText({ keeplines: [[1, 2], long] }), /the cap is 25/u);
    // Exactly 25 is legal, and so is a blank summary (zero words).
    const atCap = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
    assert.equal(shapeAnswerText({ forgetall: atCap }), `{"forgetall":${JSON.stringify(atCap)}}`);
    assert.equal(shapeAnswerText({ forgetall: '' }), '{"forgetall":""}');
  });

  it('refuses a placeholder that is not the whole reply text, and a stray shape', () => {
    assert.throws(() => normalizeScript({
      answers: { entry: { type: 'text', text: `prefix ${SHAPE_ANSWER_PLACEHOLDER}`, shape: { keepall: true } } },
    }), /must carry \{\{shapeAnswer\}\} as its whole text/u);
    assert.throws(() => normalizeScript({
      answers: { entry: { type: 'text', text: SHAPE_ANSWER_PLACEHOLDER } },
    }), /carries \{\{shapeAnswer\}\} but no shape value/u);
    assert.throws(() => normalizeScript({
      answers: { entry: { type: 'text', text: '{"keepall":true}', shape: { keepall: true } } },
    }), /has a shape but its text carries no \{\{shapeAnswer\}\}/u);
  });

  it('refuses a shape placeholder in a replies row, where nothing would expand it', () => {
    assert.throws(() => normalizeScript({
      replies: [{ reply: { type: 'text', text: SHAPE_ANSWER_PLACEHOLDER, shape: { keepall: true } } }],
    }), /reply 0 scripts \{\{shapeAnswer\}\}; the shape placeholder belongs to `answers\.entry`/u);
  });

  it('refuses an empty answers.entry array', () => {
    assert.throws(() => normalizeScript({ answers: { entry: [] } }), /must name at least one reply/u);
  });

  it('names the failing array slot in the load error', () => {
    assert.throws(() => normalizeScript({
      answers: { entry: [shaped({ keepall: true }), shaped({ keephead: 4 })] },
    }), /answers\.entry\[1\][\s\S]*keephead/u);
  });

  describe('array sequencing over a live socket', () => {
    /** The entry ask body, labelled per ask so the log can tell them apart. */
    const ask = (label) => body({
      system: 'You are a coding agent.',
      tools: [{ name: 'read' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `${label}\n${ENTRY_ASK_END_ANCHOR}` }] }],
    });
    /** Serve `count` entry asks and return the log records in order. */
    async function serve(scriptDoc, count) {
      const mock = await startMock(scriptDoc);
      try {
        for (let i = 0; i < count; i += 1) {
          const response = await mock.post(ask(`ask ${i + 1}`));
          assert.equal(response.status, 200, `ask ${i + 1} was refused: ${response.text}`);
        }
        return mock.records();
      } finally {
        mock.stop();
      }
    }

    it('serves array entries in order and repeats the last', async () => {
      // Three asks, two scripted entries: 1 then 2, then 2 again. This is the
      // shape a run needs when the first result is kept whole and the next is
      // forgotten — a fixed reply cannot express it.
      const records = await serve({
        answers: { entry: [shaped({ keepall: true }), shaped({ forgetall: 'stale build log' })] },
      }, 3);
      assert.deepEqual(records.map((record) => record.kind), ['entry', 'entry', 'entry']);
      assert.deepEqual(records.map((record) => record.answer_index), [0, 1, 1]);
      assert.deepEqual(records.map((record) => record.answer),
        ['{"keepall":true}', '{"forgetall":"stale build log"}', '{"forgetall":"stale build log"}']);
      // The ask side is recorded too, so the join is ask -> answer.
      assert.deepEqual(records.map((record) => record.matched), ['entry-answer', 'entry-answer', 'entry-answer']);
      assert.match(JSON.stringify(records[0].body), /ask 1/u);
      assert.match(JSON.stringify(records[2].body), /ask 3/u);
    });

    it('serves a single-object answers.entry to every ask', async () => {
      const records = await serve({ answers: { entry: shaped({ keepall: true }) } }, 2);
      assert.deepEqual(records.map((record) => record.answer), ['{"keepall":true}', '{"keepall":true}']);
      assert.deepEqual(records.map((record) => record.answer_index), [0, 0]);
    });

    it('counts only entry asks, not main turns, against the queue', async () => {
      // A main turn between two entry asks must not consume a queued answer.
      const mock = await startMock({
        answers: { entry: [shaped({ keepall: true }), shaped({ keeplines: [[1, 1], 'kept one line'] })] },
        replies: [{ reply: { type: 'text', text: 'MAIN' } }],
      });
      try {
        await mock.post(ask('ask 1'));
        await mock.post(body({ system: 'You are a coding agent.', messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] }));
        await mock.post(ask('ask 2'));
        const records = mock.records();
        assert.deepEqual(records.map((record) => record.kind), ['entry', 'main', 'entry']);
        assert.deepEqual(records.filter((record) => record.kind === 'entry').map((record) => record.answer_index), [0, 1]);
      } finally {
        mock.stop();
      }
    });
  });
});

describe('matchers', () => {
  const ctx = { body: body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }], tools: [{ name: 'grep' }] }), serialized: '{"a":"hello world"}', tools: [{}], toolResults: 2, lastUserText: 'hello world' };

  it('matches tools_length present/absent/number', () => {
    assert.equal(matches({ tools_length: 'present' }, ctx), true);
    assert.equal(matches({ tools_length: 'absent' }, ctx), false);
    assert.equal(matches({ tools_length: 1 }, ctx), true);
    assert.equal(matches({ tools_length: 2 }, ctx), false);
  });

  it('requires every present field to hold', () => {
    assert.equal(matches({ tool_results_count: 2, body_text_contains: ['hello', 'absent-here'] }, ctx), false);
    assert.equal(matches({ tool_results_count: 2, body_text_contains: ['hello'] }, ctx), true);
  });

  it('applies last_user_text_matches as a regex', () => {
    assert.equal(matches({ last_user_text_matches: '^hello' }, ctx), true);
    assert.equal(matches({ last_user_text_matches: '^goodbye' }, ctx), false);
  });

  it('matches last_assistant_tool_names as an ordered, exact list', () => {
    const named = { ...ctx, lastAssistantToolNames: ['read', 'pwsh'] };
    assert.equal(matches({ last_assistant_tool_names: ['read', 'pwsh'] }, named), true);
    // Order is part of the key: replay keys distinguish call order.
    assert.equal(matches({ last_assistant_tool_names: ['pwsh', 'read'] }, named), false);
    // Length is part of the key: a missing or extra call is a different turn.
    assert.equal(matches({ last_assistant_tool_names: ['read'] }, named), false);
    assert.equal(matches({ last_assistant_tool_names: [] }, named), false);
    // A bare string is accepted as a one-element list.
    assert.equal(matches({ last_assistant_tool_names: 'read' }, { ...ctx, lastAssistantToolNames: ['read'] }), true);
    // Absent in context means "no tool call in the newest assistant message".
    assert.equal(matches({ last_assistant_tool_names: [] }, ctx), true);
  });

  it('reads the newest assistant tool_use blocks in order', () => {
    const classified = classifyRequest(body({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }, { type: 'tool_use', id: 'b', name: 'pwsh', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      ],
    }));
    assert.deepEqual(classified.lastAssistantToolNames, ['read', 'pwsh']);
    assert.equal(classified.toolResults, 1);
  });

  it('treats an invalid regex as a row that does not match', () => {
    // The script is refused at load, so the request path never throws
    // (ISSUE-581).
    assert.equal(matches({ last_user_text_matches: '(' }, ctx), false);
  });
});

describe('table answers', () => {
  const tableAsk = (rows) => JSON.stringify(body({
    messages: [{ role: 'user', content: [{ type: 'text',
      text: `frame\n\n${PRUNE_ASK_TABLE_HEADING}\n\n${rows.join('\n')}\n\n${PRUNE_ASK_FINAL_LINE}` }] }],
  }));

  it('expands {{tableAnswer}} to keepall for every assigned index', () => {
    const out = substituteTableAnswer({ type: 'text', text: TABLE_ANSWER_PLACEHOLDER },
      tableAsk(['1. [Read] a (call #1) — "x" … "y"', '2. [Bash] b (call #2) — "x" … "y"']));
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(out.reply.text), { 1: { keepall: true }, 2: { keepall: true } });
  });

  it('expands {{forgetallTableAnswer}} to forgetall for every assigned index', () => {
    const out = substituteTableAnswer({ type: 'text', text: FORGETALL_TABLE_ANSWER_PLACEHOLDER },
      tableAsk(['1. [Read] a (call #1) — "x" … "y"', '2. [Bash] b (call #2) — "x" … "y"', '3. [Read] c (call #3) — "x" … "y"']));
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(out.reply.text), {
      1: { forgetall: FORGETALL_REASON },
      2: { forgetall: FORGETALL_REASON },
      3: { forgetall: FORGETALL_REASON },
    });
  });

  it('expands {{partialTableAnswer}} to keepall for every index but the highest', () => {
    // ISSUE-120: the omitted highest index is the parser's `missing-index`
    // refusal, which is what gives the pass a row to carry and correct.
    const out = substituteTableAnswer({ type: 'text', text: TABLE_PARTIAL_PLACEHOLDER },
      tableAsk(['1. [Read] a (call #1) — "x" … "y"', '2. [Bash] b (call #2) — "x" … "y"',
        '3. [Read] c (call #3) — "x" … "y"']));
    assert.equal(out.error, null);
    assert.deepEqual(JSON.parse(out.reply.text), { 1: { keepall: true }, 2: { keepall: true } });
  });

  it('refuses a partial placeholder that is not the whole reply text', () => {
    const out = substituteTableAnswer({ type: 'text', text: `prefix ${TABLE_PARTIAL_PLACEHOLDER}` },
      tableAsk(['1. [Read] a (call #1) — "x" … "y"']));
    assert.match(out.error, /must be the whole reply text/u);
  });

  it('refuses a partial placeholder with no table in the request', () => {
    const out = substituteTableAnswer({ type: 'text', text: TABLE_PARTIAL_PLACEHOLDER },
      JSON.stringify(body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] })));
    assert.match(out.error, /carries no table rows/u);
  });

});

describe('reply shapes over a live socket', () => {
  let server;
  let base;
  const replies = new Map();

  before(async () => {
    server = createServer((req, res) => {
      const name = req.url.slice(1);
      sendReply(res, replies.get(name), 10);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    // fetch keeps idle keep-alive sockets; close() alone would wait for them.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function text(name) {
    const response = await fetch(`${base}/${name}`);
    return { status: response.status, text: await response.text() };
  }

  it('emits the full frame order for a text reply', async () => {
    replies.set('text', { type: 'text', text: 'READY', stop_reason: 'end_turn' });
    const { status, text: raw } = await text('text');
    assert.equal(status, 200);
    const events = raw.split('\n').filter((line) => line.startsWith('event: ')).map((line) => line.slice(7));
    assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.match(raw, /"stop_reason":"end_turn"/u);
  });

  it('emits a tool_use block with input_json_delta', async () => {
    replies.set('tool', { type: 'tool_use', calls: [{ id: 'call_1', name: 'grep', input: { pattern: 'x' } }] });
    const { text: raw } = await text('tool');
    assert.match(raw, /"type":"tool_use","id":"call_1","name":"grep"/u);
    // partial_json carries the JSON-encoded argument string, so the inner quotes are escaped.
    const delta = raw.split('\n').find((line) => line.includes('"input_json_delta"'));
    assert.ok(delta !== undefined, 'no input_json_delta frame');
    const payload = JSON.parse(delta.slice('data: '.length));
    assert.equal(payload.delta.partial_json, '{"pattern":"x"}');
    assert.match(raw, /"stop_reason":"tool_use"/u);
  });

  it('emits an HTTP 4xx with a provider error body', async () => {
    replies.set('http', { type: 'http_error', status: 400, error: { type: 'invalid_request_error', message: 'boom' } });
    const { status, text: raw } = await text('http');
    assert.equal(status, 400);
    assert.deepEqual(JSON.parse(raw), { error: { type: 'invalid_request_error', message: 'boom' } });
  });

  it('emits an SSE error event', async () => {
    replies.set('sse', { type: 'sse_error', error: { type: 'overloaded_error', message: 'busy' } });
    const { status, text: raw } = await text('sse');
    assert.equal(status, 200);
    assert.match(raw, /^event: error\ndata: \{"type":"error"/u);
  });

  it('truncates before message_stop', async () => {
    replies.set('cut', { type: 'truncated', text: 'half' });
    const { text: raw } = await text('cut');
    assert.match(raw, /message_start/u);
    assert.doesNotMatch(raw, /message_stop/u);
    assert.doesNotMatch(raw, /message_delta/u);
  });
});

describe('process contract', () => {
  it('refuses a non-loopback host with exit 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-mock-'));
    const script = join(dir, 'script.json');
    writeFileSync(script, '{"replies":[]}');
    const result = spawnSync(process.execPath, [MOCK, '--port', '0', '--host', '0.0.0.0', '--log', join(dir, 'l.jsonl'), '--script', script], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing non-loopback host/u);
  });

  it('accepts only loopback spellings', () => {
    assert.deepEqual([...LOOPBACK_HOSTS].sort(), ['127.0.0.1', '::1', 'localhost']);
  });

  it('documents the dummy key it expects', () => {
    assert.equal(DEFAULT_API_KEY, 'mock-key-not-real');
  });

  it('logs an unmatched main request and answers 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-mock-'));
    const script = join(dir, 'script.json');
    const log = join(dir, 'l.jsonl');
    writeFileSync(script, JSON.stringify({ replies: [{ match: { tools_length: 'absent' }, reply: { type: 'text', text: 'only-no-tools' } }] }));
    const child = (await import('node:child_process')).spawn(process.execPath, [MOCK, '--port', '0', '--log', log, '--script', script]);
    try {
      const port = await new Promise((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) {
            try { resolve(JSON.parse(buffer.split('\n')[0]).port); } catch { reject(new Error(`unexpected mock output: ${buffer}`)); }
          }
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': DEFAULT_API_KEY },
        body: JSON.stringify(body({ tools: [{ name: 'grep' }] })),
      });
      assert.equal(response.status, 500);
      const record = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(record.matched, 'no-match');
      assert.equal(record.headers_redacted['x-api-key'], '<dummy>');
    } finally {
      child.kill();
    }
  });
});

/**
 * The entry checkpoint's ask on the corrected protocol (ISSUE-058 chunk P3c-1;
 * ADR-0022 §3–§6, §14; anchor design §1, §4, §7), with a fake model seam and
 * a hand-written seed.
 *
 * The claims, each tested where it can fail:
 *
 *   1. the fork is seeded from the RESULT-LANDED wire state: main's captured
 *      request plus one landed `tool` turn carrying the body's own text, and one
 *      appended ask turn — proven byte-exact against the whole sent message
 *      array, with the pre-landing state excluded by construction;
 *   2. the ask is body-free: it states `N` and the anchors, and no body byte
 *      appears inside it (the body is on the fork's prefix, never the question);
 *   3. `N` is byte arithmetic (`lineCount`), so an undecodable body still states
 *      its count and ships zero anchors;
 *   4. the three answers parse, `keephead` refuses, and the parser's own codes
 *      reach the caller;
 *   5. one bounded retry: an arithmetically unusable answer earns exactly one
 *      correction turn restating the same facts, and a second bad answer fails
 *      open — never a third send;
 *   6. every failure arm is DATA naming its code; the result is never touched
 *      and nothing throws into the caller;
 *   7. the host's `usage` chunk is captured on both arms by the one shipped
 *      arithmetic, and absent when the host says nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_SYSTEM_PROMPT, canonicalManifestBytes, entryAskFactsBlock,
  entryAskMessage, equalBytes, parseEntryAnswer, sha256Sync, toBytes,
} from '@cremator/core';
import type { EntryAnswer, WireRequest } from '@cremator/core';
import { askEntry, askEntryBatch, entryAskFacts, entryAskTableable, entryRetryAskMessage,
  factsShowTwoQuotes } from '../src/entry-ask.js';
import type { EntryAskVariant } from '../src/entry-ask.js';
import { CREMATOR_JOURNAL_KINDS } from '../src/journal-kinds.js';
import type { MountJournal, RacoonsJournalKind } from '../src/journal-kinds.js';
import { isRacoonsAskRequest } from '../src/llm-ask.js';
import type { DshLlmChunk, DshLlmStreamOptions } from '../src/plugin.js';

const route = { provider: 'a6', model: 'deepseek-v4.1-flash-1017' };
const RESULT_TEXT = 'line one\nline two\nline three\n';
const RESULT_BYTES = new TextEncoder().encode(RESULT_TEXT);
/** A token that exists nowhere but this body, so a leak into the ask is visible. */
const BODY_TOKEN = 'BODY-TOKEN-never-in-the-ask';
/** The reading the usage-chunk test asserts, named once for the journal test. */
const observedUsage = { inputTokens: 2000, outputTokens: 30, cachedInputTokens: 800 };

/** 201 realistic lines; anchors land at 67 and 134 (ADR-0022 §5's worked case). */
const LONG_TEXT = `${Array.from({ length: 201 }, (_, index) =>
  `row ${String(index + 1)}: 2026-10-26T04:12:07Z INFO worker: job ${String(index + 1)} finished in 1.8s`)
  .join('\n')}\n`;
const LONG_BYTES = new TextEncoder().encode(LONG_TEXT);

/**
 * `count` numbered lines whose every tail is quotable and distinct, so an
 * anchor is recognisable by its line number alone.
 */
function numberedBody(count: number, tag = 'ROW'): string {
  return `${Array.from({ length: count }, (_, index) =>
    `${tag}-${String(index + 1)} worker: job ${String(index + 1)} finished in 1.8s`).join('\n')}\n`;
}

/** One numbered body as the bytes a host lands. */
function numberedBytes(count: number, tag = 'ROW'): Uint8Array {
  return new TextEncoder().encode(numberedBody(count, tag));
}

/**
 * Main's last captured request BEFORE the result landed: its list ends with the
 * assistant turn that carried the tool call, which is what the host dispatched.
 */
const SEED: WireRequest = {
  system: 'main system prompt',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', text: 'read big.txt' },
    { role: 'assistant', text: '[tool call read {"path":"big.txt"}]' },
  ],
};

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A fake model seam serving one scripted chunk list per call, in order. */
function fakeLlm(...script: readonly (readonly DshLlmChunk[]
  | (() => AsyncIterable<DshLlmChunk>))[]): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  let served = 0;
  return {
    calls,
    stream(options) {
      calls.push(options);
      const entry = script[Math.min(served, script.length - 1)] ?? [];
      served += 1;
      if (typeof entry === 'function') return entry();
      return (async function* emit() { for (const chunk of entry) yield chunk; })();
    },
  };
}

/** The reply one fake stream delivers, split into awkward deltas, then usage. */
function answerChunks(text: string, usage?: Record<string, number>): DshLlmChunk[] {
  const chunks: DshLlmChunk[] = [
    { type: 'text-delta', index: 0, text: text.slice(0, 4) },
    { type: 'text-delta', index: 0, text: text.slice(4) },
  ];
  if (usage !== undefined) chunks.push({ type: 'usage', usage });
  chunks.push({ type: 'finish', reason: 'stop' });
  return chunks;
}

/** Ask once against `SEED` with one reply text. */
async function ask(text: string, overrides: {
  readonly usage?: Record<string, number>;
} = {}): Promise<Awaited<ReturnType<typeof askEntry>>> {
  return askEntry({
    resultBytes: RESULT_BYTES,
    seed: SEED,
    llm: fakeLlm(answerChunks(text, overrides.usage)),
    route,
  });
}

/** The message texts one sent request carries, in order. */
function sentTexts(sent: DshLlmStreamOptions): (string | undefined)[] {
  const messages = sent['messages'] as readonly Record<string, unknown>[];
  return messages.map(message =>
    (message['content'] as readonly { type: string; text: string }[])[0]?.text);
}

test('all three answer forms parse; the ask they came from is one appended user turn', async () => {
  const forms: readonly (readonly [string, EntryAnswer])[] = [
    ['{"keepall":true}', { action: 'keepall' }],
    ['{"keeplines":[[1,1],[3,3],"the middle line was stale"]}', {
      action: 'keeplines', ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }],
      summary: 'the middle line was stale',
    }],
    ['{"forgetall":"an old build log"}', { action: 'forgetall', summary: 'an old build log' }],
  ];
  for (const [text, expected] of forms) {
    const outcome = await ask(text);
    assert.equal(outcome.status, 'answered', `"${text}" is an answer`);
    if (outcome.status !== 'answered') continue;
    assert.deepEqual(outcome.answer, expected, 'the module hands on the parser\'s own answer');
    assert.equal(outcome.raw, text, 'the raw text rides beside the answer, verbatim');
    assert.deepEqual(outcome.answer, parseEntryAnswer(text));
    assert.equal(outcome.retried, false, 'a readable answer needs no correction turn');
    assert.deepEqual(outcome.turns.map(turn => turn.role), ['user', 'assistant'],
      'the exchange is the one ask and its answer');
    assert.equal(outcome.turns[1]?.text, text, 'the answer turn is the reply, verbatim');
  }
});

test('the seed is the result-landed wire: main\'s bytes plus the landed turn, byte-exact', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  assert.equal(llm.calls.length, 1, 'one ask, never a retry for a good answer');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  assert.equal(isRacoonsAskRequest(sent), true, 'the ask is marked, so it can never seed a fork');
  const askText = entryAskMessage(entryAskFacts(RESULT_BYTES));
  // The WHOLE message array, byte for byte: main's two turns, the landed result
  // turn (text role, sent as `user`), and the one ask turn. A pre-landing seed
  // would be missing index 2; a body-embedding ask would repeat it inside 3.
  assert.deepEqual(sent['messages'], [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant',
      source: { kind: 'model', provider: route.provider, model: route.model },
      content: [{ type: 'text', text: '[tool call read {"path":"big.txt"}]' }] },
    { role: 'user', content: [{ type: 'text', text: RESULT_TEXT }] },
    { role: 'user', content: [{ type: 'text', text: askText }] },
  ], 'the prefix is main\'s wire after the result landed, then the ask, and nothing else');
  assert.equal(sent['system'], SEED.system, 'main\'s system bytes are untouched');
  assert.deepEqual(sent['tools'], SEED.tools, 'and so is main\'s tool list');
  // Byte-exact, not merely structurally equal: the canonical bytes of what left
  // must equal the canonical bytes of the expected array, built here by hand.
  const expected = [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant',
      source: { kind: 'model', provider: route.provider, model: route.model },
      content: [{ type: 'text', text: '[tool call read {"path":"big.txt"}]' }] },
    { role: 'user', content: [{ type: 'text', text: RESULT_TEXT }] },
    { role: 'user', content: [{ type: 'text', text: askText }] },
  ];
  assert.equal(equalBytes(canonicalManifestBytes(sent['messages']),
    canonicalManifestBytes(expected)), true, 'the sent prefix is the expected bytes, exactly');
});

test('a 60-line row shows two quotes, and no whole body byte enters the ask', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  // 60 long lines: large enough that a body-sized ask would be obvious (the
  // contract alone is ~1.6 KB), and ADR-0042 puts two quotes on it (lines 20
  // and 40) where the old rule shipped none.
  const padding = 'x'.repeat(150);
  const body = `${Array.from({ length: 60 },
    (_, index) => `line ${String(index + 1)} ${BODY_TOKEN} ${padding}`).join('\n')}\n`;
  const bytes = new TextEncoder().encode(body);
  const facts = entryAskFacts(bytes);
  assert.deepEqual(facts, {
    lineCount: 60,
    anchorLines: [
      `line 20 ends with "${'x'.repeat(30)}"`,
      `line 40 ends with "${'x'.repeat(30)}"`,
    ],
  }, 'two quote lines, each the last thirty code points of its own line');
  assert.equal(factsShowTwoQuotes(facts), true);
  const outcome = await askEntry({ resultBytes: bytes, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  const askText = texts[texts.length - 1] ?? '';
  assert.equal(askText, entryAskMessage(facts),
    'the ask is the shipped body-free composition');
  assert.equal(askText.includes(BODY_TOKEN), false,
    'a quote is a line tail, never the whole line or the body');
  assert.equal(askText.includes('line 1 BODY'), false);
  assert.ok(askText.includes(ENTRY_ASK_SYSTEM_PROMPT), 'the contract rides inside the ask');
  assert.ok(askText.endsWith(ENTRY_ASK_CLOSING_LINE), 'the end anchor closes it');
  assert.ok(askText.includes('This result has 60 lines, so keeplines ranges sit in [1,60].'),
    'N is always stated');
  // The body is on the PREFIX (the landed turn), which is where a cache hit needs it.
  assert.equal(texts[2], body, 'the landed result turn carries the body exactly once');
  assert.ok(askText.length < body.length / 2, 'the ask stays near-constant, not body-sized');
});

test('the visible-line rule: 25 lines gives two quotes, 100 two, 2 two distinct, 1 is not tabled', () => {
  const short = entryAskFacts(numberedBytes(25));
  assert.equal(short.lineCount, 25);
  assert.deepEqual(short.anchorLines, [
    'line 8 ends with "worker: job 8 finished in 1.8s"',
    'line 16 ends with "worker: job 16 finished in 1.8s"',
  ], 'the 25-line row ISSUE-186 saw now names two of its own lines');
  assert.equal(factsShowTwoQuotes(short), true);

  const hundred = entryAskFacts(numberedBytes(100));
  assert.equal(hundred.lineCount, 100);
  assert.deepEqual(hundred.anchorLines, [
    'line 33 ends with "worker: job 33 finished in 1.8s"',
    'line 66 ends with "worker: job 66 finished in 1.8s"',
  ], 'a 100-line row keeps two quotes at 33 and 66');

  const two = entryAskFacts(numberedBytes(2));
  assert.equal(two.lineCount, 2);
  assert.deepEqual(two.anchorLines, [
    'line 1 ends with "worker: job 1 finished in 1.8s"',
    'line 2 ends with "worker: job 2 finished in 1.8s"',
  ], 'a two-line row names two distinct lines');
  assert.equal(new Set(two.anchorLines).size, 2, 'the two quotes are distinct');

  const one = entryAskFacts(numberedBytes(1));
  assert.equal(one.lineCount, 1);
  assert.deepEqual(one.anchorLines, [], 'a one-line row has only one line to name');
  assert.equal(factsShowTwoQuotes(one), false);
  assert.equal(entryAskTableable(numberedBytes(1)), false, 'and it is not tabled');
});

test('a truncated capture quotes the visible lines and nothing outside them', () => {
  // A head cut: 25 whole lines and the start of the 26th, exactly the bytes a
  // capture holds. Positions are computed over the visible lines.
  const whole = numberedBody(200).split('\n');
  const kept = `${whole.slice(0, 25).join('\n')}\nROW-26 worker: job 26 fini`;
  const bytes = new TextEncoder().encode(kept);
  const facts = entryAskFacts(bytes);
  assert.equal(facts.lineCount, 26, 'the capture visibly holds 26 lines, the last one cut');
  assert.deepEqual(facts.anchorLines, [
    'line 8 ends with "worker: job 8 finished in 1.8s"',
    'line 16 ends with "worker: job 16 finished in 1.8s"',
  ], 'every quote comes from a line the capture visibly holds');
  for (const anchor of facts.anchorLines) {
    const number = Number(/^line (\d+) ends with/u.exec(anchor)?.[1]);
    assert.ok(number >= 1 && number <= facts.lineCount,
      `"${anchor}" names a line inside the visible text`);
  }
  assert.equal(entryAskTableable(bytes), true, 'the truncated row is still tabled');
});

test('a cut inside a multi-byte character drops the incomplete tail and quotes the prefix', () => {
  // "café" ends with a two-byte character; the capture keeps only its lead byte.
  // The incomplete bytes are dropped and the visible prefix is quoted, with no
  // replacement character and no invented line.
  const full = new TextEncoder().encode(
    'café line one\ncafé line two\ncafé line three\ncafé line four\ncafé');
  const cut = full.subarray(0, full.byteLength - 1);
  const facts = entryAskFacts(cut);
  assert.equal(facts.lineCount, 5, 'the visible prefix still holds five lines');
  assert.deepEqual(facts.anchorLines, [
    'line 1 ends with "café line one"',
    'line 2 ends with "café line two"',
  ]);
  assert.equal(facts.anchorLines.some(anchor => anchor.includes('\uFFFD')), false,
    'the incomplete character never reaches a quote as a replacement character');
  assert.equal(entryAskTableable(cut), true);

  // A three-byte character cut on a content line drops exactly its incomplete
  // bytes: the line keeps the content before it and stays a visible line.
  const euro = new TextEncoder().encode('alpha line\n€ beta line\ntail €');
  const euroCut = euro.subarray(0, euro.byteLength - 1);
  const euroFacts = entryAskFacts(euroCut);
  assert.equal(euroFacts.lineCount, 3, 'the cut line still holds its visible "tail "');
  assert.deepEqual(euroFacts.anchorLines, [
    'line 1 ends with "alpha line"',
    'line 2 ends with "€ beta line"',
  ]);
});

test('a row whose sampled lines cannot yield two quotes is not tableable', () => {
  // Every line is one code point: no line is quotable and the earlier-line
  // fallback finds nothing either, so the row carries no quote at all.
  const braces = `${Array.from({ length: 100 }, () => '}').join('\n')}\n`;
  const bytes = new TextEncoder().encode(braces);
  const facts = entryAskFacts(bytes);
  assert.equal(facts.lineCount, 100);
  assert.deepEqual(facts.anchorLines, []);
  assert.equal(factsShowTwoQuotes(facts), false);
  assert.equal(entryAskTableable(bytes), false);
});

test('the batch table drops a row that cannot show two quotes and keeps its index', async () => {
  const unquotable = new TextEncoder().encode('}\n}\n}\n');
  const quotable = numberedBytes(25, 'GOOD');
  const surface: WireRequest = { ...SEED, messages: [
    { role: 'user', text: 'read both.txt' },
    { role: 'assistant', text: '[tool call read {"path":"bad.txt"}]' },
    { role: 'tool', text: '}\n}\n}\n' },
    { role: 'assistant', text: '[tool call read {"path":"good.txt"}]' },
    { role: 'tool', text: numberedBody(25, 'GOOD') },
  ] };
  const llm = fakeLlm(answerChunks('{"2":{"keepall":true}}'));
  const outcome = await askEntryBatch({ rows: [
    { index: 1, call: 'read bad.txt', resultBytes: unquotable, resultNodeId: 'n1' },
    { index: 2, call: 'read good.txt', resultBytes: quotable, resultNodeId: 'n2' },
  ], seed: SEED, surface, llm, route, grammar: 'jsonl-20' });
  assert.equal(outcome.status, 'answered');
  if (outcome.status !== 'answered') return;
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const ask = sentTexts(sent).at(-1) ?? '';
  const tableRows = ask.split('\n').filter(line => /^\d+\. \[/u.test(line));
  assert.equal(tableRows.length, 1, 'the unquotable row is not tabled');
  assert.ok(tableRows[0]?.startsWith('2. ['), 'the tabled row keeps its own index');
  assert.equal(tableRows[0]?.includes('read bad.txt'), false, 'the dropped row is never shown');
  assert.ok(tableRows[0]?.includes('line 8 ends with ') === true, 'the row carries its quotes');
  assert.deepEqual(outcome.rows.map(row => row.index), [2],
    'only the tabled row answers, and it answers under its own index');
});

test('an invalid batch grammar is a coded refusal, never a throw into the caller (ISSUE-346)',
  async () => {
    // The grammar is config a JS caller can typo. Core's `entryBatchAskMessage`
    // and `parseEntryBatchAnswer` throw RangeError on an unknown name; the batch
    // seam promises nothing throws into the caller, so it must refuse by name
    // before composing or sending anything.
    const quotable = numberedBytes(25, 'GOOD');
    const llm = fakeLlm(answerChunks('{"1":{"keepall":true},"2":{"keepall":true}}'));
    const outcome = await askEntryBatch({ rows: [
      { index: 1, call: 'read a.txt', resultBytes: quotable, resultNodeId: 'n1' },
      { index: 2, call: 'read b.txt', resultBytes: quotable, resultNodeId: 'n2' },
    ], seed: SEED, llm, route, grammar: 'bogus' as never });
    assert.equal(outcome.status, 'refused');
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.code, 'unknown-grammar', 'the refusal names the grammar defect');
    assert.match(outcome.message, /bogus/u, 'and names the value the caller passed');
    assert.deepEqual(outcome.turns, []);
    assert.equal(llm.calls.length, 0, 'no request leaves on an invalid grammar');
  });

test('anchors reach the ask: N = 201 places lines 67 and 134, and the count always ships', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: LONG_BYTES, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  const askText = texts[texts.length - 1] ?? '';
  assert.ok(askText.includes('This result has 201 lines, so keeplines ranges sit in [1,201].'));
  assert.ok(askText.includes('line 67 ends with "worker: job 67 finished in 1.8s"'),
    'the quote names its line and drops the total the range sentence already stated');
  assert.ok(askText.includes('line 134 ends with "worker: job 134 finished in 1.8s"'));
  assert.equal(askText.includes(' of 201 ends with'), false, 'no quote restates N');
  assert.deepEqual(entryAskFacts(LONG_BYTES).anchorLines.length, 2);
});

test('a body with no visible line states zero lines and is not tableable', async () => {
  // 201 LF-terminated slots whose bytes are not UTF-8 at all. Nothing decodes as
  // text, so the capture holds no visible line: no count, no quotes, and the row
  // is never tabled (ADR-0042 Decision 7).
  const raw = new Uint8Array(201 * 3);
  for (let line = 0; line < 201; line += 1) {
    raw[line * 3] = 0xff;
    raw[line * 3 + 1] = 0xfe;
    raw[line * 3 + 2] = 0x0a;
  }
  const facts = entryAskFacts(raw);
  assert.equal(facts.lineCount, 0, 'no visible line means no line count');
  assert.deepEqual(facts.anchorLines, [], 'no decode means no anchors, never a fabricated one');
  assert.equal(factsShowTwoQuotes(facts), false, 'and the row cannot show two quotes');
  assert.equal(entryAskTableable(raw), false, 'the row is not tabled and lands untouched');
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: raw, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered', 'an undecodable body is not an ask failure');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  const askText = texts[texts.length - 1] ?? '';
  assert.equal(askText, entryAskMessage({ lineCount: 0, anchorLines: [] }),
    'the ask states the visible count and no anchor line');
  assert.ok(askText.includes('This result has 0 lines,'), 'the visible count is stated');
  assert.equal(/^line \d+( of \d+)? ends with /mu.test(askText), false,
    'and no rendered anchor line ships');
});

test('the host usage chunk is captured on both arms; absent means unknown', async () => {
  const observed = await ask('{"keepall":true}',
    { usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 800 } });
  assert.equal(observed.status, 'answered');
  if (observed.status !== 'answered') return;
  assert.deepEqual(observed.usage, observedUsage,
    'the disjoint buckets are summed by the one shipped arithmetic');
  const silent = await ask('{"keepall":true}');
  assert.equal(silent.status, 'answered');
  if (silent.status !== 'answered') return;
  assert.equal('usage' in silent, false, 'no chunk means no claim: the field is absent, never zero');
  const refusedUsage = await ask('{"keephead":', { usage: { inputTokens: 10, outputTokens: 2 } });
  assert.equal(refusedUsage.status, 'refused');
  if (refusedUsage.status !== 'refused') return;
  assert.deepEqual(refusedUsage.usage,
    { inputTokens: 10, outputTokens: 2, cachedInputTokens: null },
    'a refused answer was still paid for');
});

test('the retry arm reports both sends\' cost, summed by the same arithmetic', async () => {
  const llm = fakeLlm(
    answerChunks('{"keeplines":[[1,999],"past the end"]}',
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 }),
    answerChunks('{"keepall":true}', { inputTokens: 200, outputTokens: 20, cacheReadTokens: 60 }),
  );
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  if (outcome.status !== 'answered') return;
  assert.deepEqual(outcome.usage,
    { inputTokens: 400, outputTokens: 30, cachedInputTokens: 100 },
    // Each send folds its cache buckets into the prompt count ((100+40)+(200+60)),
    // so the sum is the same arithmetic applied once per send.
    'one correction turn costs two sends, and the reading says so');
  // A send the host said nothing about contributes nothing: the reading is the
  // one send that did report, never a zero invented for the silent one.
  const silentFirst = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm(answerChunks('{"keeplines":[[1,999],"past the end"]}'),
      answerChunks('{"keepall":true}', { inputTokens: 200, outputTokens: 20,
        cacheReadTokens: 60 })) });
  assert.deepEqual(silentFirst.status === 'answered' ? silentFirst.usage : null,
    { inputTokens: 260, outputTokens: 20, cachedInputTokens: 60 },
    'the silent send adds no claim of its own');
});

test('a parse refusal that is not arithmetic fails open at once, with no retry', async () => {
  const llm = fakeLlm(answerChunks('{"keephead":0}'));
  const zero = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  // ISSUE-058 P2: `keephead` is no longer an action, so it refuses as unknown.
  assert.equal(zero.status === 'refused' ? zero.code : zero.status, 'unknown-action');
  assert.equal(zero.status === 'refused' ? zero.retried : null, false);
  assert.equal(llm.calls.length, 1, 'an unreadable answer never earns a correction turn');
  const judgeLane = await ask('{"keeplines":[[1,2],"x"],"keephead":3}');
  assert.equal(judgeLane.status === 'refused' ? judgeLane.code : judgeLane.status, 'mixed-keys');
  const malformed = await ask('{"keephead":');
  assert.equal(malformed.status === 'refused' ? malformed.code : malformed.status, 'malformed-json');
});

test('an arithmetically unusable answer earns exactly one correction turn', async () => {
  const llm = fakeLlm(
    answerChunks('{"keeplines":[[1,999],"a range past the end"]}'),
    answerChunks('{"keepall":true}'),
  );
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  assert.equal(llm.calls.length, 2, 'exactly one retry, never a loop');
  assert.equal(outcome.status, 'answered');
  if (outcome.status !== 'answered') return;
  assert.equal(outcome.retried, true, 'the answer came from the correction turn');
  assert.equal(outcome.raw, '{"keepall":true}');
  assert.deepEqual(outcome.turns.map(turn => turn.role),
    ['user', 'assistant', 'user', 'assistant'],
    'the exchange is ask, first answer, correction ask, final answer');
  const retry = outcome.turns[2]?.text ?? '';
  // The correction turn restates the SAME N and anchor bytes as the first ask.
  const facts = entryAskFacts(RESULT_BYTES);
  assert.equal(retry, entryRetryAskMessage(facts, 'spans-outside-result'));
  // Byte-level drift pin: the facts block the correction carries is exactly the
  // block the first ask carried, because both render it through the core's one
  // `entryAskFactsBlock`.
  const firstAsk = outcome.turns[0]?.text ?? '';
  const factsBlock = entryAskFactsBlock(facts);
  assert.ok(firstAsk.includes(`\n\n${factsBlock}\n\n`), 'the first ask carries this block');
  assert.ok(retry.includes(`\n${factsBlock}\n`), 'and the correction carries the same bytes');
  assert.ok(retry.includes('does not put the keep-or-forget question again'));
  assert.ok(retry.endsWith(ENTRY_ASK_CLOSING_LINE), 'the rig\'s end anchor still names this lane');
  // The second send's wire is the first exchange grown by the answer and retry.
  const second = llm.calls[1];
  assert.ok(second !== undefined);
  const texts = sentTexts(second);
  assert.equal(texts.length, 6, 'main\'s two turns + result + ask + answer + correction');
  assert.equal(texts[4], '{"keeplines":[[1,999],"a range past the end"]}',
    'the first answer rides the prefix, verbatim, as the assistant turn');
  assert.equal(texts[5], retry);
});

test('the correction turn restates the anchor lines byte for byte at N = 201', async () => {
  const llm = fakeLlm(
    answerChunks('{"keeplines":[[1,999],"past the end"]}'),
    answerChunks('{"keepall":true}'),
  );
  const outcome = await askEntry({ resultBytes: LONG_BYTES, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  if (outcome.status !== 'answered') return;
  const facts = entryAskFacts(LONG_BYTES);
  assert.deepEqual(facts.anchorLines, [
    'line 67 ends with "worker: job 67 finished in 1.8s"',
    'line 134 ends with "worker: job 134 finished in 1.8s"',
  ]);
  const retry = outcome.turns[2]?.text ?? '';
  assert.equal(retry, entryRetryAskMessage(facts, 'spans-outside-result'),
    'the correction is the shipped composition over the same facts');
  for (const anchor of facts.anchorLines) {
    assert.ok(retry.includes(anchor), `"${anchor}" restated verbatim`);
  }
});

test('a second unusable answer fails open after exactly two sends', async () => {
  const llm = fakeLlm(
    answerChunks('{"keeplines":[[1,999],"first"]}'),
    answerChunks('{"keeplines":[[1,999],"second"]}'),
    answerChunks('{"keepall":true}'),
  );
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  assert.equal(llm.calls.length, 2, 'the retry\'s answer is validated once; no third send');
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.code, 'spans-outside-result');
  assert.equal(outcome.retried, true);
  assert.equal(outcome.raw, '{"keeplines":[[1,999],"second"]}');
  assert.match(outcome.message, /3 lines/u, 'the refusal states the real line count');
});

test('an invalid span and a keeps-every-line answer both take the one retry', async () => {
  const invalidSpan = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm(answerChunks('{"keeplines":[[3,1],"reversed"]}'),
      answerChunks('{"forgetall":"recovered"}')) });
  assert.equal(invalidSpan.status === 'answered' ? invalidSpan.retried : null, true);
  const everyLine = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm(answerChunks('{"keeplines":[[1,3],"nothing dropped"]}'),
      answerChunks('{"keepall":true}')) });
  assert.equal(everyLine.status === 'answered' ? everyLine.retried : null, true);
  // A second bad span is the parser's own code, reported as data after one retry.
  const twice = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm(answerChunks('{"keeplines":[[3,1],"reversed"]}'),
      answerChunks('{"keeplines":[[2,1],"still reversed"]}')) });
  assert.equal(twice.status === 'refused' ? twice.code : twice.status, 'invalid-span');
  assert.equal(twice.status === 'refused' ? twice.retried : null, true);
  assert.equal(twice.status === 'refused' ? twice.raw : null,
    '{"keeplines":[[2,1],"still reversed"]}',
    'the refusal carries the reply it read, not the retried-away one');
});

test('no seed is no-seed, and nothing is sent', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: null, llm, route });
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.code, 'no-seed');
  assert.deepEqual(outcome.turns, []);
  assert.equal(llm.calls.length, 0, 'a fork cannot exist without main\'s sent bytes');
});

test('a surface that already ends with the landed result turn is not duplicated', async () => {
  // The mount's surface is identity-cut at this result's own node, so it already
  // carries the result turn. Appending again would put the body on the wire
  // twice, so the fork reuses the existing turn. A CAPTURE cannot do this: it has
  // no node id, so a trailing tool turn is a prior result and is refused (the
  // identical-prior case below, ISSUE-348).
  const landedSurface: WireRequest = { ...SEED,
    messages: [...SEED.messages, { role: 'tool', text: RESULT_TEXT }] };
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, surface: landedSurface, llm, route });
  assert.equal(outcome.status, 'answered');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  assert.equal(texts.filter(text => text === RESULT_TEXT).length, 1,
    'the landed body appears exactly once on the prefix');
  assert.equal(texts.length, SEED.messages.length + 2, 'seed turns, the result turn, the ask');
  assert.equal(texts[texts.length - 1], entryAskMessage(entryAskFacts(RESULT_BYTES)));
});

test('a capture ending in a PRIOR tool turn fails open by name, not by accident', async () => {
  // The live blocker P3c-2 recorded (fixed in P3d as a named refusal, not as a
  // silent generic conflict). After a session's first tool call, the request the
  // loop dispatches next ends with that PRIOR result: the assistant turn that
  // made THIS call is a response no request capture holds. Appending this result
  // would be two `tool` turns in a row, so the module refuses and names why.
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, llm, route,
    seed: { ...SEED, messages: [...SEED.messages, { role: 'tool', text: 'prior result' }] } });
  assert.equal(outcome.status === 'refused' ? outcome.code : outcome.status, 'no-seed');
  if (outcome.status !== 'refused') return;
  assert.match(outcome.message, /ends with a prior tool result/u,
    'the refusal names the real cause, never a bare role conflict');
  assert.match(outcome.message, /surface seed is needed/u,
    'and names what would fix it');
  assert.equal(outcome.turns.length, 0, 'nothing reached a fork');
  assert.equal(llm.calls.length, 0, 'no request leaves');
});

test('a capture ending in an IDENTICAL prior result is no-seed, never a text dedupe (ISSUE-348)',
  async () => {
    // Two identical tool results with a capture between them: the capture's last
    // turn is the PRIOR result, whose bytes equal this result's. The old text
    // dedupe (`last.text === bodyText`) misrecognized it as already landed and
    // returned a prefix one assistant+tool turn short — the ask sat above the
    // prior result and lost its cache hit. A capture carries no node id, so
    // identity cannot be checked here: the honest refusal is no-seed, and the
    // mount's identity-cut surface is what recognizes the landed turn.
    const llm = fakeLlm(answerChunks('{"keepall":true}'));
    const outcome = await askEntry({ resultBytes: RESULT_BYTES, llm, route,
      seed: { ...SEED, messages: [...SEED.messages, { role: 'tool', text: RESULT_TEXT }] } });
    assert.equal(outcome.status === 'refused' ? outcome.code : outcome.status, 'no-seed',
      'an identical prior result is not this result; the capture cannot prove identity');
    if (outcome.status !== 'refused') return;
    assert.match(outcome.message, /ends with a prior tool result/u);
    assert.match(outcome.message, /surface seed is needed/u);
    assert.deepEqual(outcome.turns, [], 'nothing reached a fork');
    assert.equal(llm.calls.length, 0, 'no request leaves above a misrecognized prior result');
  });

test('a mount surface seed wins: it holds the assistant tool-call turn a capture cannot', async () => {
  // The exact live shape P3c-2 observed: main's wire after a second tool call.
  // The capture (SEED) ends at the FIRST assistant turn; the surface carries the
  // first result, the second assistant turn and this result. Seeding from the
  // surface is what makes this ask possible at all.
  const priorResult = 'the first result body\n';
  const surface: WireRequest = { ...SEED, messages: [
    { role: 'user', text: 'read big.txt' },
    { role: 'assistant', text: '[tool call read {"path":"big.txt"}]' },
    { role: 'tool', text: priorResult },
    { role: 'assistant', text: '[tool call read {"path":"second.txt"}]' },
    { role: 'tool', text: RESULT_TEXT },
  ] };
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, surface, llm, route });
  assert.equal(outcome.status, 'answered');
  assert.equal(llm.calls.length, 1, 'one ask, never a retry for a good answer');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  assert.deepEqual(texts.slice(0, 5),
    ['read big.txt', '[tool call read {"path":"big.txt"}]', priorResult,
      '[tool call read {"path":"second.txt"}]', RESULT_TEXT],
    'the fork prefix is the surface verbatim: both results and both call turns');
  assert.equal(texts[texts.length - 1], entryAskMessage(entryAskFacts(RESULT_BYTES)),
    'and the ask is the only turn appended');
  assert.equal(texts.filter(text => text === RESULT_TEXT).length, 1,
    'this result is not duplicated: the surface already ends with it');
  assert.equal(sent['system'], SEED.system, 'main\'s system bytes are untouched');
  assert.deepEqual(sent['tools'], SEED.tools, 'and so is main\'s tool list');
});

test('two identical results with a capture between: the surface keeps the full prefix (ISSUE-348)',
  async () => {
    // The DoD's full-prefix, cache-valid case. The mount's surface is identity-cut
    // at THIS result's node, so it carries the prior identical result, the
    // assistant turn that called this one, and this result — all verbatim. The
    // old text dedupe would have collapsed the two identical bodies and dropped
    // the last assistant+tool pair; the surface keeps the full prefix, so the ask
    // sits above the right turn and the cache hit survives.
    const surface: WireRequest = { ...SEED, messages: [
      { role: 'user', text: 'read a.txt' },
      { role: 'assistant', text: '[tool call read {"path":"a.txt"}]' },
      { role: 'tool', text: RESULT_TEXT },        // prior result, identical bytes
      { role: 'assistant', text: '[tool call read {"path":"b.txt"}]' },
      { role: 'tool', text: RESULT_TEXT },        // THIS result, identical bytes
    ] };
    const llm = fakeLlm(answerChunks('{"keepall":true}'));
    const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, surface, llm, route });
    assert.equal(outcome.status, 'answered');
    assert.equal(llm.calls.length, 1, 'one ask, never a retry for a good answer');
    const sent = llm.calls[0];
    assert.ok(sent !== undefined);
    const texts = sentTexts(sent);
    assert.deepEqual(texts.slice(0, 5),
      ['read a.txt', '[tool call read {"path":"a.txt"}]', RESULT_TEXT,
        '[tool call read {"path":"b.txt"}]', RESULT_TEXT],
      'the full prefix: both identical results and both assistant call turns');
    assert.equal(texts.length, 6, 'five surface turns plus the one ask, none dropped');
    assert.equal(texts[texts.length - 1], entryAskMessage(entryAskFacts(RESULT_BYTES)),
      'the ask is the only turn appended, above this result');
    assert.equal(texts.filter(text => text === RESULT_TEXT).length, 2,
      'both identical results survive; text dedupe must not collapse them');
  });

test('a surface that does not end with this result is refused, never asked above the wrong turn', async () => {
  // The ask is about the turn immediately above it (ADR-0022 §4), so a surface
  // ending anywhere else would be a question about other content.
  const wrong: WireRequest = { ...SEED, messages: [
    ...SEED.messages, { role: 'tool', text: 'some other result' },
  ] };
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, surface: wrong, llm, route });
  assert.equal(outcome.status === 'refused' ? outcome.code : outcome.status, 'no-seed');
  if (outcome.status === 'refused') {
    assert.match(outcome.message, /does not end with this result/u);
  }
  assert.equal(llm.calls.length, 0, 'nothing is sent above the wrong content');
  // A surface ending in a user/assistant turn is refused the same way.
  const notTool: WireRequest = { ...SEED, messages: [
    ...SEED.messages, { role: 'assistant', text: 'thinking aloud' },
  ] };
  const second = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, surface: notTool,
    llm: fakeLlm(answerChunks('{"keepall":true}')), route });
  assert.equal(second.status === 'refused' ? second.code : second.status, 'no-seed');
});

test('a surface seed needs no capture at all', async () => {
  // The surface is the whole wire state; the capture is not consulted.
  const surface: WireRequest = { ...SEED, messages: [
    ...SEED.messages, { role: 'tool', text: RESULT_TEXT },
  ] };
  const llm = fakeLlm(answerChunks('{"forgetall":"an old build log"}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: null, surface, llm, route });
  assert.equal(outcome.status, 'answered');
  assert.equal(llm.calls.length, 1);
  assert.equal(outcome.status === 'answered' ? outcome.answer.action : null, 'forgetall');
});

test('no route is off: the feature is not armed, and nothing is sent', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route: null });
  assert.deepEqual(outcome, { status: 'off' });
  assert.equal(llm.calls.length, 0);
});

/** One stream that never produces a chunk, so only a deadline or an abort ends it. */
function stalled(): AsyncIterable<DshLlmChunk> {
  return (async function* stall(): AsyncGenerator<DshLlmChunk> {
    await new Promise(() => {});
    yield { type: 'finish', reason: 'stop' };
  })();
}

test('a stalled stream times out, and an outer abort stays an abort', async () => {
  const started = Date.now();
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm: fakeLlm(stalled),
    route, timeoutMs: 25 });
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.code, 'timeout');
  assert.equal(outcome.reason, 'timeout');
  assert.ok(Date.now() - started < 2000);

  // The same stall, ended by the caller's own signal: an abort, never a timeout —
  // even when that signal's reason is itself named `TimeoutError`.
  const live = new AbortController();
  const pending = askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm: fakeLlm(stalled),
    route, timeoutMs: 10_000, signal: live.signal });
  live.abort(new DOMException('the caller gave up', 'TimeoutError'));
  const aborted = await pending;
  assert.equal(aborted.status, 'refused');
  if (aborted.status !== 'refused') return;
  assert.equal(aborted.reason, 'aborted');
  assert.equal(aborted.code, 'stream-error');

  // A signal already aborted before the ask is read the same way.
  const spent = new AbortController();
  spent.abort();
  const already = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm: fakeLlm(stalled),
    route, timeoutMs: 10_000, signal: spent.signal });
  assert.equal(already.status === 'refused' ? already.reason : already.status, 'aborted');
});

test('a thrown stream, an empty reply and a truncated reply are stream refusals', async () => {
  const thrown = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm(async function* boom(): AsyncGenerator<DshLlmChunk> {
      throw new Error('socket reset');
      yield { type: 'finish', reason: 'stop' };
    }) });
  assert.equal(thrown.status === 'refused' ? thrown.code : thrown.status, 'stream-error');
  if (thrown.status === 'refused') assert.match(thrown.message, /socket reset/u);

  const empty = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm([{ type: 'finish', reason: 'stop' }]) });
  assert.equal(empty.status === 'refused' ? empty.code : empty.status, 'empty-text',
    'an empty reply is the parser\'s own code for it');

  const capped = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, route,
    llm: fakeLlm([
      { type: 'text-delta', index: 0, text: '{"keepall":' },
      { type: 'finish', reason: 'max-tokens' },
    ]) });
  assert.equal(capped.status === 'refused' ? capped.code : capped.status, 'stream-error');
  if (capped.status === 'refused') assert.equal(capped.reason, 'stream-truncated');
});

test('the three entry-ask kinds are in the closed journal vocabulary', () => {
  // The mount's journal takes `RacoonsJournalKind`, so this assignment is the
  // compile-time pin; the membership check pins the list itself against a typo
  // in the const (the mount emits these lines, never this module). The writer
  // calls below prove the seam accepts a record whose kind is one of the three.
  const kinds: readonly RacoonsJournalKind[] = ['entry-ask', 'entry-ask-refused', 'entry-ask-off'];
  for (const kind of kinds) {
    assert.ok((CREMATOR_JOURNAL_KINDS as readonly string[]).includes(kind),
      `"${kind}" is in the closed list`);
  }
  assert.equal(new Set(CREMATOR_JOURNAL_KINDS).size, CREMATOR_JOURNAL_KINDS.length,
    'a duplicate would silently shrink the union');
  const written: { kind: RacoonsJournalKind; fields: Record<string, unknown> }[] = [];
  const journal: MountJournal = (kind, fields) => { written.push({ kind, fields }); };
  journal('entry-ask', { sessionId: 's', unitId: 'u-1', answeredInRound: 0,
    action: 'keeplines', raw: '{"keepall":true}', usage: observedUsage, retried: false });
  journal('entry-ask-refused', { sessionId: 's', unitId: 'u-1', code: 'malformed-json' });
  journal('entry-ask-off', { sessionId: 's', unitId: 'u-1', reason: 'no-llm-service' });
  assert.deepEqual(written.map(entry => entry.kind),
    ['entry-ask', 'entry-ask-refused', 'entry-ask-off']);
  assert.equal(written[0]?.fields['action'], 'keeplines');
  assert.equal(written[0]?.fields['answeredInRound'], 0, 'the entry round is literally 0');
});

test('the correction turn teaches the arm\'s own partial class, never the other lane\'s', async () => {
  // ISSUE-106's lane leak: the retry text used to be lane-blind, so a lane F
  // exchange that went wrong was corrected with a `keeplines` example — the one
  // token that arm must never carry (ADR-0027 §3). An `invalid-span` refusal
  // earns the same single retry on either lane, so one ask proves both arms.
  const llm = fakeLlm(
    answerChunks('{"forgetlines":[[3,1],"reversed"]}'),
    answerChunks('{"keepall":true}'),
  );
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route,
    variant: 'forgetlines' });
  assert.equal(outcome.status, 'answered');
  if (outcome.status !== 'answered') return;
  const correction = outcome.turns[2]?.text ?? '';
  assert.equal(correction.includes('{"forgetlines":[[1,5],[9,12],"stale build log lines"]}'), true,
    'the correction teaches lane F\'s class with a real answer');
  assert.equal(correction.includes('keeplines'), false, 'lane K\'s class never leaks into lane F');
  assert.equal(correction.includes('never both'), true, 'the summary placement rule is restated');
  assert.equal(correction, entryRetryAskMessage(entryAskFacts(RESULT_BYTES),
    'invalid-span', 'forgetlines'), 'the composition is the shipped function with the variant');
  // The unset and 'default' paths keep the keeplines example byte for byte.
  const defaultCorrection = entryRetryAskMessage(entryAskFacts(RESULT_BYTES), 'invalid-span');
  assert.equal(defaultCorrection.includes('{"keeplines":[[1,5],[9,12],"stale build log lines"]}'),
    true);
  assert.equal(defaultCorrection, entryRetryAskMessage(entryAskFacts(RESULT_BYTES),
    'invalid-span', 'default'));
});

// --- the prompt-variant seam (ISSUE-061 T-8; ADR-0027 §4) -------------------

test('the default path is byte-identical: no variant sends the pinned shipped ask', async () => {
  // The whole point of the seam is that saying nothing changes nothing. The pin
  // is a sha256 of the composed ask at N = 3 with no anchors, written out here
  // so an edit to the shipped contract reddens this test even if some other
  // assertion moves with it.
  const shipped = entryAskMessage({ lineCount: 3, anchorLines: [] });
  assert.equal(sha256Sync(toBytes(shipped)),
    '0abb8f67feb2eb8a0fae188e48cc455297b17429ebfda1287a615360e97a3411',
    'the shipped ask\'s bytes moved; that is a shipped-contract change, not this seam');
  assert.equal(entryAskMessage({ lineCount: 3, anchorLines: [], variant: 'default' }), shipped,
    "'default' and no variant are the same bytes, never two spellings of one contract");
  assert.equal(shipped.includes(ENTRY_ASK_SYSTEM_PROMPT), true);
  assert.equal(shipped.includes('forgetlines'), false, 'lane F\'s class never leaks into the default');

  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route });
  assert.equal(outcome.status, 'answered');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const texts = sentTexts(sent);
  assert.equal(texts[texts.length - 1], entryAskMessage(entryAskFacts(RESULT_BYTES)),
    'the unset path sends exactly the shipped ask over this result\'s facts');
});

test('an explicit forgetlines variant reaches the ask turn', async () => {
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route,
    variant: 'forgetlines' });
  assert.equal(outcome.status, 'answered');
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  const askText = sentTexts(sent).at(-1) ?? '';
  assert.equal(askText, entryAskMessage({ ...entryAskFacts(RESULT_BYTES),
    variant: 'forgetlines' }),
    'the ask turn is the F contract composed with the same facts block');
  assert.equal(askText.includes('{"forgetlines":'), true,
    'lane F\'s contract is the one that rides the wire');
  assert.equal(askText.includes('keeplines'), false, 'no mixed arm (ADR-0027 §3)');
  // The two arms differ only where they name their class: the two worked
  // forms, the policy line, and the per-result range sentence. Everything else
  // — the aggressive-prune line and the closing line included — is shared
  // bytes.
  const shipped = entryAskMessage(entryAskFacts(RESULT_BYTES));
  const variantLines = askText.split('\n');
  const shippedLines = shipped.split('\n');
  assert.equal(variantLines.length, shippedLines.length, 'same line count as the default');
  const changed = shippedLines
    .map((line, index) => (line === variantLines[index] ? null : index))
    .filter((index): index is number => index !== null);
  assert.equal(changed.length, 4, `expected four changed lines, got ${String(changed.length)}`);
  for (const index of changed) {
    assert.equal(variantLines[index]?.includes('forgetlines'), true, `line ${String(index)} names the class`);
    assert.equal(shippedLines[index]?.includes('keeplines'), true, `line ${String(index)} named the other class`);
  }
  assert.ok(askText.endsWith(ENTRY_ASK_CLOSING_LINE), 'the same closing line and end anchor');
});

test('an unknown variant is refused by name, and nothing is sent', async () => {
  // Typed callers cannot name a third variant; a rig's JSON config and a JS
  // bench can, and they are why the check is at runtime as well.
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const outcome = await askEntry({ resultBytes: RESULT_BYTES, seed: SEED, llm, route,
    variant: 'keeplines' as unknown as EntryAskVariant });
  assert.equal(outcome.status === 'refused' ? outcome.code : outcome.status, 'unknown-variant');
  if (outcome.status !== 'refused') return;
  assert.match(outcome.message, /"keeplines"/u, 'the refusal names the value it was handed');
  assert.match(outcome.message, /default, forgetlines/u, 'and the two it accepts');
  assert.equal(outcome.turns.length, 0);
  assert.equal(llm.calls.length, 0, 'a typo\'d arm never silently runs lane K');
});

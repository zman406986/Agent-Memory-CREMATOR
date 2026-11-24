#!/usr/bin/env node
/**
 * The simulated `edit` is byte-exact, and the fidelity gate can see it.
 *
 * The defect (ISSUE-173 A): `bench-run.mjs` applied each scripted edit with
 * `String.prototype.replace(old, new)` — a STRING replacement, which expands
 * `$$`, `$&`, `` $` ``, `$'` and `$n` inside a recorded `new_string` instead of
 * inserting them. `expectedToolFailures` then predicted a file the host never
 * wrote, and the predicted failure multiset diverged from the observed one at
 * the fidelity gate: a green paid run reddens spuriously, or a genuinely
 * divergent one is masked when the two corruptions cancel.
 *
 * These checks pin three things and nothing else:
 *
 *   (a) every replacement pattern a model can emit lands verbatim, while a
 *       plain `$1`/`$HOME` is untouched — the rule pinned from both sides;
 *   (b) the literal splice agrees with `replace(find, () => text)` on the same
 *       inputs, so the two safe spellings cannot drift apart;
 *   (c) the failure codes the simulation derives are unchanged by the fix:
 *       `FS_NOT_FOUND` for an absent target, `FS_EDIT_NOT_FOUND` for a foreign
 *       `old_string`, a first-occurrence-only replacement, and a corrupted write
 *       that changes the NEXT edit's answer (the reason one bad byte is not one
 *       bad prediction).
 *
 * The red half is the last block: it runs the OLD spelling on the same inputs
 * and asserts the two disagree, so a tree that quietly reverted the fix fails
 * here instead of in a paid run. No dsh, no provider, no network, no temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyScriptedEdit, spliceFirstOccurrence } from './edit-replay.mjs';

const BENCH_SOURCE = readFileSync(fileURLToPath(new URL('./bench-run.mjs', import.meta.url)), 'utf8');

/** The old, unsafe spelling, kept here so the red case can be reproduced. */
const oldStringReplace = (text, find, replacement) => text.replace(find, replacement);

// ── (a) The replacement patterns land verbatim, and `$1`/`$HOME` do not move ──

test('edit replay (a) a recorded new_string is inserted, not expanded', () => {
  // One line, all six shapes, exactly the way ISSUE-172's row is written.
  const newString = 'a$&b$$c$`d$\'e$1f$HOMEg';
  const text = 'HEAD <slot> TAIL';
  const out = applyScriptedEdit(text, '<slot>', newString);
  assert.equal(out.text, `HEAD ${newString} TAIL`, 'the bytes arrive as recorded');
  assert.ok(out.text.includes('$&') && out.text.includes("$'") && out.text.includes('$$'),
    'a replacement pattern survived');
  // The counter-check: every one of those was changed by the string spelling.
  assert.notEqual(oldStringReplace(text, '<slot>', newString), out.text,
    'the string spelling produced the same bytes; the red half is vacuous');
});

test('edit replay (a) each pattern separately, measured', () => {
  // `$&` is the whole match; `` $` `` and `$'` are the text before/after it;
  // `$$` is one literal `$`; `$1` and `$HOME` are not patterns here at all. The
  // `shipped` column is what the string spelling writes, per case — the defect,
  // stated as a table.
  const cases = [
    { newString: '$&', shipped: '<old>' },
    { newString: '$$', shipped: '$' },
    { newString: '$`', shipped: 'PRE ' },
    { newString: "$'", shipped: ' POST' },
    { newString: '$1', shipped: '$1' },
    { newString: '$HOME', shipped: '$HOME' },
  ];
  for (const { newString, shipped } of cases) {
    assert.equal(oldStringReplace('PRE <old> POST', '<old>', newString), `PRE ${shipped} POST`,
      `the string spelling no longer reproduces for ${newString}`);
    assert.equal(applyScriptedEdit('PRE <old> POST', '<old>', newString).text, `PRE ${newString} POST`,
      `the fix did not insert ${newString} verbatim`);
  }
});

// ── (b) Two safe spellings, one answer ───────────────────────────────────────

test('edit replay (b) the literal splice equals a function replacement', () => {
  const inputs = [
    ['z', 'z', '$&'],
    ['abc', 'abc', '$&'],
    ['aXbXc', 'X', '$`'],
    ['tail marker', 'marker', "$'"],
    ['Ünicode ⇄ text', '⇄', '$$'],
  ];
  for (const [text, find, replacement] of inputs) {
    assert.equal(spliceFirstOccurrence(text, find, replacement),
      text.replace(find, () => replacement),
      `two safe spellings disagree on ${JSON.stringify([text, find, replacement])}`);
    assert.equal(spliceFirstOccurrence(text, find, replacement), applyScriptedEdit(text, find, replacement).text,
      'applyScriptedEdit is not the splice');
  }
  // A find that is absent is a no-op for both safe spellings; the launcher's
  // `FS_EDIT_NOT_FOUND` arm never reaches them, and test (c) pins that arm.
  for (const [text, find] of [['no match here', 'zzz'], ['abc', 'abcd']]) {
    assert.equal(spliceFirstOccurrence(text, find, 'Y'), text.replace(find, () => 'Y'));
    assert.equal(spliceFirstOccurrence(text, find, 'Y'), text);
  }
});

test('edit replay (b) only the first occurrence moves, and an absent find is a no-op', () => {
  assert.equal(spliceFirstOccurrence('x x x', 'x', 'Y'), 'Y x x');
  assert.equal(spliceFirstOccurrence('abc', 'zzz', 'Y'), 'abc');
  assert.equal(spliceFirstOccurrence('abc', '', 'Y'), 'Yabc', 'an empty find inserts at the front');
});

// ── (c) The failure codes are the ones the launcher already relied on ────────

test('edit replay (c) the codes are unchanged: absent target, foreign old_string, no old_string', () => {
  assert.deepEqual(applyScriptedEdit(null, 'a', 'b'), { code: 'FS_NOT_FOUND' });
  assert.deepEqual(applyScriptedEdit('body', 'foreign prose', 'b'), { code: 'FS_EDIT_NOT_FOUND' });
  assert.deepEqual(applyScriptedEdit('body', null, 'b'), { text: null },
    'no old_string means no simulated write, exactly as before');
  assert.deepEqual(applyScriptedEdit('body', 'od', null), { text: 'by' },
    'a non-string new_string is an empty insertion, exactly as before');
});

test('edit replay (c) one corrupted write changes the next edit\'s answer', () => {
  // The reason this defect is not confined to one result. The first edit writes
  // `$&`; the second looks for the literal `$&` text. Under the string spelling
  // the file holds the MATCH instead, so the second edit is predicted as
  // FS_EDIT_NOT_FOUND and the multiset gains a failure the host never produced.
  const first = applyScriptedEdit('keep SLOT rest', 'SLOT', '$&');
  assert.equal(first.text, 'keep $& rest');
  const second = applyScriptedEdit(first.text, '$&', 'done');
  assert.equal(second.text, 'keep done rest', 'the second edit must find the literal token');
  assert.notEqual(second.code, 'FS_EDIT_NOT_FOUND');

  const corrupted = oldStringReplace('keep SLOT rest', 'SLOT', '$&');
  assert.equal(corrupted, 'keep SLOT rest', 'the string spelling re-inserted the match');
  assert.deepEqual(applyScriptedEdit(corrupted, '$&', 'done'), { code: 'FS_EDIT_NOT_FOUND' },
    'the corrupted file produces the spurious failure the fidelity gate would report');
});

// ── The launcher actually calls the fixed seam ───────────────────────────────

test('edit replay (c) bench-run.mjs applies edits through the seam, not a string replacement', () => {
  assert.match(BENCH_SOURCE, /import \{ applyScriptedEdit \} from '\.\/edit-replay\.mjs';/u,
    'bench-run.mjs no longer imports the byte-exact edit simulation');
  assert.match(BENCH_SOURCE, /const outcome = applyScriptedEdit\(before, oldText, input\.new_string\);/u,
    'bench-run.mjs no longer decides the edit through edit-replay.mjs');
  assert.doesNotMatch(BENCH_SOURCE, /before\.replace\(oldText,/u,
    'the string-replacement spelling is back in bench-run.mjs (ISSUE-173 A)');
});

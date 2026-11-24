#!/usr/bin/env node
/**
 * ISSUE-072's gate for the shared `dev/` argument parser.
 *
 * Run: `node --test dev/lib/args.test.mjs`
 *
 * The defect this closes: a hand-rolled parser decided "the next token is this
 * option's value" with `next.startsWith('--')`, and the copies that did it
 * differently disagreed with it. The load-bearing case is a negative numeric
 * value, `--threshold -0.5`: it must be an ordinary value, not a missing one.
 *
 * `node:util`'s own `parseArgs` refuses that spelling in strict mode
 * (`ERR_PARSE_ARGS_INVALID_OPTION_VALUE`, "argument is ambiguous"), so the
 * first test pins the stdlib behavior the wrapper exists to work around — if a
 * future Node starts accepting it, that test says so and this module can shrink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs as nodeParseArgs } from 'node:util';
import { optionsOf, parseDevArgs } from './args.mjs';

const OPTIONS = optionsOf([
  ['threshold', 'string'],
  ['kill-ms', 'string'],
  ['perturb-trigger', 'string'],
  ['arm', 'string'],
  ['record', 'string', 'record', { multiple: true }],
  ['sibling', 'string'],
  ['no-sibling', 'boolean'],
  ['json', 'boolean'],
  ['dry-work', 'boolean'],
]);

/** A parser that throws, the way most of `dev/` refuses. */
function parse(argv, config = {}) {
  return parseDevArgs(argv, { options: OPTIONS, ...config });
}

/** `{ values }` only, for the assertions that do not care about token order. */
function values(argv, config = {}) {
  return parse(argv, config).values;
}

test('the stdlib still refuses a negative value written with a space', () => {
  assert.throws(
    () => nodeParseArgs({ args: ['--threshold', '-0.5'], options: OPTIONS, strict: true }),
    { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' },
  );
});

test('--threshold -0.5 is an ordinary value', () => {
  assert.deepEqual(values(['--threshold', '-0.5']), { threshold: '-0.5' });
});

test('negative values survive every numeric flag shape', () => {
  // A decimal, a bare integer, a leading-dot decimal, an exponent, and a float
  // that rounds to an integer: the tokens a parser that forks on '--' mangles.
  for (const value of ['-0.5', '-1', '-.5', '-1e3', '-2.0']) {
    assert.deepEqual(values(['--threshold', value]), { threshold: value }, value);
    assert.deepEqual(values(['--threshold', value, '--json']),
      { threshold: value, json: true }, value);
    assert.deepEqual(values(['--json', '--threshold', value]),
      { json: true, threshold: value }, value);
    assert.deepEqual(values([`--threshold=${value}`]), { threshold: value }, value);
  }
});

test('a negative value is folded onto any declared string option, and the launcher judges it', () => {
  // The rule is uniform: a token shaped like a negative number is a value for a
  // string option, whatever the option is named. A parser that forked on the
  // flag's name would accept `--threshold -0.5` and mangle `--arm -1`, which is
  // the drift this module exists to delete. `--arm -1` is therefore delivered,
  // and `lanes.mjs` refuses it by name ("--arm must be traditional or racoons").
  assert.deepEqual(values(['--arm', '-1']), { arm: '-1' });
  // A boolean never takes a value, so nothing is folded onto one and the stray
  // token is refused by the shared scan.
  assert.throws(() => parse(['--json', '-1']), /unknown argument -1/u);
});

test('a missing value is still refused, in the caller\'s word', () => {
  assert.throws(() => parse(['--threshold']), /^Error: --threshold needs a value$/u);
});

test('an option followed by another option is a missing value, not a value', () => {
  assert.throws(() => parse(['--threshold', '--json']), /--threshold needs a value/u);
});

test('an inline value may look like an option, because the caller said so', () => {
  assert.deepEqual(values(['--threshold=--json']), { threshold: '--json' });
});

test('unknown options and stray positionals are refused by the shared scan', () => {
  assert.throws(() => parse(['--nope']), /unknown argument --nope/u);
  assert.throws(() => parse(['--nope', 'x']), /unknown argument --nope/u);
  assert.throws(() => parse(['stray']), /unknown argument stray/u);
});

test('a repeatable option collects every value in order', () => {
  assert.deepEqual(values(['--record', 'a', '--record', 'b']),
    { record: ['a', 'b'] });
});

test('positionals are refused unless the launcher asks for them', () => {
  assert.deepEqual(values(['--json', 'file.json'], { allowPositionals: true }), { json: true });
  assert.deepEqual(parse(['--json', 'file.json'], { allowPositionals: true }).positionals,
    ['file.json']);
});

test('-- is the end of options, and what follows is a positional', () => {
  const parsed = parse(['--', '--threshold', '-0.5'], { allowPositionals: true });
  assert.deepEqual(parsed.values, {});
  assert.deepEqual(parsed.positionals, ['--threshold', '-0.5']);
});

test('the order of the given options is kept, so last-one-wins pairs work', () => {
  // prep.mjs's `--sibling` / `--no-sibling` share one field; the old switch let
  // the later one win, and `order` is what keeps that true.
  assert.deepEqual(parse(['--sibling', 'a', '--no-sibling']).order, ['sibling', 'no-sibling']);
});

test('the refusal text carries the caller\'s usage block', () => {
  assert.throws(() => parse(['--nope'], { usage: () => 'usage: x.mjs --arm <a>' }),
    (error) => error.message === 'unknown argument --nope\nusage: x.mjs --arm <a>');
});

test('the caller\'s own refuse is the one that fires', () => {
  const seen = [];
  const refuse = (message) => { seen.push(message); throw new Error('via refuse'); };
  assert.throws(() => parse(['--nope'], { refuse }), /via refuse/u);
  assert.deepEqual(seen, ['unknown argument --nope']);
});

test('a help flag prints and exits 0 only when the launcher offers help', () => {
  const printed = [];
  const write = process.stdout.write;
  const exit = process.exit;
  process.stdout.write = (chunk) => { printed.push(String(chunk)); return true; };
  process.exit = (code) => { throw Object.assign(new Error('exit'), { code }); };
  try {
    assert.throws(() => parse(['--help'], { help: () => 'usage: x.mjs\n' }),
      (error) => error.code === 0);
    assert.deepEqual(printed, ['usage: x.mjs\n']);
    // No help text declared: the flag is unknown, exactly as before the change.
    assert.throws(() => parse(['--help']), /unknown argument --help/u);
  } finally {
    process.stdout.write = write;
    process.exit = exit;
  }
});

test('a script\'s -h alias reaches the same help', () => {
  const exit = process.exit;
  const write = process.stdout.write;
  process.stdout.write = () => true;
  process.exit = (code) => { throw Object.assign(new Error('exit'), { code }); };
  try {
    assert.throws(() => parse(['-h'], { help: 'usage: x.mjs\n' }), (error) => error.code === 0);
  } finally {
    process.stdout.write = write;
    process.exit = exit;
  }
});

/**
 * The one argument parser for `dev/` launchers (ISSUE-072).
 *
 * It is `node:util`'s `parseArgs` for the token grammar — `--x=y`, `--`, short
 * aliases, typed options — plus the two things the stdlib does not do for these
 * scripts:
 *
 *   1. Bind a negative numeric value to its option. `parseArgs` in strict mode
 *      throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` on `--threshold -0.5`
 *      because a leading dash is indistinguishable from the next option; the
 *      documented workaround is `--threshold=-0.5`, which callers should not
 *      have to know. The value is folded inline before the stdlib sees it.
 *   2. Refuse in each script's own words. The scripts disagree on the text
 *      ("needs a value", "unknown argument", a `usage` suffix, a prefixed
 *      program name) and that text is part of their interface, so the scan is
 *      shared and the wording is passed in by the caller.
 *
 * The token walk is ours rather than `strict: true` for the same reason: the
 * stdlib reports an unknown option and an unexpected positional with its own
 * messages, and these scripts print theirs.
 */

import { parseArgs as nodeParseArgs } from 'node:util';

/** A leading-dash token that is a number, not an option. Handles `-1e3`. */
const NEGATIVE_NUMBER = /^-(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function defaultRefuse(message) {
  throw new Error(message);
}

/** `kill-ms` / `--kill-ms` -> `killMs`; `dry-work` -> `dryWork`. */
function camel(flag) {
  return flag.replace(/^--?/u, '').replace(/-([a-z0-9])/gu, (_, ch) => ch.toUpperCase());
}

/**
 * Rewrites `['--threshold', '-0.5']` to `['--threshold=-0.5']` for declared
 * string options, which is the only form `node:util` accepts without the
 * ambiguous-value refusal. A token that is already inline is left alone, and a
 * value that is not a number is left alone so the missing-value check still
 * sees it.
 * @param {string[]} argv
 * @param {Record<string, {type?: string}>} options
 * @returns {string[]}
 */
function foldNegativeValues(argv, options) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    // After `--` nothing is an option, so nothing is folded onto one either.
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (typeof token === 'string' && token.startsWith('--') && !token.includes('=')
      && next !== undefined && options[token.slice(2)]?.type === 'string'
      && NEGATIVE_NUMBER.test(next)) {
      out.push(`${token}=${next}`);
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * Parses one launcher's `process.argv.slice(2)`.
 *
 * @param {string[]} argv - the raw arguments, never joined.
 * @param {object} config
 * @param {Record<string, object>} [config.options] - a `node:util` `parseArgs`
 *   options map: `{ name: { type: 'string'|'boolean', short?, multiple?,
 *   key? } }`. `key` renames the output field (default: camelCase of `name`).
 * @param {(message: string) => never} [config.refuse] - the script's own
 *   refusal. Defaults to throwing `Error(message)`.
 * @param {() => string} [config.usage] - appended (after a newline) to every
 *   refusal this module raises, matching the scripts that print usage on error.
 * @param {string | (() => string)} [config.help] - when set, `--help` and `-h`
 *   print this to stdout and exit 0.
 * @param {boolean} [config.allowPositionals] - collect the remaining tokens in
 *   `positionals` instead of refusing them. Default false.
 * @param {(rawName: string, rest: string[]) => string | null} [config.unknown] -
 *   consulted for a token that names no declared option. Return a message to
 *   refuse with it (a named refusal for a flag that is deliberately barred),
 *   or `null` to fall through to the generic "unknown argument" text. It may
 *   throw instead, for a refusal that is not a message.
 * @param {string} [config.prefix] - prepended to every refusal THIS module
 *   generates ("bench-run.mjs: unknown argument --x"). The caller's own
 *   refusals are never touched, so a script that already writes its name once
 *   stays exactly as it was.
 * @returns {{ values: Record<string, unknown>, positionals: string[],
 *            order: string[] }} `order` is every option's declared name in the
 *   sequence given, so a pair like `--sibling`/`--no-sibling` can keep its
 *   last-one-wins meaning.
 */
export function parseDevArgs(argv, config = {}) {
  const {
    options = {},
    refuse = defaultRefuse,
    usage = null,
    help = null,
    allowPositionals = false,
    unknown = null,
    prefix = '',
  } = config;
  const stop = (message) => {
    const text = `${prefix}${message}${usage === null ? '' : `\n${usage()}`}`;
    return refuse(text);
  };

  // `--help` / `-h` is declared only when the script has text to print, so a
  // script without help keeps refusing the flag as unknown.
  const declared = help === null
    ? options
    : { ...options, help: { type: 'boolean', short: 'h', key: 'help' } };

  let parsed;
  try {
    parsed = nodeParseArgs({
      args: foldNegativeValues(argv, declared),
      options: declared,
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
  } catch (error) {
    // `strict: false` does not throw on a bad argument, but a bad *options map*
    // still does; surfacing it through the script's refuse keeps one exit path.
    return stop(error?.message ?? String(error));
  }

  const values = {};
  const positionals = [];
  const order = [];
  for (const token of parsed.tokens) {
    if (token.kind === 'option-terminator') continue;
    if (token.kind === 'positional') {
      if (allowPositionals) {
        positionals.push(token.value);
        continue;
      }
      const named = unknown === null ? null : unknown(token.value, argv);
      if (named !== null && named !== undefined) return stop(named);
      return stop(`unknown argument ${token.value}`);
    }
    const rawName = token.rawName ?? `--${token.name}`;
    const spec = declared[token.name];
    if (spec === undefined) {
      const named = unknown === null ? null : unknown(rawName, argv);
      if (named !== null && named !== undefined) return stop(named);
      return stop(`unknown argument ${rawName}`);
    }
    order.push(token.name);
    if (spec.type === 'boolean') {
      if (token.value !== undefined) return stop(`${rawName} takes no value`);
      values[spec.key ?? camel(token.name)] = true;
      continue;
    }
    // The stdlib binds the next token even when it is another option, so the
    // "is this really a value" check lives here rather than in each caller.
    const value = token.value;
    if (value === undefined) return stop(`${rawName} needs a value`);
    if (!token.inlineValue && value.startsWith('--')) {
      return stop(`${rawName} needs a value`);
    }
    const key = spec.key ?? camel(token.name);
    if (spec.multiple) (values[key] ??= []).push(value);
    else values[key] = value;
  }

  if (help !== null && values.help === true) {
    delete values.help;
    process.stdout.write(typeof help === 'function' ? help() : help);
    process.exit(0);
  }
  if (help !== null) delete values.help;
  return { values, positionals, order };
}

/**
 * Builds the option map from a concise alias table, so a launcher reads as one
 * list of `[flag, type, key, extra]` rows rather than a nested object.
 *
 * @param {[string, 'string'|'boolean', (string|object)?, object?][]} table -
 *   `[flag, type]`, or `[flag, type, key]`, or `[flag, type, key, extra]`.
 * @returns {Record<string, object>}
 */
export function optionsOf(table) {
  const out = {};
  for (const [flag, type, key, extra] of table) {
    const name = flag.replace(/^--/u, '');
    const rest = typeof key === 'string' ? { key } : {};
    const tail = typeof key === 'object' && key !== null ? key : extra;
    out[name] = { type, ...rest, ...tail };
  }
  return out;
}

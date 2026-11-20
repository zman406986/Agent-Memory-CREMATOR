/**
 * OpenCode tool id → core evidence kind (ISSUE-044 C2, plan §1, §7).
 *
 * Table-driven, provisional by design: the OpenCode built-in ids are the rows,
 * and a name the table does not list is `other`, never a guess. The core
 * vocabulary is `ToolEvidence['kind']` — `read` | `search` | `glob` | `write` |
 * `other` (`packages/core/src/types/transcript.ts`), the same five values dsh's
 * `classifyDshTool` maps onto.
 *
 * An override table **replaces the defaults wholesale** (plan §7 C2): a caller
 * that supplies a table says what every name means, and a default row it omits
 * is `other` — no silent merge, so a table can never mean two things at once.
 * Keys are matched case-insensitively; a table that names one key twice with
 * two different kinds, or names a kind the core does not have, is refused when
 * the classifier is built rather than at lookup time.
 */

import type { ToolEvidence } from '@cremator/core';

/** The five evidence kinds the core defines. */
export type OpencodeToolClass = ToolEvidence['kind'];

/** Every accepted kind, for runtime validation of a table that may come from JSON. */
export const OPENCODE_TOOL_CLASSES: readonly OpencodeToolClass[] = Object.freeze([
  'read', 'search', 'glob', 'write', 'other',
]);

/** A table of tool id → kind, keyed case-insensitively. */
export type OpencodeToolTable = Readonly<Record<string, OpencodeToolClass>>;

/**
 * The provisional defaults. Rows mapped to `other` are written out rather than
 * left to the fallback, so the table states what each built-in is instead of
 * implying the adapter has not considered it.
 *
 * The kind is not what decides whether a path is recorded. `toolEvidence`
 * records the paths any tool names in its own arguments (`path`, `filePath`,
 * `paths`), whatever its kind; the kind decides what that evidence MEANS. For
 * `read`/`grep`/`glob` the result is the read side of a path fact, and for
 * `write` the call is the one that proves a path changed — the fact the core
 * stale-read rule reads (ADR-0046). Everything else (`bash`, `edit`, `patch`,
 * `list`, `webfetch`, `task`, the todo pair) is `other`: its paths are recorded
 * but prove nothing on their own.
 */
export const DEFAULT_OPENCODE_TOOL_TABLE: OpencodeToolTable = Object.freeze({
  read: 'read',
  grep: 'search',
  glob: 'glob',
  write: 'write',
  list: 'other',
  bash: 'other',
  edit: 'other',
  patch: 'other',
  webfetch: 'other',
  task: 'other',
  todowrite: 'other',
  todoread: 'other',
});

export interface OpencodeClassifierOptions {
  /** Replaces `DEFAULT_OPENCODE_TOOL_TABLE` entirely; it is never merged. */
  readonly table?: OpencodeToolTable;
}

/** A resolved lookup: pure, total, and stable for a given table. */
export type OpencodeToolClassifier = (toolName: string) => OpencodeToolClass;

function kindOf(name: string, kind: unknown): OpencodeToolClass {
  if (typeof kind !== 'string' || !(OPENCODE_TOOL_CLASSES as readonly string[]).includes(kind)) {
    throw new TypeError(
      `classifier table entry "${name}" names "${String(kind)}", which is not one of ${OPENCODE_TOOL_CLASSES.join(', ')}`,
    );
  }
  return kind as OpencodeToolClass;
}

/**
 * Build the lookup once, so a table is validated at construction and a lookup
 * is a map read. A `Map` also makes a tool literally named `constructor` or
 * `toString` fall through to `other` instead of reaching an object prototype.
 */
export function createOpencodeToolClassifier(
  options: OpencodeClassifierOptions = {},
): OpencodeToolClassifier {
  const table = options.table ?? DEFAULT_OPENCODE_TOOL_TABLE;
  const kinds = new Map<string, OpencodeToolClass>();
  for (const [name, raw] of Object.entries(table)) {
    const key = name.toLowerCase();
    if (key.length === 0) throw new TypeError('classifier table entry has an empty tool id');
    const kind = kindOf(name, raw);
    const previous = kinds.get(key);
    if (previous !== undefined && previous !== kind) {
      throw new TypeError(
        `classifier table names "${key}" twice with different kinds: ${previous} and ${kind}`,
      );
    }
    kinds.set(key, kind);
  }
  return (toolName: string): OpencodeToolClass => {
    if (typeof toolName !== 'string') return 'other';
    return kinds.get(toolName.toLowerCase()) ?? 'other';
  };
}

/** One-shot convenience for a caller with a single name to classify. */
export function classifyOpencodeTool(
  toolName: string,
  options: OpencodeClassifierOptions = {},
): OpencodeToolClass {
  return createOpencodeToolClassifier(options)(toolName);
}

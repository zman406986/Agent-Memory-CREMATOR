/**
 * The row-table vocabulary shared by this package's test files.
 *
 * A merged block folds several `test()` bodies that differed only in literals
 * into ONE `test()` looping a ROWS table. Non-vacuity law
 * (`docs/guides/law-verification-non-vacuity.md`) says a failure must still name
 * the case, so every assertion inside a row carries `at('<what>')`, which
 * expands to `row: <name>: <what>`. `runRows` re-labels anything that escapes
 * a row without one, so a thrown helper error names the row too.
 *
 * Kept as a copy on purpose, not by accident — ISSUE-166 chose Option B, so the
 * twin is `packages/adapters/opencode/test/rows.ts` and the two are held in step
 * by hand. The invariant they share is the contract below: the
 * `row: <name>: <what>` label string, and `runRows`'s check that an error already
 * starting with `row: <name>` is not prefixed a second time. Every line from the
 * first `export` down is identical to the twin's; `rows-drift.test.ts` beside this
 * file fails when it is not. A label-format change lands in both copies.
 */

/** Builds an assertion message that names the parameter row it belongs to. */
export type Label = (what: string) => string;

export interface Row {
  readonly name: string;
  run(at: Label): Promise<void> | void;
}

/** Runs every parameter row in order, naming the row on any failure. */
export async function runRows(rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const at: Label = what => `row: ${row.name}: ${what}`;
    try {
      await row.run(at);
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith(`row: ${row.name}`)) {
        error.message = at(error.message);
      }
      throw error;
    }
  }
}

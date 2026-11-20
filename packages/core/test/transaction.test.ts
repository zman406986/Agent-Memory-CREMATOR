import assert from "node:assert/strict";
import { test } from "node:test";
import { runTransaction } from "../src/ledger/transaction.js";
import type { TransactionConnection } from "../src/ledger/transaction.js";
import { LedgerError } from "../src/ledger/types.js";

/**
 * A scripted connection (ISSUE-319). `rollbackFailures` counts how many
 * ROLLBACK calls throw before one succeeds; `rollbackCloses` says whether a
 * throwing ROLLBACK leaves the transaction closed (the "no transaction is
 * active" shape) or open (the transient-refusal shape that poisons the next
 * BEGIN). The expected values come from the script, not from the code under
 * test, so each row can fail.
 */
class FakeConnection implements TransactionConnection {
  #open = false;
  #rollbackFailures: number;
  readonly #rollbackCloses: boolean;
  readonly statements: string[] = [];

  constructor(rollbackFailures: number, rollbackCloses: boolean) {
    this.#rollbackFailures = rollbackFailures;
    this.#rollbackCloses = rollbackCloses;
  }

  get isTransaction(): boolean { return this.#open; }

  exec(sql: string): void {
    this.statements.push(sql);
    if (sql === "BEGIN IMMEDIATE") {
      if (this.#open) throw new Error("cannot start a transaction within a transaction");
      this.#open = true;
      return;
    }
    if (sql === "COMMIT") { this.#open = false; return; }
    if (sql === "ROLLBACK") {
      if (this.#rollbackFailures > 0) {
        this.#rollbackFailures--;
        if (this.#rollbackCloses) this.#open = false;
        throw new Error("injected ROLLBACK failure");
      }
      this.#open = false;
      return;
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

const originalFailure = (): never => { throw new Error("original operation failure"); };
const isOriginalWithCause = (error: unknown): boolean =>
  error instanceof Error && error.message === "original operation failure" &&
  error.cause instanceof Error && error.cause.message === "injected ROLLBACK failure";

test("a throwing ROLLBACK with the transaction still open: original surfaces, next BEGIN is clean", () => {
  const db = new FakeConnection(1, false);
  assert.throws(() => runTransaction(db, originalFailure), isOriginalWithCause,
    "the original error surfaces with the ROLLBACK failure as cause, not the ROLLBACK error itself");
  assert.equal(db.isTransaction, false, "the connection is not left in an open transaction");
  assert.equal(runTransaction(db, () => 42), 42,
    "the next transaction does not fail with 'cannot start a transaction within a transaction'");
});

test("a throwing ROLLBACK with no open transaction: original surfaces, next BEGIN is clean", () => {
  const db = new FakeConnection(1, true);
  assert.throws(() => runTransaction(db, originalFailure), isOriginalWithCause,
    "the original error surfaces even when ROLLBACK reports no active transaction");
  assert.equal(db.isTransaction, false);
  assert.equal(runTransaction(db, () => 42), 42, "the next transaction succeeds");
});

test("ROLLBACK keeps failing with the transaction open: a clear storage error names the reopen", () => {
  const db = new FakeConnection(Number.MAX_SAFE_INTEGER, false);
  assert.throws(() => runTransaction(db, originalFailure), (error: unknown) =>
    error instanceof LedgerError && error.code === "storage" &&
    /reopen/.test(error.message) &&
    error.cause instanceof Error && error.cause.message === "original operation failure",
  "an unusable connection is refused by name with the original error as cause, never a poisoned BEGIN");
});

test("the happy path commits and passes the operation's result through", () => {
  const db = new FakeConnection(0, false);
  assert.equal(runTransaction(db, () => "value"), "value");
  assert.deepEqual(db.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  assert.equal(db.isTransaction, false);
});
import { LedgerError } from "./types.js";

/**
 * The slice of a connection a transaction needs. `DatabaseSync` satisfies it;
 * a scripted fake stands in for the double-throw tests (ISSUE-319).
 */
export interface TransactionConnection {
  exec(sql: string): void;
  readonly isTransaction: boolean;
}

/**
 * BEGIN IMMEDIATE / COMMIT / ROLLBACK around one synchronous operation.
 * A failing ROLLBACK never replaces the operation's error: it rides as cause,
 * and the connection is left closed so the next BEGIN is not poisoned.
 */
export function runTransaction<T>(db: TransactionConnection, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error && error.cause === undefined) error.cause = rollbackError;
      // Still open after a failed ROLLBACK (e.g. a transient refusal): retry
      // once. No new timing value is introduced; this is control flow, not a
      // wait bound.
      if (db.isTransaction) {
        try { db.exec("ROLLBACK"); } catch { /* still open: refuse below */ }
      }
      if (db.isTransaction) {
        // The next BEGIN would fail with "cannot start a transaction within
        // a transaction". Refuse by name instead of poisoning every later
        // operation; the original error rides as cause.
        throw new LedgerError("storage",
          "Trash ledger transaction could not be rolled back; reopen the ledger",
          { cause: error });
      }
    }
    throw error;
  }
}
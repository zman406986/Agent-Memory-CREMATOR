import { LedgerError } from "./types.js";

/**
 * The slice of a connection a transaction needs. `DatabaseSync` satisfies it;
 * a scripted fake stands in for the double-throw tests (ISSUE-319).
 */
export interface TransactionConnection {
  exec(sql: string): void;
  /**
   * `DatabaseSync.prototype.isTransaction`, added in Node 22.16.0 and absent from
   * every 23.x release (ISSUE-621). Optional because the member is missing on a
   * runtime outside the declared floor; read it only through
   * {@link transactionOpen}, never with a bare truthiness test — `undefined` there
   * is "unknown", and reading it as "closed" swallows a still-open transaction
   * and lets the next BEGIN fail as a raw SQLite error.
   */
  readonly isTransaction?: boolean;
}

/**
 * Whether the connection still holds an open transaction, or `undefined` when
 * the runtime does not expose the member at all. `undefined` is never a "no":
 * a caller that cannot read the state treats the connection as unusable.
 */
function transactionOpen(db: TransactionConnection): boolean | undefined {
  const state: unknown = db.isTransaction;
  return typeof state === "boolean" ? state : undefined;
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
      // wait bound. An unreadable state retries too: one more ROLLBACK is the
      // only way to close a connection whose state cannot be observed.
      if (transactionOpen(db) !== false) {
        try { db.exec("ROLLBACK"); } catch { /* still open or still unreadable: refuse below */ }
      }
      if (transactionOpen(db) !== false) {
        // The next BEGIN would fail with "cannot start a transaction within
        // a transaction". Refuse by name instead of poisoning every later
        // operation; the original error rides as cause. On a runtime that
        // cannot report its transaction state (Node < 22.16.0, any 23.x) the
        // state stays unknown here, and unknown refuses the same way (ISSUE-621).
        throw new LedgerError("storage",
          "Trash ledger transaction could not be rolled back; reopen the ledger",
          { cause: error });
      }
    }
    throw error;
  }
}
import type { RecallId } from "../types/identity.js";
import { LedgerError } from "./types.js";

/**
 * The one reader for a recall id a caller states. A receipt prints the
 * canonical `recall:sha256:<hex>` form, but a model sometimes drops `recall:`
 * or both prefixes. Those three spellings name the same archive, so they
 * normalize to the canonical id before any lookup. Everything else — a wrong
 * length, uppercase hex, stray whitespace, another prefix — is refused here
 * with the ledger's own `not-found`, so the tool has one error vocabulary.
 */
const STATED = /^(?:recall:sha256:|sha256:)?([0-9a-f]{64})$/u;

export function normalizeRecallId(input: string): RecallId {
  const hex = STATED.exec(input)?.[1];
  if (hex === undefined) throw new LedgerError("not-found", `Invalid recall id ${input}`);
  return `recall:sha256:${hex}`;
}

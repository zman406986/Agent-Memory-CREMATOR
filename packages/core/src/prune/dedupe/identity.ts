import type { TranscriptNode } from "../../types/transcript.js";

/**
 * Object identity for the superseded-read dedupe pass (ADR-0037 decision 2).
 *
 * Every key here is read from node metadata. Nothing is inferred from bytes, and
 * no role, wording or shape test decides provenance: a node that declares no
 * metadata is invisible to the pass, and absence is never a guess. Phase 1 owns
 * class 2's key only; classes 1 and 3 add theirs when their probes close
 * (`docs/plans/2026-11-01-superseded-read-dedupe/plan.md` §3).
 */

/**
 * Class 2's identity: the read's own target key — the path the call named — from
 * `node.evidence.target.key`. A node that is not a read, or names no target,
 * has no identity and is never grouped. Two reads with the same key address the
 * same object; two reads with different keys never do, even when their output
 * happens to print the same text.
 */
export function readPathKey(node: TranscriptNode): string | null {
  if (node.kind !== "tool-result" || node.evidence.kind !== "read") return null;
  const target = node.evidence.target;
  if (target === null) return null;
  return target.key.length === 0 ? null : target.key;
}

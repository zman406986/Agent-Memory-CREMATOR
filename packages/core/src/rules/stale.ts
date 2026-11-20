import { hitSpellings } from "../units/invalidation.js";
import { writePathSpellings } from "../units/writes.js";
import { planProofs } from "./proofs.js";
import type { ProofSubject } from "./proofs.js";
import type { Rule, RuleContext, RulePlan } from "./types.js";

/**
 * The stale-read proof rule (PRD §6.6; ADR-0018; ISSUE-045 chunk C3).
 *
 * A read is burnt when a later call wrote one of the paths that read observed:
 * the file changed after the read, so the bytes in the transcript are provably
 * not what the file holds now. The clock is transcript order, never a wall
 * clock — a write *before* the read is already reflected in the read's bytes and
 * proves nothing.
 *
 * Only a call whose evidence kind is `write` counts. A write is the one kind
 * that proves a path changed (E0); an unclassified call stays `other` with no
 * hit/miss claim, and its unknown outcome is evidence of nothing. The write's
 * own path outcome is never consulted: a write is neither a hit nor a miss, so
 * the kind and the path identity are the whole fact.
 *
 * Path identity is the invalidation lane's own reading (ISSUE-339): the read
 * side is its HIT spellings only (`hitSpellings` — a miss returned an error,
 * not the file's bytes), the write side is every spelling it carries
 * (`writePathSpellings` — key, display form, declared target), and the two
 * match by spelling intersection. One shared reading, so a write the writes
 * lane recognizes is a write this rule recognizes.
 *
 * The guard re-derives this same comparison from the snapshot
 * (`guard/checks-proofs.ts`), so a claim beyond the bytes is refused there.
 */
export class StaleReadRule implements Rule {
  readonly id = "stale-read" as const;

  plan(context: RuleContext): RulePlan | null {
    return planProofs(context, this.id, subject => writtenAfter(context, subject));
  }
}

/** True when a later write names one of the paths this read observed. */
function writtenAfter(context: RuleContext, subject: ProofSubject): boolean {
  // Only a hit read holds a copy of the file's bytes (ISSUE-339): the same
  // hit-only spelling set the invalidation lane reads.
  const read = new Set(hitSpellings(subject.node));
  if (read.size === 0) return false;
  const nodes = context.snapshot.nodes;
  for (let at = subject.index + 1; at < nodes.length; at += 1) {
    const later = nodes[at];
    if (later === undefined || later.kind !== "tool-result") continue;
    // writePathSpellings yields nothing for a non-write or a failed write
    // (ISSUE-328): a failed write changed nothing, so it is no proof of a change.
    for (const key of writePathSpellings(later)) if (read.has(key)) return true;
  }
  return false;
}

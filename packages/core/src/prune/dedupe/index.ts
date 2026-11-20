import type { NodeId, UnitId } from "../../types/identity.js";
import type { ProcessingUnit } from "../../units/types.js";
import { planCallEcho } from "./call-echo.js";
import { planSupersededByReread } from "./superseded-by-reread.js";
import { DEDUPE_CLASSES } from "./types.js";
import type {
  DedupeClass, DedupeInput, DedupePlan, DedupeRefusal, DedupeRemoval,
} from "./types.js";

export type {
  CallEchoFact, DedupeClass, DedupeClasses, DedupeFact, DedupeInput, DedupePlan,
  DedupeProof, DedupeRefusal, DedupeRefusalReason, DedupeRemoval,
  SupersededByRereadFact,
} from "./types.js";
export { DEDUPE_CLASSES } from "./types.js";
export { readPathKey } from "./identity.js";

/**
 * The dedupe planner: class 2 and class 1's exact-echo subset (ADR-0037;
 * ISSUE-145; ISSUE-151).
 *
 * Pure: L1's kept units plus every transcript node in, one plan of
 * `{ unitId, rule, proof }` removals plus per-class counts and class-1 refusals
 * out, nothing mutated. The same snapshot plus the same declarations plus the
 * same switches yield a deep-equal plan.
 *
 * The pass is a no-op unless its class's switch is on. Every switch is absent or
 * false in the shipped configuration, so an existing mount plans exactly what it
 * planned before this module existed.
 *
 * One unit never carries two removals: the classes run one after another over
 * the same unit list, and the claimed set drops any later claim on a unit an
 * earlier class already proved. Within one class the planner itself plans each
 * unit once.
 *
 * `removedNodeIds` is the caller's L1 pass (ISSUE-174): a node the same
 * application deletes is never a witness. The dedupe sees L1's kept units as its
 * subjects already; this makes its witness set agree with that subject set.
 */
export function planDedupe(input: DedupeInput): DedupePlan {
  const units: ProcessingUnit[] = [];
  const seen = new Set<UnitId>();
  for (const unit of input.units) {
    // A repeated id names the same unit; the first occurrence is its position.
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    units.push(unit);
  }

  const claimed = new Set<UnitId>();
  const removals: DedupeRemoval[] = [];
  const refusals: DedupeRefusal[] = [];
  const claim = (planned: readonly DedupeRemoval[]): void => {
    for (const removal of planned) {
      if (claimed.has(removal.unitId)) continue;
      claimed.add(removal.unitId);
      removals.push(removal);
    }
  };
  const removedNodeIds = input.removedNodeIds ?? new Set<NodeId>();

  // Class 2 ships first, then class 1's exact-echo subset. Classes 3 and 4 are
  // declared and unplannable until their own probes close (ADR-0037 decision 6).
  if (input.classes.supersededByReread === true) {
    claim(planSupersededByReread(units, input.nodes, removedNodeIds));
  }
  if (input.classes.callEcho === true) {
    const callEcho = planCallEcho(units, input.nodes, removedNodeIds);
    claim(callEcho.removals);
    refusals.push(...callEcho.refusals);
  }

  const counts: Record<DedupeClass, number> = Object.fromEntries(
    DEDUPE_CLASSES.map(name => [name, 0] as const),
  ) as Record<DedupeClass, number>;
  for (const removal of removals) counts[removal.rule] += 1;
  return { removals, counts, refusals };
}

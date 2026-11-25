/**
 * The two retention rules a dsh removal candidate must clear (ISSUE-519).
 *
 * opencode carries the same pair under the same names (`opencodeRetentionOf`),
 * so the two adapters speak one vocabulary: `recall-answer-retained` for the
 * recall tool's own answer, and `contained-in-live-result` when another live
 * result already carries this text. A unit either rule keeps stays live: no ask
 * describes it, nothing is planned for it, and the caller names the marker in
 * its journal.
 *
 * Both rules answer a FIRST-TIME offer only. They read the live transcript the
 * caller holds at admission; a unit whose bytes are already banked is the
 * caller's business, not this module's.
 */
import type { DshTranscriptItem, DshToolResultItem } from './envelope.js';
import { DSH_RECALL_TOOL_NAME } from './tools.js';

/** The two named refusals (ISSUE-519; opencode's `OpencodeRetentionCode`). */
export type DshRetentionCode = 'recall-answer-retained' | 'contained-in-live-result';

/** One candidate a retention rule keeps, with the fact that kept it. */
export interface DshRetentionVerdict {
  readonly code: DshRetentionCode;
  /** The live result whose exact text contains the candidate; null for a recall answer. */
  readonly containedInNodeId: string | null;
}

/**
 * The exact text of one live result, decoded once per item. The caller passes
 * one transcript array across a whole admission scan, so each result decodes at
 * most once even when many candidates consult it as a container.
 */
const textCache = new WeakMap<DshToolResultItem, string>();

function textOf(item: DshToolResultItem): string {
  const cached = textCache.get(item);
  if (cached !== undefined) return cached;
  const text = new TextDecoder().decode(item.bytes);
  textCache.set(item, text);
  return text;
}

/**
 * Why this node may not be removed, or `null` when it may.
 *
 *   - `recall-answer-retained` — the result the `necromancy` tool produced is the
 *     product's own restore payload, so it is never eligible;
 *   - `contained-in-live-result` — the candidate's exact result text is a proper
 *     substring of another live result's exact text, so removing it frees no
 *     byte the model still holds. Equality is not containment: a byte-identical
 *     duplicate is left to the dedupe's own proof.
 *
 * A node that is not a live tool result is not this rule's subject and clears.
 */
export function dshRetentionOf(
  nodeId: string, live: readonly DshTranscriptItem[],
): DshRetentionVerdict | null {
  const self = live.find((item): item is DshToolResultItem =>
    item.id === nodeId && item.role === 'tool');
  if (self === undefined) return null;
  if (self.toolName === DSH_RECALL_TOOL_NAME) {
    return { code: 'recall-answer-retained', containedInNodeId: null };
  }
  const text = textOf(self);
  if (text.length === 0) return null;
  const container = live.find((item): item is DshToolResultItem =>
    item.role === 'tool' && item.id !== self.id
      && textOf(item).length > text.length && textOf(item).includes(text));
  return container === undefined
    ? null
    : { code: 'contained-in-live-result', containedInNodeId: container.id };
}

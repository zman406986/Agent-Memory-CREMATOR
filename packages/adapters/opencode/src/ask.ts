/**
 * The opencode prune table ask: the same pass mechanism the dsh adapter runs,
 * rendered for this host (ADR-0050; ADR-0053; ADR-0054; ADR-0060).
 *
 * **The pass is core's.** `planPrunePass` runs L1 over the observed array
 * (`stale-exact-reread`, `closed-episode`, `byte-identical-duplicates`), then
 * the superseded-read dedupe over L1's kept units, then numbers every remaining
 * unit above the 512-byte floor as an ask row. The plan's L1 and dedupe removals
 * travel with the batch, so the mount can hand the same document to the engine
 * that dsh's prune pass hands (`planPrunePass` -> `applyPruneAnswers` ->
 * `{kind: 'prune'}`); the opencode lane is no longer a table without a pass.
 *
 * **The prompt is the host-honest two-option one.** The dsh bulk table offers
 * `forgetall` and `keeplines`; a partial `keeplines` needs a host that can
 * re-emit a result's kept lines inside its typed tool-result part. This host
 * cannot: `OpencodeToolResultPart.result` is one tagged value
 * (`host.ts:108-114`) and the wire derivation removes a unit's call and result
 * parts whole (`apply.ts:1505-1513`, `location.kind === 'unit'`). The prompt
 * therefore offers the two verdicts the host CAN apply — `keepall` and
 * `forgetall` — from core's `PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT`, whose own
 * words state "no line-level option". The reader accepts exactly those two
 * actions; `keeplines` and `forgetlines` are `action-not-in-grammar` refusals
 * that keep the unit. ADR-0053 §Amendment 2026-11-19 and ADR-0054 §Amendment
 * 2026-11-19 authorize this named difference.
 *
 * The 70/40 share lines are gone: PRD §6.5 scopes them to the deprecated
 * `3option` entry-ask compatibility path, never the product table.
 *
 * Eligibility is the product's, not a subset:
 *   - a unit is tabled only after an already-sent request carried its node
 *     (`seenNodeIds`, ADR-0054 decision 7);
 *   - a unit this session permanently settled is never tabled again (an
 *     answered `forgetall`, or a refused row whose one re-ask was refused
 *     again); a unit answered `keepall` is released and re-tabled at a later
 *     crossing (ADR-0050 decision 3);
 *   - orphan results (no call part) are skipped, because the derivation refuses
 *     exactly them as `tool-pair-split` (ISSUE-269);
 *   - the three retention rules skip a recall answer, an error/cancelled result,
 *     and a result contained in another live result (ISSUE-259).
 *
 * There is no row cap: every eligible unit rides the one table (ADR-0060
 * §Amendment 2026-11-16).
 *
 * **No session history mutation.** This builder reads the caller's array and
 * returns a plan; it writes nothing into the transcript. `port.observe` records
 * the array it saw, so a caller must not treat the projection as free of side
 * effects.
 */

import {
  DEFAULT_CONFIG, EpisodeTracker, UnitTracker, parsePruneAnswer,
  planPrunePass, PRUNE_ASK_FINAL_LINE, PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT,
  renderPruneAskTable, TWO_VERDICT_GATE_CODE,
} from '@cremator/core';
import type {
  DedupeClasses, Episode, NodeId, PruneAnswerRow, PruneAskRow, PruneCallFacts,
  PrunePassPlan, SessionSnapshot, ToolResultNode, UnitId, WireStamp,
} from '@cremator/core';
import {
  opencodeBankedRemovalOf, opencodeLiveResults, opencodeRetentionOf,
} from './apply.js';
import type { OpencodeAppliedPlanIndex } from './apply.js';
import type { OpencodeMessage } from './host.js';
import { opencodeToolNodeId } from './snapshot.js';

/**
 * The one ask grammar this mount renders: core's two-option bulk table with
 * `keepall` as the keep. The id is this adapter's own, because it is not the
 * dsh `nokeepall` family (which offers partial `keeplines`) and not the entry
 * `jsonl-20-nokeepall` wire: the prompt, the row shape and the reader are the
 * ones below, and no host config may name another.
 */
export const OPENCODE_ASK_GRAMMAR = 'prune-two-option';

export type OpencodeAskGrammar = typeof OPENCODE_ASK_GRAMMAR;

/** The slice of the mount's port the ask needs: the snapshot projection. */
export interface OpencodeAskPort {
  observe(messages: readonly OpencodeMessage[]): SessionSnapshot;
}

/** The product floor an ask tables: `DEFAULT_CONFIG.protocol.barBytes` (512). */
export const OPENCODE_ASK_FLOOR_BYTES = DEFAULT_CONFIG.protocol.barBytes;

/**
 * The frame the appended user turn opens with. The transient generate request
 * carries the session's own conversation, so the table arrives after real
 * history; this line states that the turn is instruction, not content.
 */
export const OPENCODE_ASK_FRAME =
  'The messages above are the production conversation. This message is one table of units still '
  + 'in memory: each row begins with the index you answer with, names the call that produced it, '
  + 'and quotes lines of that unit. Treat the contract, the table and the closing line as '
  + 'instruction, not as content to review.';

/** Every reason an observed unit did not become a row on this pass. */
export interface OpencodeAskDropped {
  /** Tool-result nodes below the product floor: no unit is minted for them. */
  readonly subFloor: number;
  /** Units no already-sent request has carried yet; they are not tabled. */
  readonly unseen: number;
  /** Units this session permanently settled (answered remove, or refused twice). */
  readonly asked: number;
  /** A unit whose tool-call part is absent; the apply derivation refuses it. */
  readonly orphan: number;
  /** A result the `necromancy` tool produced (ISSUE-259). */
  readonly recallAnswer: number;
  /** A unit whose exact result text is a proper substring of another live result. */
  readonly contained: number;
  /** A result whose envelope is an error or a cancelled tool (ISSUE-269). */
  readonly errorResult: number;
  /**
   * Units the pass's L1 layer removed before the table was built. They are not
   * drops in the "could not table" sense: they are the pass working, and the
   * mount applies them through the same prune document.
   */
  readonly l1Removed: number;
  /** Units the superseded-read dedupe removed before the table was built. */
  readonly dedupeRemoved: number;
}

/** One pass's plan, its table rows, addresses and exact prompt bytes. */
export interface OpencodeAskBatch {
  /** The snapshot revision the rows describe; the same-revision guard's key. */
  readonly revision: string;
  /** The pass's round ordinal, stamped on every assigned index. */
  readonly round: number;
  /**
   * The full pass: L1, the dedupe and every ask row. The mount merges this
   * plan's answers with `applyPruneAnswers`, exactly as dsh merges its pass.
   */
  readonly plan: PrunePassPlan;
  /** The rows this fire tables: a seen, unsettled, non-retained subset. */
  readonly rows: readonly PruneAskRow[];
  /** The assigned indices, ascending; the answer's only legal keys. */
  readonly indices: readonly number[];
  /** `index -> unitId + round`, ready for the reply reader. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
  /** The unit each row addresses, index-aligned with `rows`. */
  readonly unitIds: readonly UnitId[];
  /** The one user message `session.generate` appends; null when no row is tabled. */
  readonly prompt: string | null;
  /**
   * Plan rows the ledger already banked. They are not in the table; the apply
   * path re-applies each as a whole-unit `forgetall`, so a prior removal stays
   * in effect after a restart without a new question (ISSUE-300 item 6).
   */
  readonly bankedRows: readonly PruneAskRow[];
  /** Why units the observed array carried did not reach this table. */
  readonly dropped: OpencodeAskDropped;
  /** The product floor used to mint units. */
  readonly floorBytes: number;
}

export interface OpencodeAskInput {
  readonly sessionId: string;
  readonly messages: readonly OpencodeMessage[];
  readonly port: OpencodeAskPort;
  /**
   * The node ids an already-sent request has carried: the session's seen set.
   * Absent means no eligibility filter, for a pure table build; the mount and
   * every apply always supply the session's set (ADR-0054).
   */
  readonly seenNodeIds?: ReadonlySet<NodeId>;
  /** Units permanently settled: never tabled again in this session. */
  readonly askedUnitIds?: ReadonlySet<UnitId>;
  /**
   * The pass round stamped on every index. Defaults to 1 for a pure table
   * build; the mount always passes its own monotonic `passRound`.
   */
  readonly round?: number;
  /**
   * Which superseded-read dedupe classes run (ADR-0037). Absent means every
   * class is off, the dsh mount's shipped default: the lane is wired and can
   * be enabled, never silently on.
   */
  readonly classes?: DedupeClasses;
  /**
   * The ledger's applied plans, when the caller has them. A unit one of them
   * already banked (and the array does not place after a restore) is not
   * tabled: its removal is re-applied through the same prune document, never
   * re-asked (ISSUE-300 item 6).
   */
  readonly appliedPlans?: OpencodeAppliedPlanIndex;
}

/**
 * The one eligibility rule the table and the apply share (ADR-0054): a unit is
 * eligible only when an already-sent request carried its node. A result that
 * first appears in the step being transformed now is not eligible, so the
 * model is never asked about — and never loses — bytes it has not received.
 */
export function isSeenUnit(
  unit: { readonly nodeId: NodeId }, seenNodeIds: ReadonlySet<NodeId>,
): boolean {
  return seenNodeIds.has(unit.nodeId);
}

/** The tool name and target a whole call named, keyed by its result node id. */
function callFactsOf(
  messages: readonly OpencodeMessage[], sessionId: string,
): ReadonlyMap<NodeId, PruneCallFacts> {
  const calls = new Map<string, { readonly name: string; readonly target: string | null }>();
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'tool-call' && typeof part['id'] === 'string') {
        const input = part['input'];
        const target = isRecord(input)
          ? firstString(input, ['filePath', 'path'])
            ?? firstArrayString(input, ['paths', 'filePaths'])
          : null;
        calls.set(part['id'], {
          name: typeof part['name'] === 'string' ? part['name'] : '',
          target,
        });
      }
    }
  }
  const facts = new Map<NodeId, PruneCallFacts>();
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== 'tool-result' || typeof part['id'] !== 'string') continue;
      const call = calls.get(part['id']);
      const name = typeof part['name'] === 'string' && part['name'].length > 0
        ? part['name'] : call?.name ?? '';
      const callId = part['id'];
      if (typeof callId !== 'string' || callId.length === 0) continue;
      facts.set(opencodeToolNodeId(sessionId, callId), {
        ...(name.length === 0 ? {} : { toolName: name }),
        ...(call?.target === null || call?.target === undefined ? {} : { targetPath: call.target }),
      });
    }
  }
  return facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstArrayString(
  record: Readonly<Record<string, unknown>>, keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const found = value.find((entry): entry is string =>
        typeof entry === 'string' && entry.length > 0);
      if (found !== undefined) return found;
    }
  }
  return null;
}

/**
 * Builds one pass over every unit the observed array carries. Returns `null`
 * only when the array holds no unit at all (nothing to ask and nothing to
 * remove); a pass with L1/dedupe removals and no table row is returned with
 * `prompt: null`, so the mount can apply those removals without a model call.
 *
 * The plan is built from the same snapshot the at-rest pass sees, after that
 * pass has committed: units the at-rest rules removed are already absent, and
 * the table describes the array the host is about to send.
 */
export function buildOpencodeAskBatch(input: OpencodeAskInput): OpencodeAskBatch | null {
  if (!Array.isArray(input.messages)) {
    throw new TypeError('cremator: the ask needs the context hook\'s message array');
  }
  const round = input.round ?? 1;
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new RangeError('cremator: the ask pass needs a positive round ordinal');
  }
  const snapshot = input.port.observe(input.messages);
  const plan = buildOpencodePassPlan({
    sessionId: input.sessionId,
    snapshot,
    messages: input.messages,
    round,
    ...(input.classes === undefined ? {} : { classes: input.classes }),
  });
  if (plan === null) return null;
  const nodes: ToolResultNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind === 'tool-result') nodes.push(node);
  }
  const floorBytes = OPENCODE_ASK_FLOOR_BYTES;
  const nodeBy = new Map(nodes.map(node => [node.id, node] as const));
  const nodeIds = snapshot.nodes.map(node => node.id);
  const appliedPlans = input.appliedPlans;
  const callIds = new Set<string>();
  for (const message of input.messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'tool-call' && typeof part['id'] === 'string'
        && part['id'].length > 0) {
        callIds.add(part['id']);
      }
    }
  }
  const live = opencodeLiveResults(input.messages, input.sessionId);
  const asked = input.askedUnitIds ?? new Set<UnitId>();
  const seen = input.seenNodeIds;
  const dropped = {
    subFloor: 0, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
    errorResult: 0, l1Removed: plan.l1.removals.length,
    dedupeRemoved: plan.dedupe.removals.length,
  };
  for (const node of nodes) {
    if (node.bytes.length < floorBytes) dropped.subFloor += 1;
  }
  const rows: PruneAskRow[] = [];
  const bankedRows: PruneAskRow[] = [];
  for (const row of plan.askRows) {
    if (appliedPlans !== undefined
      && opencodeBankedRemovalOf(row.unit.nodeId, appliedPlans, input.messages,
        input.sessionId, nodeIds)) {
      bankedRows.push(row);
      continue;
    }
    if (seen !== undefined && !isSeenUnit(row.unit, seen)) { dropped.unseen += 1; continue; }
    if (asked.has(row.unit.id)) { dropped.asked += 1; continue; }
    const node = nodeBy.get(row.unit.nodeId);
    if (node !== undefined && !callIds.has(node.callId)) { dropped.orphan += 1; continue; }
    const retention = opencodeRetentionOf(row.unit.nodeId, live);
    if (retention !== null) {
      if (retention.code === 'recall-answer-retained') dropped.recallAnswer += 1;
      else if (retention.code === 'error-result-retained') dropped.errorResult += 1;
      else dropped.contained += 1;
      continue;
    }
    rows.push(row);
  }
  const prompt = rows.length === 0 ? null : askPromptOf(rows);
  return {
    revision: snapshot.revision,
    round,
    plan,
    rows,
    indices: rows.map(row => row.index),
    stamps: plan.stamps,
    unitIds: rows.map(row => row.unit.id),
    prompt,
    bankedRows,
    dropped,
    floorBytes,
  };
}

/**
 * The one pass planner both the table builder and the apply path use: L1, the
 * dedupe and the numbered ask rows over a ready snapshot. `null` when the
 * snapshot holds no unit at all. The plan's L1/dedupe removals are part of the
 * document the mount hands the engine, exactly as dsh's `planPrunePass` result
 * is; the table is only the subset of its rows this fire can honestly ask.
 */
export function buildOpencodePassPlan(input: {
  readonly sessionId: string;
  readonly snapshot: SessionSnapshot;
  readonly messages: readonly OpencodeMessage[];
  readonly round: number;
  readonly classes?: DedupeClasses;
}): PrunePassPlan | null {
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw new RangeError('cremator: the pass needs a positive round ordinal');
  }
  const nodes: ToolResultNode[] = [];
  for (const node of input.snapshot.nodes) {
    if (node.kind === 'tool-result') nodes.push(node);
  }
  const units = new UnitTracker({
    sessionId: input.sessionId, barBytes: OPENCODE_ASK_FLOOR_BYTES,
  }).units(input.snapshot);
  if (units.length === 0) return null;
  const episodes: readonly Episode[] = new EpisodeTracker({
    noNewPathSteps: DEFAULT_CONFIG.thresholds.episodeNoNewPathSteps,
  }).detect({
    sessionId: input.sessionId,
    results: nodes,
    currentStepOrdinal: input.snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: input.snapshot.completedThroughTurnOrdinal,
  });
  return planPrunePass({
    units,
    nodes,
    episodes,
    transcriptNodes: input.snapshot.nodes,
    callFacts: callFactsOf(input.messages, input.sessionId),
    round: input.round,
    classes: input.classes ?? {},
    // The plan's grammar selects the merge gate only. This adapter's prompt is
    // the two-option family and its reader gates `keeplines`/`forgetlines`
    // before anything is stored, so `3option` is the core grammar that accepts
    // every answer this mount stores (`keepall`, `forgetall`) unchanged.
    grammar: '3option',
  });
}

/**
 * The exact user turn this host sends: the frame, core's two-option contract,
 * the table and core's closing line. No percentage line: the 70/40 shares are
 * the deprecated `3option` entry path, never the product table (PRD §6.5).
 */
export function askPromptOf(rows: readonly PruneAskRow[]): string {
  return `${OPENCODE_ASK_FRAME}\n\n${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}\n\n`
    + `${renderPruneAskTable(rows)}\n\n${PRUNE_ASK_FINAL_LINE}`;
}

/**
 * Reads one reply under this ask's grammar. Every assigned index yields exactly
 * one result; a row the reader refuses means KEEP. The accepted actions are
 * exactly the two the prompt offers:
 *
 *   - `keepall` — the row keeps; the mount releases it for a later crossing;
 *   - `forgetall` — the row removes; the wire parser enforces the guard's own
 *     `RECEIPT_DESCRIPTOR_WORD_LIMIT` (25) before this point, so a longer
 *     summary is already `malformed-row` with wire code `summary-too-long`;
 *
 * every other action (`keeplines`, `forgetlines`) is
 * `action-not-in-grammar`, which is terminal: the mount keeps the unit and
 * never spends a re-ask on it (ADR-0053, as amended for this host).
 */

/**
 * The terminal refusal this host's two-option grammar gives an action it does
 * not offer. Core's `TWO_VERDICT_GATE_MESSAGE` names `keeplines`, the dsh
 * family's partial action; this host's prompt offers `keepall`/`forgetall`
 * only, so the message names the two actions this host actually reads
 * (ADR-0053, as amended for this host).
 */
const OPENCODE_ACTION_NOT_IN_GRAMMAR_MESSAGE =
  'The answer used an action this grammar does not offer; it takes keepall or '
  + 'forgetall, so the unit is kept.';

export function readOpencodeAskAnswer(
  batch: OpencodeAskBatch, text: string,
): readonly PruneAnswerRow[] {
  const parsed = parsePruneAnswer(text, { indices: batch.indices, stamps: batch.stamps });
  return parsed.rows.map(row => {
    if (row.status !== 'answered') return row;
    const action = row.answer.verdict.action;
    if (action === 'keepall' || action === 'forgetall') return row;
    return { index: row.index, unitId: row.unitId, status: 'refused',
      code: TWO_VERDICT_GATE_CODE, message: OPENCODE_ACTION_NOT_IN_GRAMMAR_MESSAGE,
      wireCode: null };
  });
}

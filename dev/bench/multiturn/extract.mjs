#!/usr/bin/env node
/**
 * Chunk 1 — one session of the pinned snapshot to a turn plan plus calibration.
 *
 * Usage:
 *   node dev/bench/multiturn/extract.mjs --db <snapshot> --session <id> --out <dir> [--check]
 *
 *   --db       the chunk-0 snapshot, opened read-only. The live store is never
 *              read: every number this script prints comes from this file.
 *   --session  one session id. The design names the 1,626-request probe session;
 *              it is `sess_418282d7-c746-4dd4-a140-d5de6899b332`, the only session
 *              in the corpus with 1,626 `model_usage` rows and 1,740 tool parts,
 *              so a wrong id cannot masquerade as it.
 *   --out      the record directory. Writes `turns.jsonl`, `manifest.json` and
 *              `calibration.json`, and nothing else.
 *   --check    run the chunk gate; exit non-zero, by name, when it fails.
 *
 * Prints `turns`, `nodes`, `requests`, `fills`; with `--check`, also the gate.
 *
 * ## Nodes
 *
 * A node is one rendered part, in transcript order: parts of type `text`,
 * `reasoning` and `tool`, each carrying `providerVisible` so a later lane knows
 * which nodes the provider actually saw. Structural parts (`step-start`,
 * `step-finish`, `timeline`) carry no content and are not nodes. `compaction`
 * parts are the fill ledger, not nodes. Node bytes are the rendered content
 * length in UTF-8 bytes; the design's depth unit (`/4`) is these bytes divided
 * by four. Depth counts provider-visible nodes only.
 *
 * ## Turns
 *
 * A turn is one `turn_usage` row — the store's own boundary — in `started_at`
 * order, ordinal 0 upward. `inFlight` marks a turn still `running`, which a
 * later lane needs to keep protected. `model_usage` rows with a null `turn_id`
 * (one session-title request here) have no turn and are reported as residue,
 * never dropped and never assigned.
 *
 * ## Depth reconstruction (ESTIMATED-BYTES)
 *
 * The store keeps no per-request body, so absolute depth is an estimate anchored
 * on observation. A fill (two `compaction` rows, joined on `boundaryId`; only
 * `timelineStatus = completed` operations with `auto = 1` count — a user-typed
 * `/compact` is counted separately as `userCompactions`) replaces the strict
 * prefix up to its tail with one summary node. So for a request:
 *
 *   depth = base(segment) + contentOutsideTheSummary / 4
 *
 * where `contentOutsideTheSummary` is the rendered bytes of every visible
 * message after the fill's tail, minus the summary messages themselves, and
 * `base(segment)` is measured: the observed `input_tokens` of the segment's
 * first comparable request minus its own content. Before the first fill the same
 * rule measures the system+tools prefix once. This is the lane model's shape
 * (§3 D2), with the base calibrated per segment instead of read from
 * `truePostCompactTokenCount`; the calibration file records both readings so the
 * difference is visible.
 *
 * ## The gate (--check)
 *
 * - `requests`: every `model_usage` row lands in exactly one of four named
 *   buckets, and the buckets sum to the row count: declared `main_turn` rows,
 *   in-turn non-`main_turn` rows (by `query_source`), null-`turn_id` rows, and
 *   rows whose `turn_id` names no `turn_usage` row. A non-`main_turn` row inside
 *   a turn is a printed class, never a failure. The failure is a `main_turn` row
 *   no bucket accounts for — a turn holding more `main_turn` rows than its
 *   `model_request_count` declares — named by turn with the deficit.
 * - `fills`: Σ fills over `turns.jsonl` must equal `manifest.selected.fills`
 *   (bound fills only) and `unboundFills` must be empty. A fill that binds to no
 *   turn is named by `boundaryId` with its window and request count; it is a red
 *   gate, not a note.
 * - `estimate-tolerance`: the median absolute residual over comparable requests
 *   must sit at or below the MEASURED envelope (design §7 chunk 1: chunk 9
 *   replaces the leader-set ±20% band with the measured corpus residual range).
 *   The envelope is the largest per-session median measured on the three
 *   sessions the harvest-compatible subset scored; `tolerance.mjs` holds that
 *   record and this gate reads it, so the two can never disagree. The whole
 *   residual distribution is printed beside it, and the per-request reading is
 *   reported separately as `every-request-in-tolerance`; only the median is the
 *   gate, because one request-level outlier cannot be excluded by any model that
 *   has no per-request body.
 *
 * Exempt from the gate, counted by name: requests with `input_tokens = 0` (no
 * observed depth to compare) and non-transcript queries (`session_title`).
 *
 * Exit: 0 = written and, with --check, green; 1 = the gate failed;
 *       2 = bad arguments or an unknown session.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEASURED_TOLERANCE } from './tolerance.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

/**
 * The measured calibration tolerance (chunk 9, design §7 chunk 1). The design's
 * ±20% leader-set band is REPLACED by this envelope, not blended with it: the
 * gate reads a measured number, and there is no ±x% constant left to read.
 */
const TOLERANCE = MEASURED_TOLERANCE.envelope;
/** Queries that are not transcript-bearing requests: reported, never gated. */
const NON_TRANSCRIPT_QUERIES = Object.freeze(['session_title']);
/** Part types that render into provider-visible content. */
const CONTENT_PART_TYPES = Object.freeze(['text', 'reasoning', 'tool']);
/**
 * The corpus rule's fill predicate (design §4, `select.mjs`): a fill is an
 * automatic compaction at the context limit, `auto = 1`. A user-typed `/compact`
 * is a deliberate action at a depth the user chose, not an observation of the
 * trigger firing, so it is counted apart as `userCompactions`. The store writes
 * `auto` as a number; the boolean form is accepted so a fixture may spell it.
 */
const isAutoCompaction = value => value === 1 || value === true;
/** W := T / 0.8, the design's stated assumption (§3 D2). */
const W_RATIO = 0.8;
/** The record's seed; the lanes are deterministic, so it is fixed here. */
const SEED = 0;

function usage() {
  return 'usage: node dev/bench/multiturn/extract.mjs --db <snapshot> --session <id> --out <dir> [--check]';
}

const EXTRACT_OPTIONS = optionsOf([
  ['--db', 'string'],
  ['--session', 'string'],
  ['--out', 'string'],
  ['--check', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: EXTRACT_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const opts = {
    db: values.db ?? null,
    session: values.session ?? null,
    out: values.out ?? null,
    check: values.check ?? false,
  };
  if (opts.db === null || opts.session === null || opts.out === null) {
    throw new Error(`--db, --session and --out are required\n${usage()}`);
  }
  return opts;
}

const bytesOf = value => Buffer.byteLength(value ?? '', 'utf8');

/** The rendered byte length of one content part; structural parts render to 0. */
function renderPart(part) {
  if (part.type === 'text') return bytesOf(part.text);
  if (part.type === 'reasoning') return bytesOf(part.text ?? part.content);
  if (part.type === 'tool') {
    return bytesOf(part.tool)
      + bytesOf(JSON.stringify(part.state?.input ?? {}))
      + bytesOf(part.state?.output);
  }
  return 0;
}

/** First index whose element is > target, over a sorted numeric key. */
function upperBound(list, target) {
  let low = 0;
  let high = list.length - 1;
  let answer = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list[mid] <= target) {
      answer = mid + 1;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function sha256Lines(lines) {
  return createHash('sha256').update(lines.map(line => JSON.stringify(line)).join('\n')).digest('hex');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  const outDir = resolve(opts.out);
  if (!existsSync(dbPath)) throw new Error(`snapshot not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const session = db.prepare(
      'select id, parent_id, task_type, time_created, time_updated from session where id = ?',
    ).get(opts.session);
    if (session === undefined) throw new Error(`unknown session: ${opts.session}`);

    const messages = db.prepare(
      'select id, sequence, time_created, data from message where session_id = ? order by time_created, sequence',
    ).all(opts.session).map(row => ({ ...row, body: JSON.parse(row.data) }));

    const parts = db.prepare(
      'select id, message_id, sequence, time_created, data from part where session_id = ? order by time_created, sequence, id',
    ).all(opts.session).map(row => ({ ...row, body: JSON.parse(row.data) }));

    const turns = db.prepare(
      `select turn_id, user_message_id, status, started_at, completed_at, model_request_count,
              input_tokens, cache_read_input_tokens, tool_call_count
         from turn_usage where session_id = ? order by started_at, turn_id`,
    ).all(opts.session);

    const requests = db.prepare(
      `select id, logical_request_id, turn_id, parent_user_message_id, assistant_message_id,
              query_source, model_id, status, started_at, input_tokens, cache_read_input_tokens
         from model_usage where session_id = ? order by started_at, id`,
    ).all(opts.session);

    const messageById = new Map(messages.map(message => [message.id, message]));
    const sequenceOf = new Map(messages.map(message => [message.id, message.sequence]));
    const turnOrdinalOf = new Map(turns.map((turn, index) => [turn.turn_id, index]));

    // ---- nodes ------------------------------------------------------------
    const partsByMessage = new Map();
    for (const part of parts) {
      if (!CONTENT_PART_TYPES.includes(part.body.type)) continue;
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(part);
      partsByMessage.set(part.message_id, list);
    }
    const nodes = [];
    for (const message of messages) {
      const providerVisible = message.body.semantics?.providerVisibility !== 'hidden';
      const turnId = message.body.anchor?.turnId ?? null;
      const turnOrdinal = turnId !== null && turnOrdinalOf.has(turnId) ? turnOrdinalOf.get(turnId) : null;
      for (const part of partsByMessage.get(message.id) ?? []) {
        const kind = part.body.type;
        nodes.push({
          id: part.id,
          messageId: message.id,
          sequence: message.sequence,
          turnOrdinal,
          stepOrdinal: part.sequence ?? null,
          kind,
          role: message.body.role ?? null,
          origin: message.body.semantics?.origin ?? null,
          providerVisible,
          bytes: renderPart(part.body),
          tool: kind === 'tool' ? part.body.tool ?? null : null,
          callId: kind === 'tool' ? part.body.callID ?? null : null,
          status: kind === 'tool' ? part.body.state?.status ?? null : null,
          filePath: kind === 'tool' ? part.body.state?.input?.file_path ?? null : null,
        });
      }
    }
    nodes.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));

    // Rendered bytes per visible message, used by the depth reconstruction.
    const bytesOfMessage = new Map();
    for (const [messageId, list] of partsByMessage) {
      bytesOfMessage.set(messageId, list.reduce((total, part) => total + renderPart(part.body), 0));
    }
    const visible = messages
      .filter(message => message.body.semantics?.providerVisibility !== 'hidden')
      .map(message => ({
        id: message.id,
        sequence: message.sequence,
        time: message.time_created,
        bytes: bytesOfMessage.get(message.id) ?? 0,
      }))
      .sort((a, b) => a.sequence - b.sequence);
    const visibleBySequence = visible;
    const cumulativeBySequence = [];
    let running = 0;
    for (const message of visibleBySequence) {
      running += message.bytes;
      cumulativeBySequence.push(running);
    }
    const visibleByTime = [...visible].sort((a, b) => a.time - b.time || a.sequence - b.sequence);
    const cumulativeByTime = [];
    running = 0;
    for (const message of visibleByTime) {
      running += message.bytes;
      cumulativeByTime.push(running);
    }
    /** Rendered bytes of every visible message with sequence <= seq. */
    const sequenceKeys = visibleBySequence.map(message => message.sequence);
    const bytesThroughSequence = seq => {
      const index = upperBound(sequenceKeys, seq);
      return index === 0 ? 0 : cumulativeBySequence[index - 1];
    };
    /** Rendered bytes of every visible message created strictly before `time`. */
    const timeKeys = visibleByTime.map(message => message.time);
    const bytesBeforeTime = time => {
      let low = 0;
      let high = timeKeys.length - 1;
      let answer = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (timeKeys[mid] < time) {
          answer = mid + 1;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return answer === 0 ? 0 : cumulativeByTime[answer - 1];
    };

    // ---- fills ------------------------------------------------------------
    // Two `compaction` rows per fill: the operation row (with timelineStatus)
    // and its boundary row. Only completed automatic operations count; the
    // boundary row supplies `autoCompactThreshold`. They join on `boundaryId`.
    // A completed user-requested compaction is not a fill: it is counted apart.
    const boundaryByBoundaryId = new Map();
    for (const part of parts) {
      const boundary = part.body.compactBoundary;
      if (boundary !== undefined) boundaryByBoundaryId.set(boundary.boundaryId, boundary);
    }
    const completedCompactions = parts
      .filter(part => part.body.type === 'compaction'
        && part.body.timelineStatus === 'completed'
        && Number.isSafeInteger(part.body.preCompactTokenCount))
      .map(part => {
        const boundary = boundaryByBoundaryId.get(part.body.boundaryId) ?? null;
        const summaryMessageIds = (boundary?.summaryMessageIds ?? [part.body.summaryMessageId])
          .filter(id => typeof id === 'string');
        const completedAt = part.body.time?.end ?? part.time_created;
        return {
          boundaryId: part.body.boundaryId ?? null,
          turnId: boundary?.turnId ?? null,
          turnOrdinal: boundary?.turnId !== undefined && turnOrdinalOf.has(boundary.turnId)
            ? turnOrdinalOf.get(boundary.turnId) : null,
          phase: part.body.phase ?? null,
          trigger: part.body.trigger ?? null,
          reason: part.body.compactReason ?? null,
          startedAt: part.body.time?.start ?? null,
          completedAt,
          preCompactTokenCount: part.body.preCompactTokenCount,
          postCompactTokenCount: part.body.postCompactTokenCount ?? null,
          truePostCompactTokenCount: part.body.truePostCompactTokenCount ?? null,
          autoCompactThreshold: boundary?.autoCompactThreshold ?? null,
          summarizedMessageCount: boundary?.summarizedMessageCount ?? null,
          keptMessageCount: boundary?.keptMessageCount ?? null,
          tailMessageId: part.body.tail_start_id ?? null,
          tailSequence: sequenceOf.get(part.body.tail_start_id) ?? null,
          summaryMessageIds,
          summaryBytes: summaryMessageIds.reduce((total, id) => total + (bytesOfMessage.get(id) ?? 0), 0),
          isAuto: isAutoCompaction(part.body.auto),
        };
      });
    const fills = completedCompactions
      .filter(fill => fill.isAuto)
      .sort((a, b) => a.completedAt - b.completedAt);
    const userCompactions = completedCompactions
      .filter(fill => !fill.isAuto)
      .sort((a, b) => a.completedAt - b.completedAt);
    // A fill whose boundary names no turn of this record is named, never
    // dropped: the fills gate reads this list, and its window and request count
    // say why it cannot belong to any turn.
    const requestsInWindow = (start, end) => requests.filter(request => request.started_at >= start
      && (end === null || request.started_at <= end)).length;
    const unboundFills = fills
      .filter(fill => fill.turnOrdinal === null)
      .map(fill => ({
        boundaryId: fill.boundaryId,
        turnId: fill.turnId,
        startedAt: fill.startedAt,
        completedAt: fill.completedAt,
        requestsInWindow: requestsInWindow(fill.startedAt ?? fill.completedAt, fill.completedAt),
      }));
    const boundFillCount = fills.length - unboundFills.length;

    /** The last fill completed strictly before `time`, or null. */
    const fillBefore = time => {
      let found = null;
      for (const fill of fills) {
        if (fill.completedAt < time) found = fill;
        else break;
      }
      return found;
    };
    /** Segment index: -1 before the first fill, then the fill's index. */
    const segmentOf = time => {
      let index = -1;
      for (const [position, fill] of fills.entries()) {
        if (fill.completedAt < time) index = position;
        else break;
      }
      return index;
    };
    /**
     * Rendered bytes after the segment's tail that are not the summary itself.
     * These are the bytes that grow a request's depth inside its segment.
     */
    const growingBytes = time => {
      const fill = fillBefore(time);
      if (fill === null) return bytesBeforeTime(time);
      const afterTail = bytesBeforeTime(time) - bytesThroughSequence(fill.tailSequence ?? -1);
      return afterTail - (fill.summaryBytes ?? 0);
    };

    // ---- depth ------------------------------------------------------------
    const comparable = request => request.input_tokens > 0
      && !NON_TRANSCRIPT_QUERIES.includes(request.query_source);

    // Base per segment: measured from the segment's first comparable request,
    // so each segment is anchored on one real observation, exactly as the
    // record anchors a fill. Before the first fill this measures the fixed
    // system+tools prefix.
    const baseBySegment = new Map();
    for (const request of requests) {
      if (!comparable(request)) continue;
      const segment = segmentOf(request.started_at);
      if (baseBySegment.has(segment)) continue;
      baseBySegment.set(segment, request.input_tokens - growingBytes(request.started_at) / 4);
    }
    const depthOf = request => {
      const segment = segmentOf(request.started_at);
      const base = baseBySegment.get(segment);
      if (base === undefined) return null;
      return Math.round(base + growingBytes(request.started_at) / 4);
    };
    // The design's own anchor, unfitted: truePostCompactTokenCount when the
    // segment begins at a fill. Recorded for calibration, never used as depth.
    const observedAnchorDepth = request => {
      const fill = fillBefore(request.started_at);
      if (fill === null || fill.truePostCompactTokenCount === null) return null;
      return Math.round(fill.truePostCompactTokenCount + growingBytes(request.started_at) / 4);
    };

    // ---- turn plan --------------------------------------------------------
    const requestsByTurn = new Map();
    const unturnedRequests = [];
    for (const request of requests) {
      if (request.turn_id === null) {
        unturnedRequests.push(request);
        continue;
      }
      const list = requestsByTurn.get(request.turn_id) ?? [];
      list.push(request);
      requestsByTurn.set(request.turn_id, list);
    }
    const writesOf = list => {
      const paths = new Set();
      for (const node of list) {
        if (node.kind === 'tool' && node.status === 'completed'
          && (node.tool === 'Write' || node.tool === 'Edit') && node.filePath !== null) {
          paths.add(node.filePath);
        }
      }
      return paths;
    };

    const plan = [];
    const cumulativeWrites = new Set();
    for (const [ordinal, turn] of turns.entries()) {
      const turnNodes = nodes.filter(node => node.turnOrdinal === ordinal);
      const turnWrites = writesOf(turnNodes);
      for (const path of turnWrites) cumulativeWrites.add(path);
      const turnRequests = requestsByTurn.get(turn.turn_id) ?? [];
      const prompt = turn.user_message_id !== null ? messageById.get(turn.user_message_id) : undefined;
      plan.push({
        turnOrdinal: ordinal,
        turnId: turn.turn_id,
        status: turn.status,
        inFlight: turn.status === 'running',
        startedAt: turn.started_at,
        completedAt: turn.completed_at,
        promptMessageId: turn.user_message_id,
        promptOrigin: prompt?.body.semantics?.origin ?? null,
        promptVisibility: prompt?.body.semantics?.providerVisibility ?? null,
        nodes: turnNodes.map(node => ({
          id: node.id,
          kind: node.kind,
          role: node.role,
          origin: node.origin,
          providerVisible: node.providerVisible,
          bytes: node.bytes,
          tool: node.tool,
          callId: node.callId,
          status: node.status,
          filePath: node.filePath,
        })),
        nodeCount: turnNodes.length,
        nodeBytes: turnNodes.reduce((total, node) => total + node.bytes, 0),
        requests: turnRequests.map(request => ({
          id: request.id,
          logicalRequestId: request.logical_request_id,
          querySource: request.query_source,
          modelId: request.model_id,
          status: request.status,
          startedAt: request.started_at,
          inputTokens: request.input_tokens,
          cacheReadInputTokens: request.cache_read_input_tokens,
          depth: depthOf(request),
        })),
        requestCount: turnRequests.length,
        declaredModelRequestCount: turn.model_request_count,
        declaredInputTokens: turn.input_tokens,
        declaredCacheReadInputTokens: turn.cache_read_input_tokens,
        declaredToolCallCount: turn.tool_call_count,
        fills: fills
          .filter(fill => fill.turnOrdinal === ordinal)
          .map(fill => ({
            boundaryId: fill.boundaryId,
            phase: fill.phase,
            reason: fill.reason,
            startedAt: fill.startedAt,
            completedAt: fill.completedAt,
            preCompactTokenCount: fill.preCompactTokenCount,
            truePostCompactTokenCount: fill.truePostCompactTokenCount,
            autoCompactThreshold: fill.autoCompactThreshold,
            summarizedMessageCount: fill.summarizedMessageCount,
            keptMessageCount: fill.keptMessageCount,
            tailMessageId: fill.tailMessageId,
            summaryMessageIds: fill.summaryMessageIds,
          })),
        progress: {
          writesTotal: cumulativeWrites.size,
          writesThisTurn: turnWrites.size,
        },
      });
    }

    // ---- gate -------------------------------------------------------------
    // The request gate: every `model_usage` row lands in one of four buckets and
    // the four must sum to the row count — `main_turn` rows held by a turn that
    // declares them, in-turn non-`main_turn` rows (named by `query_source`), rows
    // with a null `turn_id`, and rows whose `turn_id` names no `turn_usage` row.
    // A known non-transcript row inside a turn is a printed class; the failure is
    // a `main_turn` row no bucket accounts for, i.e. a turn holding more
    // `main_turn` rows than its declared `model_request_count`.
    const turnIds = new Set(turns.map(turn => turn.turn_id));
    const mainRowsByTurn = new Map();
    const inTurnNotDeclared = new Map();
    const unboundTurnRows = new Map();
    let nullTurnRows = 0;
    for (const request of requests) {
      if (request.turn_id === null) {
        nullTurnRows++;
      } else if (!turnIds.has(request.turn_id)) {
        unboundTurnRows.set(request.turn_id, (unboundTurnRows.get(request.turn_id) ?? 0) + 1);
      } else if (request.query_source === 'main_turn') {
        mainRowsByTurn.set(request.turn_id, (mainRowsByTurn.get(request.turn_id) ?? 0) + 1);
      } else {
        inTurnNotDeclared.set(request.query_source, (inTurnNotDeclared.get(request.query_source) ?? 0) + 1);
      }
    }
    const inTurnNotDeclaredTotal = [...inTurnNotDeclared.values()].reduce((a, b) => a + b, 0);
    const unboundTurnTotal = [...unboundTurnRows.values()].reduce((a, b) => a + b, 0);
    let declaredAndHeld = 0;
    const undeclaredMainRows = [];
    for (const turn of turns) {
      const mainRows = mainRowsByTurn.get(turn.turn_id) ?? 0;
      const declared = turn.model_request_count;
      declaredAndHeld += Math.min(mainRows, declared);
      if (mainRows > declared) {
        undeclaredMainRows.push({ turnId: turn.turn_id, mainRows, declared, deficit: mainRows - declared });
      }
    }
    const bucketSum = declaredAndHeld + inTurnNotDeclaredTotal + nullTurnRows + unboundTurnTotal;
    const requestsAgree = bucketSum === requests.length && undeclaredMainRows.length === 0;

    // The fills gate: the number the manifest reports is the number of auto
    // fills a turn holds, so it equals the sum over `turns.jsonl` by
    // construction; an auto fill that binds to no turn is named and red.
    const fillsAgree = unboundFills.length === 0 && boundFillCount === plan.reduce(
      (total, turn) => total + turn.fills.length, 0,
    );

    const residuals = requests.filter(comparable).map(request => {
      const depth = depthOf(request);
      return {
        requestId: request.id,
        querySource: request.query_source,
        segment: segmentOf(request.started_at),
        depth,
        observed: request.input_tokens,
        residual: depth === null ? null : (depth - request.input_tokens) / request.input_tokens,
        observedAnchorDepth: observedAnchorDepth(request),
      };
    }).filter(entry => entry.residual !== null);
    const absSorted = residuals.map(entry => Math.abs(entry.residual)).sort((a, b) => a - b);
    const medianResidual = quantile(absSorted, 0.5);
    // The gate reads the MEASURED envelope, never the old ±20% constant. The
    // envelope is set by one session's own median, so that session passes
    // exactly at the line; a session above it is a new class or a regression,
    // and either way the gate names it rather than absorbing it.
    const estimateInTolerance = medianResidual !== null && medianResidual <= TOLERANCE;
    const everyRequestInTolerance = absSorted.length > 0
      && absSorted[absSorted.length - 1] <= TOLERANCE;
    const anchorResiduals = residuals
      .filter(entry => entry.observedAnchorDepth !== null)
      .map(entry => Math.abs(entry.observedAnchorDepth - entry.observed) / entry.observed)
      .sort((a, b) => a - b);

    // ---- write ------------------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'turns.jsonl'), `${plan.map(line => JSON.stringify(line)).join('\n')}\n`);

    // The digest is chunk 0's, read from beside the snapshot; never recomputed
    // here (re-hashing 18 GB per extract buys nothing, and one authority is
    // better than two).
    const digestPath = dbPath.replace(/\.sqlite$/, '.sha256');
    let digest = null;
    if (existsSync(digestPath)) {
      const [first] = readFileSync(digestPath, 'utf8').trim().split(/\s+/);
      digest = first ?? null;
    }

    // Threshold T: the record's own observed autoCompactThreshold. A session
    // whose fills disagree is refused by name rather than silently taking one.
    const thresholds = [...new Set(fills.map(fill => fill.autoCompactThreshold).filter(v => v !== null))];
    if (thresholds.length > 1) {
      throw new Error(`fills disagree on autoCompactThreshold: ${thresholds.join(', ')}`);
    }
    const threshold = thresholds.length === 1 ? thresholds[0] : null;

    const manifest = {
      schema: 'racoons-multiturn-record/1',
      snapshot: {
        path: dbPath,
        digestFile: digestPath,
        digest,
        digestNote: 'written by snapshot.mjs; null when the digest file is absent',
        rowCounts: {
          message: messages.length,
          part: parts.length,
          tool_usage: db.prepare('select count(*) as n from tool_usage where session_id = ?')
            .get(opts.session).n,
          turn_usage: turns.length,
          model_usage: requests.length,
        },
      },
      session: {
        id: session.id,
        parentId: session.parent_id,
        taskType: session.task_type,
        timeCreated: session.time_created,
        timeUpdated: session.time_updated,
      },
      selected: {
        turns: plan.length,
        nodes: nodes.length,
        requests: requests.length,
        // A fill is counted only when a turn of the record holds it, so this
        // number equals the sum over `turns.jsonl` by construction. The auto
        // fills that bind to no turn are named at the manifest's top level.
        fills: boundFillCount,
        fillsTotal: fills.length,
        userCompactions: userCompactions.length,
        unboundFills: unboundFills.length,
        prompts: messages.filter(message => message.body.semantics?.origin === 'real_user').length,
      },
      unboundFills,
      selectedSha256: {
        turns: sha256Lines(plan),
        nodes: sha256Lines(nodes.map(node => ({
          id: node.id, turnOrdinal: node.turnOrdinal, kind: node.kind, bytes: node.bytes,
        }))),
        requests: sha256Lines(requests.map(request => ({
          id: request.id, turnId: request.turn_id, inputTokens: request.input_tokens,
        }))),
        fills: sha256Lines(fills.map(fill => ({
          boundaryId: fill.boundaryId,
          preCompactTokenCount: fill.preCompactTokenCount,
          truePostCompactTokenCount: fill.truePostCompactTokenCount,
        }))),
      },
      pinned: {
        threshold,
        thresholdSource: threshold === null ? 'absent' : 'observed-fill',
        W: threshold === null ? null : Math.round(threshold / W_RATIO),
        WSource: threshold === null ? 'absent' : `T/${W_RATIO}`,
        branch: fills.length > 0 ? 'observed-fill' : 'route-threshold',
        byteQuotient: 4,
        // The measured tolerance replaced the ±20% leader-set band (chunk 9).
        // A record states the number its gate read, never the old constant.
        tolerance: TOLERANCE,
        toleranceSource: MEASURED_TOLERANCE.schema,
        seed: SEED,
        prefixTokens: baseBySegment.get(-1) === undefined ? null : Math.round(baseBySegment.get(-1)),
      },
    };
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const calibration = {
      schema: 'racoons-multiturn-calibration/1',
      tolerance: TOLERANCE,
      toleranceReading: 'median absolute residual over comparable requests, gated at the measured'
        + ' per-session envelope (tolerance.mjs); replaces the ±20% band',
      toleranceSource: MEASURED_TOLERANCE.schema,
      estimator: 'depth = base(segment) + bytesAfterTail(excluding summary) / 4',
      baseBySegment: [...baseBySegment.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([segment, base]) => ({
          segment,
          base: Math.round(base),
          anchor: segment < 0 ? 'measured-prefix' : 'measured-at-first-request',
          observedTruePost: segment < 0 ? null : fills[segment].truePostCompactTokenCount,
        })),
      residualSummary: {
        comparable: residuals.length,
        exemptZeroInput: requests.filter(request => request.input_tokens <= 0).length,
        exemptNonTranscript: requests.filter(request => request.input_tokens > 0
          && NON_TRANSCRIPT_QUERIES.includes(request.query_source)).length,
        median: quantile(absSorted, 0.5),
        p75: quantile(absSorted, 0.75),
        p90: quantile(absSorted, 0.9),
        p95: quantile(absSorted, 0.95),
        max: absSorted.length === 0 ? null : absSorted[absSorted.length - 1],
        withinTolerance: absSorted.filter(value => value <= TOLERANCE).length,
        tolerance: TOLERANCE,
      },
      observedAnchorSummary: {
        note: 'depth anchored on truePostCompactTokenCount with no per-segment fit',
        comparable: anchorResiduals.length,
        median: quantile(anchorResiduals, 0.5),
        p90: quantile(anchorResiduals, 0.9),
        max: anchorResiduals.length === 0 ? null : anchorResiduals[anchorResiduals.length - 1],
      },
      residuals: residuals.map(entry => ({
        requestId: entry.requestId,
        querySource: entry.querySource,
        segment: entry.segment,
        depth: entry.depth,
        observed: entry.observed,
        residual: Number(entry.residual.toFixed(6)),
        observedAnchorDepth: entry.observedAnchorDepth,
      })),
    };
    writeFileSync(join(outDir, 'calibration.json'), `${JSON.stringify(calibration, null, 2)}\n`);

    // ---- report -----------------------------------------------------------
    const lines = [
      'extract',
      `  session     ${session.id}`,
      `  snapshot    ${dbPath}`,
      `  out         ${outDir}`,
      `  turns       ${plan.length}`,
      `  nodes       ${nodes.length}`,
      `  requests    ${requests.length}`,
      `  fills       ${fills.length}`,
      `  userCompact. ${userCompactions.length}`,
      `  unboundFills ${unboundFills.length}`,
      `  threshold   ${threshold === null ? 'absent' : threshold}`,
      `  W           ${manifest.pinned.W === null ? 'absent' : manifest.pinned.W}`,
    ];
    if (opts.check) {
      const inTurnNotDeclaredText = [...inTurnNotDeclared.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([source, count]) => `${source}=${count}`)
        .join(',') || 'none';
      lines.push(
        `  gate        requests=${requestsAgree ? 'ok' : 'FAIL'}`
        + ` (declared ${declaredAndHeld} + inTurnNotDeclared ${inTurnNotDeclaredTotal}`
        + ` + nullTurnId ${nullTurnRows} + unboundTurnId ${unboundTurnTotal}`
        + ` = ${bucketSum} vs rows ${requests.length})`
        + ` fills=${fillsAgree ? 'ok' : 'FAIL'}`
        + ` estimate=${estimateInTolerance ? 'ok' : 'FAIL'}`,
        `  buckets     declaredAndCounted=${declaredAndHeld}`
        + ` inTurnNotDeclared=${inTurnNotDeclaredText}`
        + ` nullTurnId=${nullTurnRows} unboundTurnId=${unboundTurnTotal}`
        + (unboundTurnRows.size === 0 ? '' : ` [${[...unboundTurnRows.entries()]
          .map(([turnId, count]) => `${turnId}=${count}`).join(',')}]`),
        `  fills       selected=${manifest.selected.fills}`
        + ` attached=${plan.reduce((total, turn) => total + turn.fills.length, 0)}`
        + ` userCompactions=${userCompactions.length}`,
        `  residue     unturned=${unturnedRequests.length}`
        + ` exemptZeroInput=${calibration.residualSummary.exemptZeroInput}`
        + ` exemptNonTranscript=${calibration.residualSummary.exemptNonTranscript}`,
        `  residual    median=${formatPct(medianResidual)}`
        + ` p90=${formatPct(calibration.residualSummary.p90)}`
        + ` max=${formatPct(calibration.residualSummary.max)}`
        + ` withinTolerance=${calibration.residualSummary.withinTolerance}/${residuals.length}`
        + ` every-request-in-tolerance=${everyRequestInTolerance}`
        + ` tolerance=${formatPct(TOLERANCE)} (measured envelope)`,
        `  anchor      unfitted-truePost median=${formatPct(calibration.observedAnchorSummary.median)}`
        + ` p90=${formatPct(calibration.observedAnchorSummary.p90)}`,
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);

    if (opts.check && !requestsAgree) {
      if (undeclaredMainRows.length > 0) {
        process.stderr.write(
          `requests: ${undeclaredMainRows.length} turn(s) hold more main_turn rows than they`
          + ` declare, so that many main_turn rows are in no bucket\n`,
        );
        for (const entry of undeclaredMainRows) {
          process.stderr.write(
            `  unaccounted-main_turn turn ${entry.turnId} rows ${entry.mainRows}`
            + ` declared ${entry.declared} deficit ${entry.deficit}\n`,
          );
        }
      }
      if (bucketSum !== requests.length) {
        process.stderr.write(
          `requests: buckets declared ${declaredAndHeld} + inTurnNotDeclared ${inTurnNotDeclaredTotal}`
          + ` + nullTurnId ${nullTurnRows} + unboundTurnId ${unboundTurnTotal}`
          + ` = ${bucketSum} != model_usage rows ${requests.length}\n`,
        );
      }
      for (const [turnId, count] of unboundTurnRows) {
        process.stderr.write(`  unbound-turn_id ${turnId} rows ${count}\n`);
      }
      process.exitCode = 1;
    }
    if (opts.check && !fillsAgree) {
      process.stderr.write(
        `fills: selected ${manifest.selected.fills}`
        + ` != attached ${plan.reduce((total, turn) => total + turn.fills.length, 0)}`
        + `, unbound ${unboundFills.length}\n`,
      );
      for (const fill of unboundFills) {
        process.stderr.write(
          `  unbound-fill ${fill.boundaryId} turn ${fill.turnId ?? 'null'}`
          + ` window ${fill.startedAt}..${fill.completedAt} requests ${fill.requestsInWindow}\n`,
        );
      }
      process.exitCode = 1;
    }
    if (opts.check && !estimateInTolerance) {
      process.stderr.write(
        `estimate-tolerance: median residual ${formatPct(medianResidual)} leaves the measured`
        + ` envelope ${formatPct(TOLERANCE)} over ${residuals.length} comparable requests\n`,
      );
      for (const entry of residuals
        .slice()
        .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))
        .slice(0, 5)) {
        process.stderr.write(
          `  ${entry.requestId} (${entry.querySource}) depth ${entry.depth}`
          + ` observed ${entry.observed} residual ${(entry.residual * 100).toFixed(1)}%\n`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

function formatPct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(2);
}

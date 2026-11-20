import assert from "node:assert/strict";
import { test } from "node:test";
import { planEntryShape } from "../src/engine/planning.js";
import type { EntryShapePlan, LandedEntryShapeInput } from "../src/engine/planning.js";
import { SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE } from "../src/rules/assets-templates.js";
import type { ToolResultNode } from "../src/types/transcript.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import { UnitTracker } from "../src/units/tracker.js";
import { sha256Sync } from "../src/util/hash.js";

/**
 * The shaped turn, read back by a parser that is NOT the renderer's inverse.
 *
 * Why this file exists (ISSUE-063). The offline E2E and the guard both read a
 * shaped body back through the same `renderShaped` that produced it, so a format
 * fault in that renderer is invisible to both: they agree with a wrong answer.
 * The R-2 converter builds its marker regex from the shipped template constants
 * instead, and that independent parser is what caught the live R-3 defect — 9 of
 * 10 shaped turns carried a marker whose recall id had run into the next kept
 * line (`…sha256:7391633c…d2bC:\Users\…`).
 *
 * This is the default-lane half of that lesson. It parses the rendered bytes with
 * a regex derived from the shipped templates — never from `renderShaped` — on the
 * exact live shape, a kept line AFTER a dropped gap, and asserts the `<id>` slot
 * is exactly the recall id and nothing else.
 */

/** The converter's `markerPattern`, one regex per template with a group per slot. */
function patternOf(template: string): RegExp {
  const slots = ["<ranges>", "<N>", "<B>", "<id>"];
  const pieces = slots
    .map(slot => ({ slot, at: template.indexOf(slot) }))
    .filter(piece => piece.at >= 0)
    .sort((a, b) => a.at - b.at);
  let pattern = "";
  let cursor = 0;
  for (const piece of pieces) {
    pattern += template.slice(cursor, piece.at).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    pattern += piece.slot === "<ranges>" ? "(?<ranges>[0-9,\\s\\u2013-]+)"
      : piece.slot === "<N>" ? "(?<total>\\d+)"
        : piece.slot === "<B>" ? "(?<dropped>\\d+)"
          : "(?<recallId>[^\\s]+)";
    cursor = piece.at + piece.slot.length;
  }
  pattern += template.slice(cursor).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(pattern, "gu");
}

const FULL_MARKER = patternOf(SHAPE_MARKER_TEMPLATE);
const EMPTY_MARKER = patternOf(SHAPE_MARKER_EMPTY_TEMPLATE);

interface ParsedMarker {
  readonly lineIndex: number;
  readonly text: string;
  readonly recallId: string;
  readonly ranges: string | null;
}

/**
 * Every marker the body contains, scanned the way the converter scans it: the
 * WHOLE body, one global pass per template, because the template's own last
 * character is the terminator and a per-line scan would have to guess it back.
 *
 * Two independent checks make this a real parser rather than a shape matcher:
 *
 * 1. the match must start at a line start (index 0 or just after a newline), so
 *    a marker cannot begin mid-line;
 * 2. the `<id>` slot must BE a recall id — `[^\s]+` alone is greedy enough to
 *    swallow the kept line that follows a glued marker, which is exactly how the
 *    live defect slipped through.
 */
function parseMarkers(body: string): ParsedMarker[] {
  const found: ParsedMarker[] = [];
  for (const [regex, full] of [[FULL_MARKER, true], [EMPTY_MARKER, false]] as const) {
    regex.lastIndex = 0;
    for (const match of body.matchAll(regex)) {
      const at = match.index ?? 0;
      const atLineStart = at === 0 || body[at - 1] === "\n";
      const recallId = match.groups?.recallId ?? "";
      if (!atLineStart || !/^recall:sha256:[0-9a-f]{64}$/u.test(recallId)) continue;
      found.push({ lineIndex: body.slice(0, at).split("\n").length - 1, text: match[0],
        recallId, ranges: full ? (match.groups?.ranges ?? null) : null });
    }
  }
  return found.sort((a, b) => a.lineIndex - b.lineIndex);
}

// The live shape in eight lines: kept 1–4 and 7, so the first marker is followed
// by a kept line (the `seq 31` case) and the second one is trailing. CRLF is not
// used on purpose: the terminator under test is the marker's own.
const body = [
  "<path>C:\\arm\\docs\\guides\\ref-official-terms-controls.md</path>",
  "<type>file</type>",
  "head line one",
  "head line two",
  "dropped middle one",
  "dropped middle two",
  "kept tail line",
  "dropped final line",
].join("\n").concat("\n");
const bytes = new TextEncoder().encode(body);
const SUMMARY = "kept the shelf head and one tail line";
const ANSWER: EntryAnswer = { action: "keeplines",
  ranges: [{ from: 1, to: 4 }, { from: 7, to: 7 }], summary: SUMMARY };

function shapeTurn(answer: EntryAnswer): Extract<EntryShapePlan, { action: "shape" }> {
  const node: ToolResultNode = {
    kind: "tool-result", id: "result-live-shape", turnOrdinal: 1, stepOrdinal: 5,
    bytes, sha256: sha256Sync(bytes), byteLength: bytes.length, callId: "call-live-shape",
    embeddedRecords: [], evidence: {
      kind: "read", target: { key: "docs/guides/ref-official-terms-controls.md",
        label: "docs/guides/ref-official-terms-controls.md" },
      source: { nodeId: "result-live-shape", sha256: sha256Sync(bytes), byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: "docs/guides/ref-official-terms-controls.md",
        displayPath: "docs/guides/ref-official-terms-controls.md", title: null,
        lineCount: 8, byteLength: bytes.length, outcome: "hit" }],
    },
  };
  const unit = new UnitTracker({ sessionId: "session-r3", barBytes: 0 }).unitsFor(node)[0];
  if (unit === undefined) throw new Error("fixture landed node yields no unit");
  const input: LandedEntryShapeInput = {
    unitId: unit.id, nodeId: node.id, originalBytes: node.bytes, answer };
  const plan = planEntryShape(input, {
    sessionId: "session-r3", revision: "revision-1", currentTurnOrdinal: 1,
    completedThroughTurnOrdinal: 0, currentStepOrdinal: 5, nodes: [],
    cache: { kind: "unknown" }, retentionEvidence: [],
  });
  if (plan.action !== "shape") assert.fail(`expected a shape, got ${plan.action}`);
  return plan;
}

test("a kept line after a dropped gap never shares its line with the marker (independent parse)", () => {
  const turn = shapeTurn(ANSWER);
  const text = new TextDecoder().decode(turn.replacementBytes);
  const lines = text.split("\n");

  // (1) Both markers parse as whole lines, and the kept tail line survives on
  // its own line immediately after the mid-gap marker — the text that used to
  // be absorbed into the recall id.
  const markers = parseMarkers(text);
  assert.equal(markers.length, 2, `one marker per dropped gap; body was ${JSON.stringify(text)}`);
  const markerLines = markers.map(marker => marker.lineIndex);
  assert.deepEqual(markerLines, [4, 6], `markers sit on their own lines; body was ${JSON.stringify(text)}`);
  // The marker's own text IS the whole line (the match carries the template's
  // terminator; the line split has already consumed it).
  assert.equal(lines[markerLines[0] ?? -1], markers[0]?.text.replace(/\n$/u, ""),
    "a marker must own its whole line");
  assert.equal(lines[(markerLines[0] ?? -1) + 1], "kept tail line",
    "the kept line after the gap must not be glued onto the marker's line");

  // (2) Each `<id>` slot is exactly the recall id: no path, no CR, no kept text.
  assert.deepEqual(markers.map(marker => marker.recallId), [turn.recallId, turn.recallId]);
  for (const marker of markers) {
    assert.match(marker.recallId, /^recall:sha256:[0-9a-f]{64}$/u);
  }
  // The ranges slot states the kept lines the answer named, in the marker's own
  // `start–end` form (a single line renders as `7–7`).
  assert.deepEqual(markers.map(marker => marker.ranges), ["1–4, 7–7", "1–4, 7–7"]);

  // (3) The identity the renderer owes this body, computed from the fixture's own
  // lines and the parsed markers — never from a rendered value:
  //   shaped = kept + gaps×markerBytes, where markerBytes is one whole terminated
  //   marker line. `replacementBytes` is the SHAPED part only: the adapter wraps
  //   the answer's summary above it, so no summary term belongs here.
  const bodyLines = body.split("\n").slice(0, -1);
  const keptBytes = [0, 1, 2, 3, 6]
    .reduce((sum, index) => sum + Buffer.byteLength(`${bodyLines[index] ?? ""}\n`), 0);
  const markerBytes = Buffer.byteLength(markers[0]?.text ?? "");
  assert.equal(Buffer.byteLength(text), keptBytes + markers.length * markerBytes,
    "shaped = kept + gaps×markerBytes must close with each marker's terminator counted");
});

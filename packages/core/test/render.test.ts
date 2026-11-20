import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRecords } from "../src/guard/render.js";
import type { Note } from "../src/rules/types.js";
import { encode } from "./guard-fixtures.js";

// The cap marker's renderer left the product with the entry-time cap (ADR-0014,
// 2026-10-23), so only the surviving record kinds are pinned here.
//
// The receipt row is NOT pinned here: `assets.test.ts` owns every receipt shape
// (`RECEIPT_ROWS`, five rows, including the topic-label row this file used to
// carry), and `guard-materialize.test.ts` owns the proof receipt. What stays
// here is the renderer-only rule the asset cannot state: a receipt note whose
// assets disagree with it is a refusal, never a line rendered from the drift.

const note: Note = { id: "receipt", kind: "receipt", removalId: "r", unitId: "u",
  path: "src/example.ts", ranges: [{ startLine: 2, endLineInclusive: 4 }], label: "auth retry" };
const assets = { path: "src/example.ts", ranges: note.ranges, label: "auth retry",
  recallId: "recall:example" };

/**
 * One row per renderer rule. `expect` is the whole rendered byte string for a
 * row that renders, or the pattern an `assert.throws` must match for a refusal.
 */
const CASES: readonly {
  readonly name: string;
  readonly run: () => void;
}[] = [
  {
    name: "negative-fact records use pinned asset text",
    run: () => {
      const records = renderRecords([
        { id: "fact", kind: "negative-fact", episodeId: "episode" },
      ], {
        negative: new Map([["fact", { target: "name", entries: [{ pathKey: "a", displayPath: "a.ts",
          title: null, lineCount: 4, byteLength: 20, outcome: "miss" }] }]]),
        receipt: new Map(),
      });
      assert.deepEqual(records[0]?.bytes, encode("[search: name] not found in: a.ts · 4 lines · 20 bytes\nNo match in these files for this target. Do not re-read them."),
        "row: negative-fact records use pinned asset text — the recorded bytes are the asset's text");
    },
  },
  {
    name: "a receipt record renders its archived recall id",
    run: () => {
      const records = renderRecords([note], { negative: new Map(), receipt: new Map([[note.id, assets]]) });
      assert.deepEqual(records[0]?.bytes,
        encode("[not retained] src/example.ts lines 2–4 — about: auth retry · necromancy recall:example"),
        "row: a receipt record renders its archived recall id — the line names the archive the ledger holds");
    },
  },
  {
    name: "a receipt whose label drifted from its note is refused",
    run: () => {
      assert.throws(() => renderRecords([note], { negative: new Map(),
        receipt: new Map([[note.id, { ...assets, label: "other" }]]) }),
      "row: a receipt whose label drifted from its note is refused — the assets and the note describe one receipt");
    },
  },
  {
    name: "a receipt whose ranges drifted from its note is refused",
    run: () => {
      assert.throws(() => renderRecords([note], { negative: new Map(),
        receipt: new Map([[note.id, { ...assets, ranges: [] }]]) }),
      "row: a receipt whose ranges drifted from its note is refused — the assets and the note describe one receipt");
    },
  },
];

test("record rendering — one row per rendered kind and drift rule", () => {
  for (const row of CASES) row.run();
});

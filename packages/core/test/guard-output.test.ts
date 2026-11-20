import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutputTopology } from "../src/guard/checks-output.js";
import { Guard } from "../src/guard/guard.js";
import { context, encode, entry, ledger, message, result, seal } from "./guard-fixtures.js";
import { buildCandidate } from "../src/guard/candidate.js";
import { applicationBytes } from "../src/guard/application.js";
import { finalizeCandidate } from "../src/guard/finalize.js";
import { canonicalManifestBytes } from "../src/util/bytes.js";
import { sha256Sync } from "../src/util/hash.js";

// The final-byte audit's replacement corruptions left with the entry-time cap
// (ADR-0014, 2026-10-23): no product path produces an in-place replacement, so
// there is no candidate to corrupt on that axis. The surviving audit is pinned
// through the append-record and topology checks below.

/**
 * One row per way the final bytes can disagree with the plan they claim to
 * apply. The topology rows hand `checkOutputTopology` the output a corrupting
 * host could ship; the evidence row hands the Guard a snapshot whose recall id
 * nothing can answer. Both are the same rule: the bytes about to ship must be
 * the bytes the plan vetted, so a check that stopped reading either half lets a
 * corrupting host through while the plan still validates.
 */
const CASES: readonly {
  readonly name: string;
  readonly run: () => Promise<void>;
}[] = [
  ...([
    ["reordered nodes", [result(), message()], "adjacency-changed"],
    ["changed call IDs", [message(), result({ callId: "other" })], "pairing-changed"],
    ["changed message text", [message({ bytes: encode("changed") }), result()], "retained-bytes-changed"],
  ] as const).map(([name, output, code]) => ({
    name,
    run: async (): Promise<void> => {
      const c = context(entry()); checkOutputTopology(c, output);
      assert.ok(c.issues.some(i => i.code === code),
        `row: ${name} — the audit must report ${code}, got ${JSON.stringify(c.issues.map(i => i.code))}`);
    },
  })),
  {
    name: "unavailable evidence recall",
    run: async (): Promise<void> => {
      const v = seal(), node = result();
      const validation = await new Guard({ ledger: ledger(), initialState: {
        consecutiveValidationFailures: 0, disabled: false,
      } }).validate({ ...v, snapshot: { ...v.snapshot, nodes: [message(), { ...node,
        evidence: { ...node.evidence, sourceRecallId: `recall:sha256:${"0".repeat(64)}` } }] } });
      assert.equal(validation.ok, false,
        `row: unavailable evidence recall — a recall id the ledger cannot answer refuses the plan`);
      if (!validation.ok) assert.ok(validation.issues.some(i => i.code === "recall-manifest-mismatch"),
        `row: unavailable evidence recall — the refusal names the mismatch, got ${JSON.stringify(validation.issues.map(i => i.code))}`);
    },
  },
];

test("final topology audit — one row per corrupting output", async () => {
  for (const row of CASES) await row.run();
});

test("application hash covers all application bytes using canonical UTF-8 JSON", async () => {
  const c = context(seal()), candidate = await buildCandidate(c), finalized = finalizeCandidate(c, candidate);
  if (!finalized.ok) assert.fail(JSON.stringify(finalized.issues));
  const app = finalized.application;
  const { applicationSha256, ...body } = app;
  // Independent construction pins the domain, byte representation and complete body fields.
  const expected = canonicalManifestBytes({ domain: "racoons:application:v1", application: {
    ...body,
    replacements: body.replacements.map(r => ({ ...r, bytes: Array.from(r.bytes) })),
    appendRecords: body.appendRecords.map(r => ({ ...r, bytes: Array.from(r.bytes) })),
    archives: body.archives.map(a => ({ ...a, recall: { ...a.recall,
      parts: a.recall.parts.map(p => ({ ...p, bytes: Array.from(p.bytes) })),
    } })),
  } });
  assert.equal(applicationSha256, sha256Sync(expected),
    "row: application hash — the digest is the canonical bytes of the whole envelope");
  assert.notEqual(applicationSha256, sha256Sync(applicationBytes({ ...body, eventId: "different" })),
    "row: application hash — the event id is inside the digest");
  assert.notEqual(applicationSha256, sha256Sync(applicationBytes({ ...body, createdAtMs: 11 })),
    "row: application hash — the creation time is inside the digest");
  const changed = body.appendRecords.map(r => ({ ...r, bytes: encode("changed") }));
  assert.notEqual(applicationSha256, sha256Sync(applicationBytes({ ...body, appendRecords: changed })),
    "row: application hash — the generated record bytes are inside the digest");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, floorForModel, validateConfig, FLOOR_BYTES_BY_MODEL } from '../src/config.js';
import { createDefaultRules } from "../src/rules/defaults.js";

/**
 * One merged test's cases. Each body receives its row name and puts it on every
 * assertion, so a red run names the refused code or the accepted value rather
 * than one merged block; the wrapper re-names a body that throws early.
 */
type RowCase = readonly [name: string, run: (row: string) => void];

function eachRow(cases: readonly RowCase[]): void {
  for (const [name, run] of cases) {
    try {
      run(name);
    } catch (error) {
      throw new Error(`row: ${name} failed`, { cause: error });
    }
  }
}

/** Every problem `validateConfig` files for one patched config. */
function problemsOf(patch: Record<string, unknown>): readonly string[] {
  return validateConfig({ ...DEFAULT_CONFIG, ...patch });
}

test("DEFAULT_CONFIG is the design's exact document, and it validates cleanly", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    thresholds: {
      capBytes: 8192,
      capHeadBytes: null,
      episodeNoNewPathSteps: null,
      sealMaxLatencyTurns: 1,
    },
    freshZone: { maxNodes: null, maxBytes: null },
    sealMode: "append",
    validationFailureLimit: 2,
    floorBytes: 512,
    // ADR-0035 §3: batched entry asks ship off; 1 is today's per-result cadence.
    entryAskBatchSize: 1,
    // Owner ruling 2026-11-05: jsonl-20 is the shipped answer format.
    entryAskGrammar: "jsonl-20",
    // ADR-0056: the bulk prune ask ships the two-option contract.
    pruneAskGrammar: "nokeepall",
    protocol: {
      barBytes: 512,
      minCutFreedBytes: 4096,
      enforcement: "apply",
    },
  });
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  // `protocol.dedupe` is absent on purpose (ADR-0037 decision 6): every class is
  // off unless an operator turns one on, so the pin above stays byte-identical.
  assert.equal(Object.hasOwn(DEFAULT_CONFIG.protocol, "dedupe"), false);
});

/**
 * One row per refusal code. Every invalid-config-value refusal this file ever
 * asserted is here, each row naming the message fragment it must produce, so no
 * code is dropped and a row that stopped being refused fails by name.
 */
const REFUSALS: readonly [name: string, config: unknown, expected: string][] = [
  ["config is not an object: null", null, "config must be an object."],
  ["config is not an object: undefined", undefined, "config must be an object."],
  ["config is not an object: array", [], "config must be an object."],
  ["config is not an object: string", "config", "config must be an object."],
  ["thresholds must be an object", { ...DEFAULT_CONFIG, thresholds: null }, "thresholds must be an object."],
  ["freshZone must be an object: array", { ...DEFAULT_CONFIG, freshZone: [] }, "freshZone must be an object."],
  ["protocol must be an object: null", { ...DEFAULT_CONFIG, protocol: null }, "protocol must be an object."],
  ["sealMode is an unknown word", { ...DEFAULT_CONFIG, sealMode: "unknown" },
    'sealMode must be "append" or "replace".'],
  ["validationFailureLimit must be exactly 2", { ...DEFAULT_CONFIG, validationFailureLimit: 3 },
    "validationFailureLimit must be 2."],
  ["thresholds.sealMaxLatencyTurns must be 0 or 1",
    { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, sealMaxLatencyTurns: 2 } },
    "thresholds.sealMaxLatencyTurns must be 0 or 1."],
  ["floorBytes must be a positive safe integer",
    { ...DEFAULT_CONFIG, floorBytes: 0 }, "floorBytes must be a positive safe integer."],
  ["entryAskBatchSize must be a positive safe integer",
    { ...DEFAULT_CONFIG, entryAskBatchSize: 0 }, "entryAskBatchSize must be a positive safe integer."],
  ["entryAskTrigger must be an object", { ...DEFAULT_CONFIG, entryAskTrigger: null },
    "entryAskTrigger must be an object."],
  ["entryAskTrigger.mode names one of the two modes",
    { ...DEFAULT_CONFIG, entryAskTrigger: { mode: "bytes" } },
    'entryAskTrigger.mode must be "count" or "landed-bytes".'],
  ["entryAskTrigger.bytes is required by landed-bytes",
    { ...DEFAULT_CONFIG, entryAskTrigger: { mode: "landed-bytes" } },
    "entryAskTrigger.bytes must be a positive safe integer."],
  ["entryAskGrammar names one of the four shipped grammars",
    { ...DEFAULT_CONFIG, entryAskGrammar: "2option" },
    'entryAskGrammar must be "3option", "two-option", "jsonl-20" or "jsonl-20-nokeepall"'
      + " when declared."],
  ["pruneAskGrammar names one of its three grammars",
    { ...DEFAULT_CONFIG, pruneAskGrammar: "jsonl-20" },
    'pruneAskGrammar must be "3option", "nokeepall" or "jsonl-20-nokeepall" when declared.'],
  ["protocol.dedupe must be an object",
    { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, dedupe: 1 } },
    "protocol.dedupe must be an object."],
  ["protocol.dedupe.classes must be an object",
    { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, dedupe: { classes: null } } },
    "protocol.dedupe.classes must be an object."],
  ["protocol.dedupe.classes.supersededByReread must be a boolean",
    { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, dedupe: { classes: { supersededByReread: "true" } } } },
    "protocol.dedupe.classes.supersededByReread must be a boolean."],
  ["a class this build does not ship is refused by name",
    { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, dedupe: { classes: { launchReceipt: true } } } },
    "protocol.dedupe.classes.launchReceipt is not a class this build ships."],
  ["protocol.enforcement names one of its two values",
    { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, enforcement: "enforce" } },
    'protocol.enforcement must be "record-only" or "apply" when declared.'],
];

test("every refusal code is one row: message and field name pinned, no code dropped", () => {
  eachRow(REFUSALS.map(([name, config, expected]) => [name, (row: string) => {
    const problems = validateConfig(config);
    assert.ok(problems.includes(expected), `row: ${row} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(problems)}`);
  }] as const));
  // The clean document is the negative control: the table above only means
  // something if the same validator accepts the shipped config.
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), [], "row: control — DEFAULT_CONFIG is accepted");
});

test("a declared count is refused when it is not a non-negative or positive safe integer", () => {
  // Each family is a (patch, field) pair; the value list is the same for all of
  // them, so one loop covers every counted field the file ever asserted.
  const INVALID_COUNTS = [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", undefined, null, 0];
  eachRow([
    ["protocol.barBytes and minCutFreedBytes are counts", row => {
      for (const value of INVALID_COUNTS) {
        if (value === 0) continue; // zero is a legal protocol count; asserted below.
        for (const field of ["barBytes", "minCutFreedBytes"] as const) {
          const problems = problemsOf({ protocol: { ...DEFAULT_CONFIG.protocol, [field]: value } });
          assert.equal(problems.some(problem => problem.includes(`protocol.${field}`)), true,
            `row: ${row} — ${field}=${String(value)}`);
        }
      }
      // Zero is accepted: a count that never fires is the operator's choice here.
      assert.deepEqual(problemsOf({ protocol: { barBytes: 0, minCutFreedBytes: 0 } }), [],
        `row: ${row} — zero is a legal protocol count`);
      assert.deepEqual(problemsOf({ protocol: { ...DEFAULT_CONFIG.protocol, barBytes: 1.5, minCutFreedBytes: -1 } }),
        ["protocol.barBytes must be a non-negative safe integer.",
          "protocol.minCutFreedBytes must be a non-negative safe integer."],
        `row: ${row} — the message names the field`);
    }],
    ["thresholds.episodeNoNewPathSteps and freshZone counts are nullable counts", row => {
      for (const value of INVALID_COUNTS) {
        if (value === null || value === 0) continue; // both are legal: null is absent, 0 is a count.
        const thresholds = { ...DEFAULT_CONFIG.thresholds, episodeNoNewPathSteps: value };
        assert.equal(problemsOf({ thresholds }).some(problem =>
          problem.includes("thresholds.episodeNoNewPathSteps")), true,
        `row: ${row} — thresholds.episodeNoNewPathSteps=${String(value)}`);
        for (const field of ["maxNodes", "maxBytes"] as const) {
          const freshZone: Record<string, unknown> = { ...DEFAULT_CONFIG.freshZone, [field]: value };
          assert.equal(problemsOf({ freshZone }).some(problem => problem.includes(`freshZone.${field}`)), true,
            `row: ${row} — freshZone.${field}=${String(value)}`);
        }
      }
      // Zero and null are both accepted, and validation never rewrites them.
      const zeros = { thresholds: { ...DEFAULT_CONFIG.thresholds, episodeNoNewPathSteps: 0 },
        freshZone: { maxNodes: 0, maxBytes: 0 } };
      assert.deepEqual(problemsOf(zeros), [], `row: ${row} — zero counts validate`);
      const nulls = { thresholds: { ...DEFAULT_CONFIG.thresholds, episodeNoNewPathSteps: null },
        freshZone: { maxNodes: null, maxBytes: null } };
      assert.deepEqual(problemsOf(nulls), [], `row: ${row} — null counts validate`);
    }],
    ["floorBytes and entryAskBatchSize are positive counts, and absent is valid", row => {
      for (const value of INVALID_COUNTS) {
        if (value === undefined) continue; // absent is the documented default.
        for (const field of ["floorBytes", "entryAskBatchSize"] as const) {
          assert.equal(problemsOf({ [field]: value }).some(problem => problem.includes(field)), true,
            `row: ${row} — ${field}=${String(value)}`);
        }
      }
      // Absent is valid: the shipped defaults fill both.
      const { floorBytes: _floor, entryAskBatchSize: _batch, ...without } = DEFAULT_CONFIG;
      assert.deepEqual(validateConfig(without), [], `row: ${row} — both keys may be omitted`);
      for (const field of ["floorBytes", "entryAskBatchSize"] as const) {
        for (const value of [1, 3, 12, 1280]) {
          assert.deepEqual(problemsOf({ [field]: value }), [],
            `row: ${row} — ${field}=${String(value)} is a legal count`);
        }
      }
    }],
  ]);
});

test("every optional protocol and trigger knob admits its shipped values and refuses the rest", () => {
  const withTrigger = (entryAskTrigger: unknown) => problemsOf({ entryAskTrigger });
  const withGrammar = (entryAskGrammar: unknown) => problemsOf({ entryAskGrammar });
  const withTriggerError = (patch: Record<string, unknown>, fragment: string, row: string) => {
    assert.equal(withTrigger(patch).some(problem => problem.includes(fragment)), true, `row: ${row}`);
  };
  eachRow([
    ["entryAskTrigger: count mode, landed-bytes mode, and its bytes threshold", row => {
      // ISSUE-128: absent is count mode; a landed-bytes trigger needs a positive
      // threshold or it would never fire, and zero is refused for the same reason.
      assert.deepEqual(withTrigger({ mode: "count" }), [], `row: ${row} — bare count mode`);
      assert.deepEqual(withTrigger({ mode: "count", bytes: 240_000 }), [],
        `row: ${row} — count mode may carry a threshold harmlessly`);
      assert.deepEqual(withTrigger({ mode: "landed-bytes", bytes: 240_000 }), [],
        `row: ${row} — the live run's configuration`);
      for (const bytes of [undefined, 0, -1, 1.5, NaN, Infinity, "240000", null]) {
        withTriggerError({ mode: "landed-bytes", bytes }, "entryAskTrigger.bytes",
          `${row} — landed-bytes bytes=${String(bytes)}`);
      }
      for (const mode of [undefined, "", "bytes", "landed-bytes ", null]) {
        withTriggerError({ mode }, "entryAskTrigger.mode", `${row} — mode=${String(mode)}`);
      }
      for (const trigger of [null, 1, "landed-bytes", []]) {
        assert.deepEqual(withTrigger(trigger), ["entryAskTrigger must be an object."],
          `row: ${row} — trigger ${String(trigger)}`);
      }
    }],
    ["entryAskGrammar admits exactly the four shipped grammars", row => {
      // ISSUE-129: `3option` is the original contract. ISSUE-183 adds `jsonl-20`,
      // which the owner ruling of 2026-11-05 makes the absent-value default;
      // two-option keeps its own accepted id, and ISSUE-221 adds the two-verdict
      // variant `jsonl-20-nokeepall`.
      assert.deepEqual(withGrammar(undefined), [], `row: ${row} — absent resolves to jsonl-20`);
      assert.deepEqual(withGrammar("3option"), [], `row: ${row} — 3option`);
      assert.deepEqual(withGrammar("two-option"), [], `row: ${row} — two-option`);
      assert.deepEqual(withGrammar("jsonl-20"), [], `row: ${row} — jsonl-20`);
      assert.deepEqual(withGrammar("jsonl-20-nokeepall"), [], `row: ${row} — jsonl-20-nokeepall`);
      for (const grammar of ["2option", "", "two_options", "3option ", "jsonl20", "jsonl_20",
        "JSONL-20", "nokeepall", "jsonl-20-nokeepall ", null, 3, {}]) {
        assert.equal(withGrammar(grammar).some(problem => problem.includes("entryAskGrammar")), true,
          `row: ${row} — grammar=${String(grammar)} must be refused`);
      }
    }],
    ["pruneAskGrammar is optional, defaults to nokeepall, and admits 3option", row => {
      // ISSUE-221; ADR-0056: the bulk ask's own grammar. Absent is the shipped
      // two-option contract; `3option` stays selectable by name.
      assert.equal(DEFAULT_CONFIG.pruneAskGrammar, "nokeepall", `row: ${row} — shipped default`);
      const withPruneGrammar = (pruneAskGrammar: unknown) => problemsOf({ pruneAskGrammar });
      assert.deepEqual(withPruneGrammar(undefined), [], `row: ${row} — absent is nokeepall`);
      assert.deepEqual(withPruneGrammar("3option"), [], `row: ${row} — 3option`);
      assert.deepEqual(withPruneGrammar("nokeepall"), [], `row: ${row} — nokeepall`);
      assert.deepEqual(withPruneGrammar("jsonl-20-nokeepall"), [],
        `row: ${row} — the entry two-verdict spelling is accepted (ISSUE-522)`);
      for (const grammar of ["2option", "", "3option ", "jsonl-20",
        "NOKEEPALL", null, 3, {}]) {
        assert.equal(withPruneGrammar(grammar).some(problem => problem.includes("pruneAskGrammar")),
          true, `row: ${row} — grammar=${String(grammar)} must be refused`);
      }
    }],
    ["protocol.enforcement is apply by default, record-only by opt-out", row => {
      // Owner ruling 2026-10-23: measured precision is good enough to ship applies
      // on by default (ADR-0008). `record-only` is the opt-out; anything else is
      // refused by name. Absence means apply to every reader.
      assert.equal(DEFAULT_CONFIG.protocol.enforcement, "apply", `row: ${row} — the shipped default`);
      assert.deepEqual(problemsOf({ protocol: { ...DEFAULT_CONFIG.protocol, enforcement: "record-only" } }), [],
        `row: ${row} — record-only is a valid explicit value`);
      for (const value of ["enforce", "APPLY", true, 1, null]) {
        assert.equal(problemsOf({ protocol: { ...DEFAULT_CONFIG.protocol, enforcement: value } })
          .some(problem => problem.includes("protocol.enforcement")), true,
        `row: ${row} — enforcement=${String(value)}`);
      }
      const { enforcement: _omitted, ...legacy } = DEFAULT_CONFIG.protocol;
      assert.deepEqual(problemsOf({ protocol: legacy }), [],
        `row: ${row} — an absent enforcement means apply`);
    }],
    ["protocol.dedupe.classes is optional, default-off, and validates by class", row => {
      // ADR-0037 decision 6; ISSUE-145. Absence is the shipped state.
      const withDedupe = (dedupe: unknown) => problemsOf({
        protocol: { ...DEFAULT_CONFIG.protocol, dedupe } });
      assert.deepEqual(withDedupe({}), [], `row: ${row} — an empty dedupe`);
      assert.deepEqual(withDedupe({ classes: {} }), [], `row: ${row} — no class declared`);
      assert.deepEqual(withDedupe({ classes: { supersededByReread: false } }), [],
        `row: ${row} — the shipped class off`);
      assert.deepEqual(withDedupe({ classes: { supersededByReread: true } }), [],
        `row: ${row} — the shipped class on`);
      // Class 1's exact-echo subset ships: the name is accepted, and every
      // declared value must still be a boolean.
      assert.deepEqual(withDedupe({ classes: { callEcho: true } }), [],
        `row: ${row} — the call-echo class on`);
      assert.equal(withDedupe({ classes: { callEcho: "true" } }).some(problem =>
        problem.includes("protocol.dedupe.classes.callEcho")), true,
      `row: ${row} — callEcho must be a boolean`);
      for (const dedupe of [null, 1, "on", []]) {
        assert.deepEqual(withDedupe(dedupe), ["protocol.dedupe must be an object."],
          `row: ${row} — dedupe ${String(dedupe)}`);
      }
      assert.deepEqual(withDedupe({ classes: null }), ["protocol.dedupe.classes must be an object."],
        `row: ${row} — classes null`);
      for (const flag of ["true", 1, null, [true]]) {
        assert.equal(withDedupe({ classes: { supersededByReread: flag } }).some(problem =>
          problem.includes("protocol.dedupe.classes.supersededByReread")), true,
        `row: ${row} — supersededByReread=${String(flag)} must be refused`);
      }
      // A class this build does not ship is refused BY NAME: a switch that silently
      // planned nothing would read as "on" in a launch row while removing nothing.
      for (const name of ["launchReceipt", "harnessCopy", "superseded-by-reread"]) {
        assert.equal(withDedupe({ classes: { [name]: true } }).some(problem =>
          problem.includes(`protocol.dedupe.classes.${name}`)), true,
        `row: ${row} — ${name} must be refused by name`);
      }
    }],
  ]);
});

test("the scrapped cap keys still load and mount, and floorForModel reads the table", () => {
  eachRow([
    ["the scrapped cap keys accept every value and are never read (ADR-0014)", row => {
      for (const field of ["capBytes", "capHeadBytes"] as const) {
        for (const value of [-1, 1.5, NaN, Infinity, "1", null, undefined]) {
          const config = { ...DEFAULT_CONFIG,
            thresholds: { ...DEFAULT_CONFIG.thresholds, [field]: value } };
          assert.deepEqual(validateConfig(config), [],
            `row: ${row} — ${field}=${String(value)} is accepted and ignored`);
        }
      }
      // The mount pin: an old config file must never crash a mount. Validation
      // accepts it, and the default rule set builds without the cap rule.
      const legacy = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds,
        capBytes: 4096, capHeadBytes: 1024 } };
      assert.deepEqual(validateConfig(legacy), [], `row: ${row} — a legacy config validates`);
      assert.deepEqual(createDefaultRules(legacy).map((rule) => rule.id),
        ["seal", "verdict", "entry-shape", "stale-read", "superseded-read"],
        `row: ${row} — the rule set builds without the cap rule`);
    }],
    ["the per-model table is the calibration's, entry for entry", row => {
      // Every row of the note's §6 table, spelled out here so a drift in either
      // direction fails by name rather than by count
      // (docs/research/floor-calibration-2026-10-26.md §6).
      const expected = {
        "deepseek-v4-pro": 768,
        "deepseek-v4.1-flash-1017": 1280,
        "gpt-6-astra": 256,
        "claude-opus-5.5": 512,
        "claude-sonnet-5.5": 512,
        "glm-5.3": 256,
        "gemini-4-argon": 512,
        "grok-4.7": 256,
        "kimi-k3.1-pro": 256,
        "qwen3.8-max-prime": 256,
      } as const;
      assert.deepEqual(FLOOR_BYTES_BY_MODEL, expected, `row: ${row} — the table`);
      assert.equal(Object.keys(FLOOR_BYTES_BY_MODEL).length, 10, `row: ${row} — two Claude rows, not one`);
      // `floorForModel` reads the same table: one row per model, and a default
      // for anything absent, including a prototype key or a non-string.
      for (const [model, floor] of Object.entries(expected)) {
        assert.equal(floorForModel(model), floor, `row: ${row} — floorForModel(${model})`);
      }
      for (const model of ["gpt-5", "deepseek-v4", "DeepSeek-V4-Pro", "", " ", "toString", "__proto__", null, undefined]) {
        assert.equal(floorForModel(model), 512, `row: ${row} — ${String(model)} takes the default`);
      }
    }],
  ]);
});

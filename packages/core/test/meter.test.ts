import assert from "node:assert/strict";
import { test } from "node:test";
import type { MeterErrorCode } from "../src/meter/errors.js";
import { MeterError } from "../src/meter/errors.js";
import { Meter } from "../src/meter/meter.js";
import { CharHeuristicTokenMeter } from "../src/meter/token-meter.js";
import type { ApiUsage, UsageObservation } from "../src/meter/token-meter.js";

function observation(
  usage: ApiUsage,
  estimatedInputTokens = 80,
): UsageObservation {
  return {
    kind: "usage",
    requestId: "request-1",
    revision: "revision-1",
    estimatedInputTokens,
    usage,
  };
}

const meterOf = (): Meter => new Meter(new CharHeuristicTokenMeter());
const usage = (
  inputTokens: number, outputTokens: number, cachedInputTokens: number | null,
): ApiUsage => ({ inputTokens, outputTokens, cachedInputTokens });

/** One estimate: a byte length in, the expected token count out. */
interface EstimateCase {
  readonly row: string;
  readonly bytes: () => Uint8Array;
  readonly tokens: number;
}

/**
 * The estimate is `ceil(bytes / 4)`, twice: a pure function of the byte length,
 * never a running count, and never a read of the values. Every expected count is
 * pinned literally, so a rounding drift fails on its own row.
 */
const ESTIMATE_CASES: readonly EstimateCase[] = [
  { row: "empty input estimates zero", bytes: () => new Uint8Array(0), tokens: 0 },
  { row: "one byte rounds up to one", bytes: () => new Uint8Array(1), tokens: 1 },
  { row: "three bytes round up to one", bytes: () => new Uint8Array(3), tokens: 1 },
  { row: "four bytes are exactly one", bytes: () => new Uint8Array(4), tokens: 1 },
  { row: "five bytes round up to two", bytes: () => new Uint8Array(5), tokens: 2 },
  { row: "nine bytes round up to three", bytes: () => new Uint8Array(9), tokens: 3 },
  {
    row: "non-text bytes count by length, not by value",
    bytes: () => new Uint8Array([0xff, 0x00, 0x80, 0x0d, 0x0a]), tokens: 2,
  },
  {
    row: "a one-byte subarray counts one",
    bytes: () => new Uint8Array([0xff, 0x00, 0x80, 0x0d, 0x0a]).subarray(0, 1), tokens: 1,
  },
];

/** One reconciliation: the authoritative usage in, every reading field out. */
interface ReadingCase {
  readonly row: string;
  readonly observation: UsageObservation;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  /** Signed `inputTokens - estimatedInputTokens`. */
  readonly estimateErrorTokens: number;
  /** `null` when cached tokens or authoritative input is zero, or cached is absent. */
  readonly cachedInputShare: number | null;
}

/**
 * The reconciliation arithmetic against the injected estimate: the signed
 * error, and the cached share's null convention. One row per reading, so a
 * field the meter stops computing fails on its own row.
 */
const READING_CASES: readonly ReadingCase[] = [
  {
    row: "authoritative usage for its request and revision",
    observation: observation(usage(100, 12, 25)),
    inputTokens: 100, outputTokens: 12, cachedInputTokens: 25,
    estimateErrorTokens: 20, cachedInputShare: 0.25,
  },
  {
    row: "an over-estimate carries a negative error",
    observation: { ...observation(usage(40, 0, null)), requestId: "request-2", revision: "revision-2" },
    inputTokens: 40, outputTokens: 0, cachedInputTokens: null,
    estimateErrorTokens: -40, cachedInputShare: null,
  },
  {
    row: "null cached usage stays null",
    observation: observation(usage(100, 5, null)),
    inputTokens: 100, outputTokens: 5, cachedInputTokens: null,
    estimateErrorTokens: 20, cachedInputShare: null,
  },
  {
    row: "runtime-omitted cached usage stays null",
    // Exercise a JavaScript adapter omitting the declared nullable field.
    observation: observation({ inputTokens: 100, outputTokens: 5 } as ApiUsage),
    inputTokens: 100, outputTokens: 5, cachedInputTokens: null,
    estimateErrorTokens: 20, cachedInputShare: null,
  },
  {
    row: "cached share divides by the authoritative input",
    observation: observation(usage(200, 10, 50), 1),
    inputTokens: 200, outputTokens: 10, cachedInputTokens: 50,
    estimateErrorTokens: 199, cachedInputShare: 0.25,
  },
  {
    row: "a fully cached input is a share of one",
    observation: observation(usage(7, 0, 7)),
    inputTokens: 7, outputTokens: 0, cachedInputTokens: 7,
    estimateErrorTokens: -73, cachedInputShare: 1,
  },
  {
    row: "zero input counts give a null share, not zero",
    observation: observation(usage(0, 0, 0), 0),
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    estimateErrorTokens: 0, cachedInputShare: null,
  },
  {
    row: "zero cached counts give a null share, not zero",
    observation: observation(usage(100, 0, 0), 0),
    inputTokens: 100, outputTokens: 0, cachedInputTokens: 0,
    estimateErrorTokens: 100, cachedInputShare: null,
  },
];

test("estimate and reconciliation arithmetic — one row per reading", () => {
  const estimator = meterOf();
  for (const expected of ESTIMATE_CASES) {
    const row = `row: ${expected.row}`;
    const bytes = expected.bytes();
    // Twice: a second call cannot inherit a count from the first.
    assert.equal(estimator.estimate(bytes), expected.tokens, `${row} — first estimate`);
    assert.equal(estimator.estimate(bytes), expected.tokens, `${row} — repeat estimate`);
  }
  assert.equal(estimator.latest(), null, "row: estimate only — estimating records no usage");

  for (const expected of READING_CASES) {
    const row = `row: ${expected.row}`;
    const meter = meterOf();
    assert.equal(meter.latest(), null, `${row} — a fresh meter has no reading`);
    const reading = meter.reconcile(expected.observation);
    assert.deepEqual(reading, {
      requestId: expected.observation.requestId,
      revision: expected.observation.revision,
      estimatedInputTokens: expected.observation.estimatedInputTokens,
      inputTokens: expected.inputTokens,
      outputTokens: expected.outputTokens,
      cachedInputTokens: expected.cachedInputTokens,
      estimateErrorTokens: expected.estimateErrorTokens,
      cachedInputShare: expected.cachedInputShare,
    }, row);
    assert.strictEqual(meter.latest(), reading, `${row} — the reconciled reading is the latest`);
    // A second reconciliation replaces `latest()` without rewriting the first:
    // a reading is an immutable record of the observation that produced it.
    const next = meter.reconcile({ ...observation(usage(1, 1, null)), requestId: "request-2" });
    assert.strictEqual(meter.latest(), next, `${row} — the second reading becomes latest`);
    assert.equal(reading.inputTokens, expected.inputTokens, `${row} — the first reading is unchanged`);
  }
});

test("invalid counts and inconsistent usage throw MeterError — one row per input", () => {
  const valid = usage(20, 1, null);
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens"] as const;
  const invalidCounts = [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53];
  const cases: [string, MeterErrorCode, string, (meter: Meter) => unknown][] = [];
  for (const invalid of invalidCounts) {
    for (const field of fields) {
      cases.push([`${field} of ${String(invalid)}`, "invalid-count", field, meter =>
        meter.reconcile(observation({ ...valid, [field]: invalid }))]);
    }
    cases.push([`an injected estimate of ${String(invalid)}`, "invalid-count",
      "estimatedInputTokens", meter => meter.reconcile(observation(valid, invalid))]);
    cases.push([`a token meter returning ${String(invalid)}`, "invalid-count",
      "estimatedInputTokens", () => {
        const injected = new Meter({ estimate: () => invalid });
        return injected.estimate(new Uint8Array());
      }]);
  }
  cases.push(["cached tokens above input tokens", "inconsistent-usage",
    "cachedInputTokens", meter => meter.reconcile(observation(usage(10, 1, 11)))]);

  assert.equal(meterOf().latest(), null);
  for (const [row, code, field, run] of cases) {
    const meter = meterOf();
    // A reading the guard accepts, so "no reading recorded" is a real claim.
    const kept = meter.reconcile(observation(valid));
    assert.throws(() => run(meter), (error: unknown) => {
      if (!(error instanceof MeterError)) {
        assert.fail(`row: ${row} — expected a MeterError, got ${String(error)}`);
      }
      assert.equal(error.code, code, `row: ${row} — the error code`);
      // The message names the field or the pair, so a reader finds the input.
      assert.ok(error.message.includes(field),
        `row: ${row} — the message names ${field}: ${error.message}`);
      return true;
    }, `row: ${row}`);
    // A refused observation never replaces the reading already held.
    assert.strictEqual(meter.latest(), kept, `row: ${row} — the earlier reading survived`);
  }
});

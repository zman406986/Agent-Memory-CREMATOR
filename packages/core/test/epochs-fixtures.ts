import type { Epoch, EpochCall, EpochDecision } from "../src/epochs/types.js";

// The spike-008 manifest's epoch-relevant columns, in file order: each row's
// `nTurns` and `unitLines`. The fixture keeps the real numbers so the ported
// selftest cases assert the same boundary counts they asserted on the manifest
// (26 calls at turn 0, 25 at turn 11, 95 at or below turn 11, 250 rows).
// Unit ids are respelled `unit:row:<fileIndex>`: no case depends on their text.
export const TURN_INDEXES = [13, 14, 20, 0, 24, 10, 11, 18, 0, 19, 13, 14, 20, 20, 2, 14, 18, 18, 15, 4, 0, 29, 27, 0, 31, 11, 19, 20, 17, 4, 40, 4, 19, 29, 4, 34, 18, 12, 12, 12, 19, 1, 0, 11, 11, 40, 14, 11, 14, 37, 0, 0, 49, 10, 31, 16, 5, 41, 21, 29, 11, 24, 4, 0, 0, 0, 17, 41, 0, 18, 21, 5, 11, 13, 31, 10, 18, 19, 10, 9, 6, 4, 25, 13, 31, 14, 11, 20, 21, 14, 0, 24, 1, 12, 11, 0, 27, 24, 10, 0, 17, 13, 41, 0, 31, 25, 5, 5, 21, 12, 9, 11, 20, 12, 13, 6, 15, 40, 1, 31, 12, 4, 20, 0, 14, 14, 25, 34, 13, 11, 20, 13, 13, 9, 24, 20, 24, 21, 20, 1, 19, 14, 50, 0, 16, 25, 11, 5, 12, 11, 4, 14, 3, 19, 11, 23, 5, 24, 13, 24, 3, 34, 29, 3, 34, 15, 15, 28, 19, 24, 14, 15, 4, 0, 11, 11, 24, 41, 15, 4, 49, 14, 24, 11, 0, 12, 15, 6, 14, 11, 11, 12, 42, 15, 0, 11, 5, 8, 50, 11, 0, 27, 3, 0, 31, 49, 31, 17, 20, 27, 2, 29, 42, 13, 0, 4, 28, 23, 35, 11, 15, 15, 4, 0, 0, 9, 15, 0, 19, 10, 1, 18, 20, 13, 16, 40, 13, 44, 12, 35, 12, 27, 20, 11, 25, 14, 14, 11, 11, 15];
export const UNIT_LINES = [115, 1, 6, 338, 100, 68, 11, 7, 94, 10, 75, 1, 6, 70, 50, 108, 1, 6, 143, 1, 60, 7, 1, 120, 132, 84, 10, 4, 55, 1, 59, 1, 6, 21, 5, 6, 1, 6, 120, 30, 24, 18, 2, 50, 35, 59, 1, 4, 108, 3, 40, 20, 1, 45, 17, 4, 1, 1, 157, 1, 60, 25, 1, 124, 110, 73, 12, 1, 98, 20, 39, 1, 2, 45, 241, 50, 1, 6, 130, 48, 81, 1, 31, 115, 120, 50, 52, 17, 53, 8, 106, 80, 7, 39, 130, 99, 13, 10, 40, 96, 31, 16, 1, 60, 132, 60, 1, 32, 53, 2, 114, 6, 1, 126, 84, 114, 99, 1, 26, 120, 45, 1, 15, 99, 40, 80, 5, 43, 45, 120, 130, 81, 6, 29, 120, 120, 80, 1, 92, 117, 24, 7, 6, 73, 29, 60, 15, 10, 120, 20, 130, 1, 1, 206, 4, 57, 293, 5, 4, 25, 141, 14, 1, 141, 7, 36, 32, 11, 20, 1, 50, 73, 1, 98, 5, 147, 80, 6, 106, 1, 91, 28, 1, 138, 38, 18, 53, 4, 214, 30, 4, 1, 1, 82, 22, 661, 1, 6, 32, 3, 175, 18, 1, 51, 23, 100, 17, 6, 18, 175, 59, 44, 1, 22, 50, 240, 12, 1, 120, 63, 65, 7, 7, 40, 45, 25, 1, 6, 206, 100, 132, 1, 6, 75, 11, 59, 16, 1, 48, 5, 18, 100, 1, 115, 1, 30, 40, 18, 287, 78];

export const MANIFEST_ROWS = 250;

interface ManifestRow {
  readonly unitId: string;
  readonly unitLines: number;
  readonly turnIndex: number;
}

export const rows: readonly ManifestRow[] = TURN_INDEXES.map((turnIndex, index) => ({
  turnIndex,
  unitId: `unit:row:${index}`,
  unitLines: UNIT_LINES[index] ?? 1,
}));

/** One call per manifest row, ascending by turn; ties keep file order. */
export const calls: readonly EpochCall[] = rows
  .map((row, order) => ({ callId: `call-${row.unitId.replace("unit:row:", "")}`, turnIndex: row.turnIndex, order }))
  .sort((a, b) => a.turnIndex - b.turnIndex || a.order - b.order)
  .map(({ callId, turnIndex }) => ({ callId, turnIndex }));

export const allCallIds: readonly string[] = calls.map(call => call.callId);

const turnOf = new Map(calls.map(call => [call.callId, call.turnIndex]));

/** The turn a fixture call sits at; fails loudly for an id the fixture lacks. */
export function turnOfCall(callId: string): number {
  const turnIndex = turnOf.get(callId);
  if (turnIndex === undefined) throw new Error(`${callId} is not a fixture call`);
  return turnIndex;
}

export function mustEpoch(epochs: readonly Epoch[], index: number): Epoch {
  const epoch = epochs[index];
  if (epoch === undefined) throw new Error(`epoch ${index} is missing`);
  return epoch;
}

/** The whole unit removed, using the row's recorded line count. */
export function wholeUnitDecision(turn: number, rowIndex: number): EpochDecision {
  const row = rows[rowIndex];
  if (row === undefined) throw new Error(`fixture row ${rowIndex} is missing`);
  return { turn, unitId: row.unitId, ranges: [{ startLine: 1, endLineInclusive: row.unitLines }] };
}

/** Four calls: two at turn 0, one at turn 1, one at turn 3. */
export const SMALL_CALLS: readonly EpochCall[] = Object.freeze([
  { callId: "c0a", turnIndex: 0 },
  { callId: "c0b", turnIndex: 0 },
  { callId: "c1", turnIndex: 1 },
  { callId: "c3", turnIndex: 3 },
]);

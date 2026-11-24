// Gate 2's epoch and applied-set checks, as one module (ISSUE-035 item 10,
// chunk 5).
//
// These checks were written inside `dev/sim/gate2-tables.mjs` and gate 2 is
// where they are defined. The multi-turn lane's removal stage has to answer the
// same question — does the applied set a caller recorded equal the one the
// SHIPPED `epochsFor`/`appliedSetAt` produce — so it imports this module rather
// than writing a second, drifting copy. `gate2-tables.mjs` imports it too, and
// its output is unchanged; a divergence between the two callers is impossible
// because there is one implementation.
//
// Nothing here reads a clock, a network or a file. Every input is passed in, and
// `recordFailure`/`fail` are the caller's, so each caller keeps its own exit
// codes and its own failure classes.

/**
 * Derives the epoch plan for each arm with the shipped `epochsFor`.
 *
 * `rowsByArm` maps an arm name to its rows; each row needs `tableId`,
 * `sessionId`, `lastTurn`. `decisionsFor(arm, sessionId)` answers that arm's
 * decisions, in the shipped `EpochDecision` shape. Returns
 * `{ [arm]: Map(epochKey -> epoch) }` with the key format gate 2 records.
 *
 * A throw from the shipped planner is a red `epoch-plan`, never a crash: a
 * caller bug and a product refusal must both print as a named failure.
 */
export function deriveEpochsByArm({
  rowsByArm, decisionsFor, epochsFor, recordFailure, fail,
}) {
  const derived = {};
  for (const [arm, rows] of Object.entries(rowsByArm)) {
    derived[arm] = new Map();
    const bySession = new Map();
    for (const row of rows) {
      if (typeof row.tableId !== 'string' || typeof row.sessionId !== 'string') {
        fail(2, 'a row carries no tableId/sessionId');
      }
      if (!Number.isSafeInteger(row.lastTurn)) fail(2, `${row.tableId}: lastTurn is not an integer`);
      if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []);
      bySession.get(row.sessionId).push({ callId: row.tableId, turnIndex: row.lastTurn });
    }
    for (const [sessionId, calls] of bySession) {
      let epochs;
      try {
        epochs = epochsFor(calls, decisionsFor(arm, sessionId));
      } catch (error) {
        recordFailure('epoch-plan',
          `${arm} ${sessionId}: the shipped epochsFor refused the rows: ${error.message}`);
        continue;
      }
      for (const epoch of epochs) {
        derived[arm].set(`${sessionId}#${epoch.epochIndex}`, epoch);
      }
    }
  }
  return derived;
}

/**
 * Compares every recorded row and every recorded epoch summary against the
 * shipped plan. Classes: `epoch-plan` only — this is the plan check, and gate 2
 * keeps the byte-level classes for itself.
 */
export function checkEpochPlan({
  rowsByArm, derivedEpochs, summaryEpochByKey, recordFailure,
}) {
  for (const [arm, rows] of Object.entries(rowsByArm)) {
    const derived = derivedEpochs[arm];
    const recorded = summaryEpochByKey[arm] ?? new Map();
    for (const row of rows) {
      const epoch = derived.get(row.epochKey);
      if (epoch === undefined) {
        recordFailure('epoch-plan', `${arm} ${row.tableId}: the shipped planner puts it in no`
          + ` epoch named ${row.epochKey}`);
        continue;
      }
      if (row.epochIndex !== epoch.epochIndex) {
        recordFailure('epoch-plan', `${arm} ${row.tableId}: recorded epochIndex ${row.epochIndex}`
          + ` != shipped ${epoch.epochIndex}`);
      }
      if (row.epochBase !== (epoch.firstCallId === row.tableId)) {
        recordFailure('epoch-plan', `${arm} ${row.tableId}: recorded epochBase ${row.epochBase}`
          + ` != shipped ${epoch.firstCallId === row.tableId}`);
      }
    }
    for (const [epochKey, epoch] of derived) {
      const record = recorded.get(epochKey);
      if (record === undefined) {
        recordFailure('epoch-plan', `${arm} ${epochKey}: the shipped planner produces it but the`
          + ' summary records no epoch');
        continue;
      }
      if (record.firstTableId !== epoch.firstCallId || record.lastTableId !== epoch.lastCallId
        || record.tableCount !== epoch.callCount
        || record.firstTurnIndex !== epoch.firstTurnIndex
        || record.lastTurnIndex !== epoch.lastTurnIndex) {
        recordFailure('epoch-plan', `${arm} ${epochKey}: recorded membership`
          + ` ${record.firstTableId}..${record.lastTableId}/${record.tableCount}`
          + ` != shipped ${epoch.firstCallId}..${epoch.lastCallId}/${epoch.callCount}`);
      }
      if (record.appliedRemovalSet !== epoch.appliedRemovalSet) {
        recordFailure('epoch-plan', `${arm} ${epochKey}: recorded applied set != shipped`
          + ` ${epoch.appliedRemovalSet}`);
      }
      const shippedGroups = epoch.sameTurnGroups.map(group => ({
        turnIndex: group.turnIndex, tableIds: [...group.callIds],
      }));
      if (JSON.stringify(record.sameTurnGroups ?? []) !== JSON.stringify(shippedGroups)) {
        recordFailure('epoch-plan', `${arm} ${epochKey}: recorded same-turn groups differ from the`
          + " shipped planner's");
      }
    }
    for (const epochKey of recorded.keys()) {
      if (!derived.has(epochKey)) {
        recordFailure('epoch-plan', `${arm} ${epochKey}: the summary records it but the shipped`
          + ' planner does not produce it');
      }
    }
  }
}

/**
 * Re-derives each row's applied set with the shipped `appliedSetAt` and compares
 * the canonical serialisation and the unit ids the row recorded. Class:
 * `epoch-applied-set`.
 */
export function checkAppliedSets({
  rowsByArm, decisionsFor, appliedSetAt, sha256Sync, recordFailure,
}) {
  for (const [arm, rows] of Object.entries(rowsByArm)) {
    for (const row of rows) {
      let applied;
      try {
        applied = arm === 'off'
          ? []
          : appliedSetAt(decisionsFor(arm, row.sessionId), row.lastTurn);
      } catch (error) {
        // One row whose derivation throws is a failed row, not the end of the
        // pass: the later rows are still judged (ISSUE-581).
        recordFailure('epoch-applied-set',
          `${arm} ${row.tableId}: re-derivation threw: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const appliedSet = JSON.stringify(applied);
      const appliedSha = sha256Sync(Buffer.from(appliedSet, 'utf8'));
      if (appliedSha !== row.applied?.sha256) {
        recordFailure('epoch-applied-set',
          `${arm} ${row.tableId}: re-derived applied set ${appliedSha.slice(0, 16)}`
          + ` != recorded ${String(row.applied?.sha256).slice(0, 16)}`);
      }
      const appliedIds = applied.map(entry => entry.unitId);
      if (JSON.stringify(appliedIds) !== JSON.stringify(row.applied?.unitIds ?? [])) {
        recordFailure('epoch-applied-set',
          `${arm} ${row.tableId}: re-derived applied units ${JSON.stringify(appliedIds)}`
          + ` != recorded ${JSON.stringify(row.applied?.unitIds)}`);
      }
    }
  }
}

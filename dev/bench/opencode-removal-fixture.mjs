/**
 * The removable fixture the opencode bench runs against.
 *
 * The earlier world held one 20-byte file and issued one read per turn. Nothing
 * in it was above the product's bar, so the engine could not prove a removal and
 * the run could not measure one. This module builds a world the product can
 * actually prune: a file above the host reader's cap, read once, then re-read so
 * the earlier copy is `superseded-read`. The superseded copy is removed whole —
 * its tool-call part and its tool-result part — and a receipt naming its recall
 * id takes its place.
 *
 * **What the fixture proves, and what it does not.** The removal class is a
 * whole-unit removal proven by a superseded read. The adapter does not cap or
 * rewrite a result (ADR-0048), so this fixture's lanes measure the whole-unit
 * class only; there is no batched prune. The `multi-unit-pass` lane removes three
 * units in one at-rest application — not the dsh bulk prune: no model ask and no
 * answer. The product records one recall per unit (one part per recall) and one
 * applied intent that lists them together; the run measures that shape from the
 * adapter journal (one recall per unit, every applied pass applying all of them
 * together) rather than assuming it from the fixture. The number of derivations
 * is not recorded, so the lane does not claim one. The run's claim names the
 * class it measured.
 *
 * **The script is data, the file bytes are deterministic.** The shipped script
 * names `{{WORK}}` wherever a path is needed; `renderScript` substitutes the
 * arm world's absolute work directory. `fixtureFileBytes` derives every file's
 * bytes from its sentinel and size, so two runs of the same fixture write the
 * same bytes. The sentinel is a marker no surviving copy carries; the call id is
 * the other marker, because the removed result and its call are one unit.
 *
 * **Above the bar matters.** 2.4.0 truncates a produced read result at 2,000
 * lines or 50 KiB, head only, and saves the full output to a file (the host's
 * `packages/core/src/tool-output.ts`, not this repo's `packages/core`). Those
 * numbers and that cut are **declared, not read** by this bench: the installed
 * host ships as a standalone binary and does not export its `ToolOutput` limits
 * as package data, so `hostReaderCapRecord` records the source as `declared` and
 * `readFromHost: false`. The fixture is built so that *if* the declared cut runs,
 * the unit tracker sees the host's truncated bytes, which are still above the
 * product's `barBytes` (512 since ADR-0051). The two reads of the same file return identical
 * host-truncated bytes, which is the `superseded-read` proof the lane checks on
 * the wire; the truncation order itself is an assumption this fixture is built
 * on, not a fact the run observes.
 *
 * **Why the file's sentinel is not the removal marker.** The superseding read
 * legitimately carries the same file bytes, so the file's sentinel survives in
 * the twin. A marker that a surviving copy carries names bytes, not the unit.
 * Each lane therefore declares `markerSentinels`, and each of those strings is
 * embedded in the corresponding unit's call id: the call id is the one string
 * only the removed unit holds, and the sentinel makes that uniqueness explicit
 * and checks it (`validateFixture` refuses a marker sentinel that is not part of
 * its unit call). The file sentinel stays as the positive control that the
 * oversized bytes reached the wire at all.
 *
 * **A call id alone is an identity marker, not a byte marker.** A host that
 * re-keys a call id on rebuild keeps the same result bytes under a new id, and
 * an id-only check would read that as a clean removal. A `stale-read` lane
 * therefore also declares `contentMarkers`: one string per unit, embedded in the
 * unit file's own pre-write body (`files[].markers`), absent from every tool
 * call's arguments, and therefore unique to the removed read — the twin reads
 * the rewritten file, whose 30-odd bytes do not carry it. The removal rule
 * requires every content marker absent from every measured request beside the
 * call id. On a `superseded-read` lane the twin legitimately carries the same
 * file bytes, so content cannot distinguish the removed read from its twin;
 * those lanes declare no content marker. Their byte-level half is a **count**:
 * in every measured request exactly one tool-result message may carry the unit
 * file's sentinel, so a re-keyed copy that keeps the bytes leaves two and fails.
 *
 * **The file sentinel is checked inside the twin's own result.** A stale-read
 * lane's write carries the bytes it wrote, so the same sentinel appears in the
 * write call's arguments. A body-wide twin scan would therefore let a request
 * that lost the twin read's result but kept the write call pass. `laneTwinResults`
 * names the sentinel per twin call, and the removal rule requires it inside the
 * tool-result message addressed to that call — nowhere else counts.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The reader cap the host applies to a produced tool result: 50 KiB. */
export const READER_CAP_BYTES = 50 * 1024;

/** The product's eligibility floor (ADR-0051): a tool result at or above this is one whole unit. */
export const PRODUCT_BAR_BYTES = 512;

/** Where the product bar is read from at launch. */
export const PRODUCT_BAR_SOURCE = '@cremator/core DEFAULT_CONFIG.protocol.barBytes';

/**
 * The product bar the launcher must find in core. The fixture's declaration and
 * this module's constant are the bench's own two copies; neither is evidence
 * that the product agrees, so the launcher imports core's `DEFAULT_CONFIG` and
 * refuses on a mismatch instead of measuring a bar the product does not use.
 * @param {unknown} value `DEFAULT_CONFIG.protocol.barBytes`
 * @param {number} [expected] the fixture constant
 * @returns {{ok: true, value: number, source: string} | {ok: false, refused: string}}
 */
export function checkProductBar(value, expected = PRODUCT_BAR_BYTES) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return {
      ok: false,
      refused: `the product's ${PRODUCT_BAR_SOURCE} is ${String(value)}; the launcher cannot `
        + 'read the bar it measures against',
    };
  }
  if (value !== expected) {
    return {
      ok: false,
      refused: `the product's ${PRODUCT_BAR_SOURCE} is ${String(value)}, but this bench declares `
        + `productBarBytes=${String(expected)} in its fixture; a run against a bar the product `
        + 'does not use would measure the wrong unit',
    };
  }
  return { ok: true, value, source: PRODUCT_BAR_SOURCE };
}

/**
 * The `@cremator/core` entry the mounted plugin directory itself resolves. A
 * `--allow-foreign-plugin` mount may sit beside a different core package than
 * the runner's own `node_modules`; resolving from the plugin's `package.json`
 * reads the build the adapter will actually import. The entry, its package.json
 * and (when the entry is a file) their hashes are recorded with the value.
 * @param {string} pluginDir
 * @returns {{entry: string, packageJsonPath: string, sha256: string|null,
 *   packageJsonSha256: string|null}}
 */
function resolveCoreFromPlugin(pluginDir) {
  const requireFromPlugin = createRequire(resolve(pluginDir, 'package.json'));
  const entry = requireFromPlugin.resolve('@cremator/core');
  let root = dirname(entry);
  let packageJsonPath = null;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(root, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        if (parsed?.name === '@cremator/core') {
          packageJsonPath = candidate;
          break;
        }
      } catch { /* keep walking: a parent manifest is not this package's */ }
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return {
    entry,
    packageJsonPath,
    sha256: existsSync(entry) ? createHash('sha256').update(readFileSync(entry)).digest('hex') : null,
    packageJsonSha256: packageJsonPath === null
      ? null : createHash('sha256').update(readFileSync(packageJsonPath)).digest('hex'),
  };
}

/**
 * Import the product's bar at launch, from the mounted plugin directory's own
 * resolution when one is given. A load failure is a named refusal, never a
 * skipped check: a bench that cannot read the product's own constant cannot
 * claim it measured the product's bar.
 * @param {string} [pluginDir] the plugin package the host mounts
 * @returns {Promise<{ok: true, value: number, source: string, resolution: object}
 *   | {ok: false, refused: string}>}
 */
export async function productBarAtLaunch(pluginDir = undefined) {
  try {
    const resolution = typeof pluginDir === 'string' && pluginDir.length > 0
      ? { ...resolveCoreFromPlugin(pluginDir), source: 'plugin package resolution' }
      : null;
    const core = resolution === null
      ? await import('@cremator/core')
      : await import(pathToFileURL(resolution.entry).href);
    const checked = checkProductBar(core?.DEFAULT_CONFIG?.protocol?.barBytes);
    return checked.ok === true ? { ...checked, resolution } : checked;
  } catch (error) {
    return {
      ok: false,
      refused: `the launcher could not import @cremator/core to read ${PRODUCT_BAR_SOURCE}: `
        + (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * The host reader cap this run used. The installed host ships as a standalone
 * binary and does not export its `ToolOutput` limits as package data, so the
 * launcher records the value as **declared, not read**: the declaration is the
 * fixture constant the world was built against, and no claim is made that the
 * installed package was queried. The fixture's own declaration is validated
 * against this constant at load (`validateFixture`).
 * @param {string|null} hostBin the resolved host binary, recorded beside the value
 */
export function hostReaderCapRecord(hostBin = null) {
  return {
    value: READER_CAP_BYTES,
    source: 'declared',
    readFromHost: false,
    declaredIn: 'dev/bench/opencode-removal-fixture.mjs READER_CAP_BYTES',
    hostBin,
    reason: 'the installed host ships a standalone binary; its ToolOutput cap is not exported '
      + 'as package data, so the launcher records the declared value and does not read it',
  };
}

/** A file the host truncates must be larger than its cap. */
export const MIN_FIXTURE_BYTES = READER_CAP_BYTES + 1;
/**
 * The smallest file that can be one product unit. A restore of a unit at or
 * above this and below the reader cap can reach the model whole, which is what
 * makes a byte-for-byte restore possible; a larger unit is freed by the host and
 * its restore comes back as a pointer (ISSUE-214 P1).
 */
export const MIN_UNIT_BYTES = PRODUCT_BAR_BYTES + 1;

/**
 * The proof rules a lane may claim. **The list is copied, not read**: these are
 * the rule ids `packages/core/src/rules/defaults.ts` registers on this adapter
 * when this bench was written, and nothing imports that file to compare. The
 * copy is pinned by a test (`opencode-removal-fixture.test.mjs` asserts the list
 * against the core rule ids it reads), and the runner fails by name when a
 * lane's declared rule produced no removal — so a drift shows up as a failed
 * run, not as a silent pass. A lane says which rule its removals must be
 * attributed to.
 */
export const LANE_RULES = Object.freeze(['superseded-read', 'stale-read']);

/** The rule a lane claims; a lane written before this field was `superseded-read`. */
export function laneRule(lane) {
  return typeof lane?.rule === 'string' && lane.rule.length > 0 ? lane.rule : 'superseded-read';
}

/** The filler line. Fixed text, so a file's bytes are a function of its size. */
const FILLER = 'racoons opencode fixture filler 0123456789 abcdefghijklmnopqrstuvwxyz\n';

/**
 * The bytes a fixture file holds: its sentinel first, then any declared
 * content markers, then filler to at least `file.bytes`. The sentinel and the
 * markers are on the first lines, inside the reader's head-only window, so they
 * reach the request the model is sent.
 * @param {{sentinel: string, bytes: number, markers?: string[]}} file
 * @returns {string}
 */
export function fixtureFileBytes(file) {
  const markers = Array.isArray(file.markers)
    ? file.markers.filter((marker) => typeof marker === 'string' && marker.length > 0)
    : [];
  const head = markers.length === 0
    ? `${file.sentinel}\n`
    : `${file.sentinel}\n${markers.join('\n')}\n`;
  const target = Math.max(Number(file.bytes), MIN_UNIT_BYTES);
  if (target <= head.length) return head;
  return head + FILLER.repeat(Math.ceil((target - head.length) / FILLER.length));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

/** A file name a bench may write: no separators, no traversal. */
function safeName(name) {
  return nonempty(name) && !/[\\/:]/u.test(name) && name !== '.' && name !== '..';
}

/** Every call a script's replies issue, with the turn that issued it. */
export function scriptCalls(script) {
  if (!isRecord(script) || !Array.isArray(script.replies)) return [];
  const calls = [];
  for (const entry of script.replies) {
    const turn = entry?.match?.main_turn;
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) continue;
    const list = Array.isArray(entry?.reply?.calls) ? entry.reply.calls : [];
    for (const call of list) {
      if (nonempty(call?.id) && nonempty(call?.name)) {
        calls.push({ id: call.id, name: call.name, turn, input: call.input ?? null });
      }
    }
  }
  return calls;
}

/**
 * Check a script's `fixture` block before anything is written. A malformed
 * fixture is refused by name; a bench that guesses at one would measure a world
 * it cannot describe.
 * @param {unknown} script
 * @returns {{ok: true, fixture: object} | {ok: false, refused: string}}
 */
export function validateFixture(script) {
  if (!isRecord(script)) return { ok: false, refused: 'the script is not an object' };
  const fixture = script.fixture;
  if (!isRecord(fixture)) return { ok: false, refused: 'the script carries no fixture block' };
  // The fixture states the constants it was built against; a drift between the
  // declaration and this module would make the world and the verdict describe
  // different bars. Refuse by name instead of measuring the mismatch.
  if (fixture.readerCapBytes !== READER_CAP_BYTES) {
    return {
      ok: false,
      refused: `fixture.readerCapBytes is ${String(fixture.readerCapBytes)}; `
        + `this bench's reader cap is ${String(READER_CAP_BYTES)}`,
    };
  }
  if (fixture.productBarBytes !== PRODUCT_BAR_BYTES) {
    return {
      ok: false,
      refused: `fixture.productBarBytes is ${String(fixture.productBarBytes)}; `
        + `this bench's product bar is ${String(PRODUCT_BAR_BYTES)}`,
    };
  }
  const files = fixture.files;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, refused: 'fixture.files must be a non-empty array' };
  }
  const names = new Set();
  const sentinels = new Set();
  for (const file of files) {
    if (!isRecord(file) || !safeName(file.name)) {
      return { ok: false, refused: `fixture file ${JSON.stringify(file?.name)} is not a safe file name` };
    }
    if (names.has(file.name)) return { ok: false, refused: `fixture file ${file.name} is named twice` };
    names.add(file.name);
    if (!nonempty(file.sentinel)) {
      return { ok: false, refused: `fixture file ${file.name} carries no sentinel` };
    }
    if (sentinels.has(file.sentinel)) {
      return { ok: false, refused: `sentinel ${JSON.stringify(file.sentinel)} is used twice` };
    }
    sentinels.add(file.sentinel);
    // Content markers are the byte-level half of a removal marker: a string
    // that only the pre-write body carries. They must be unique, must not repeat
    // a sentinel, and must sit inside the reader's head-only window, or the host
    // would truncate them before the request ever carried them.
    const markers = file.markers ?? [];
    if (!Array.isArray(markers)) {
      return { ok: false, refused: `fixture file ${file.name} markers must be an array` };
    }
    for (const marker of markers) {
      if (!nonempty(marker)) {
        return { ok: false, refused: `fixture file ${file.name} carries an empty content marker` };
      }
      if (markers.indexOf(marker) !== markers.lastIndexOf(marker)) {
        return { ok: false, refused: `fixture file ${file.name} declares marker ${JSON.stringify(marker)} twice` };
      }
      if (sentinels.has(marker)) {
        return {
          ok: false,
          refused: `fixture file ${file.name} reuses ${JSON.stringify(marker)} as a content marker and a `
            + 'sentinel; a marker that survives in the twin cannot prove the removed bytes left',
        };
      }
      const at = fixtureFileBytes(file).indexOf(`${marker}\n`);
      if (at < 0 || at + marker.length > READER_CAP_BYTES) {
        return {
          ok: false,
          refused: `fixture file ${file.name} marker ${JSON.stringify(marker)} is not inside the `
            + `${String(READER_CAP_BYTES)}-byte head the host keeps`,
        };
      }
      sentinels.add(marker);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < MIN_UNIT_BYTES) {
      return {
        ok: false,
        refused: `fixture file ${file.name} must be at least ${MIN_UNIT_BYTES} bytes `
          + `(the product's bar plus one); it declares ${String(file.bytes)}`,
      };
    }
  }
  const auxiliary = fixture.auxiliary ?? [];
  if (!Array.isArray(auxiliary)) return { ok: false, refused: 'fixture.auxiliary must be an array' };
  for (const file of auxiliary) {
    if (!isRecord(file) || !safeName(file.name) || !nonempty(file.text)) {
      return { ok: false, refused: `fixture auxiliary ${JSON.stringify(file?.name)} is not a named text file` };
    }
    if (names.has(file.name)) return { ok: false, refused: `fixture file ${file.name} is named twice` };
    names.add(file.name);
  }
  const lanes = fixture.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return { ok: false, refused: 'fixture.lanes must be a non-empty array' };
  }
  const issued = scriptCalls(script);
  const issuedIds = new Set(issued.map(call => call.id));
  const laneNames = new Set();
  for (const lane of lanes) {
    if (!isRecord(lane) || !nonempty(lane.name)) {
      return { ok: false, refused: 'a fixture lane carries no name' };
    }
    if (laneNames.has(lane.name)) return { ok: false, refused: `lane ${lane.name} is named twice` };
    laneNames.add(lane.name);
    const unitCalls = lane.unitCalls;
    const supersedingCalls = lane.supersedingCalls;
    const unitFiles = lane.unitFiles;
    const rule = laneRule(lane);
    if (!LANE_RULES.includes(rule)) {
      return {
        ok: false,
        refused: `lane ${lane.name} claims rule ${JSON.stringify(rule)}; this bench measures `
          + `${LANE_RULES.join(', ')}`,
      };
    }
    if (!Array.isArray(unitCalls) || unitCalls.length === 0) {
      return { ok: false, refused: `lane ${lane.name} names no unit calls` };
    }
    if (!Array.isArray(supersedingCalls) || supersedingCalls.length !== unitCalls.length) {
      return {
        ok: false,
        refused: `lane ${lane.name} must name one superseding call per unit call`,
      };
    }
    // The call whose result makes the removal provable: for a superseded read it
    // is the later read itself; for a stale read it is the write whose path the
    // read observed, and the later read is only the surviving twin.
    const triggerCalls = lane.triggerCalls ?? supersedingCalls;
    if (!Array.isArray(triggerCalls) || triggerCalls.length !== unitCalls.length) {
      return {
        ok: false,
        refused: `lane ${lane.name} must name one trigger call per unit call`,
      };
    }
    if (rule === 'stale-read' && lane.triggerCalls === undefined) {
      return {
        ok: false,
        refused: `lane ${lane.name} claims stale-read but names no triggerCalls; the write that `
          + 'makes the read stale is not the surviving read',
      };
    }
    if (!Array.isArray(unitFiles) || unitFiles.length !== unitCalls.length) {
      return { ok: false, refused: `lane ${lane.name} must name one file per unit call` };
    }
    const markerSentinels = lane.markerSentinels;
    if (!Array.isArray(markerSentinels) || markerSentinels.length !== unitCalls.length) {
      return {
        ok: false,
        refused: `lane ${lane.name} must name one marker sentinel per unit call`,
      };
    }
    for (const [index, sentinel] of markerSentinels.entries()) {
      if (!nonempty(sentinel)) {
        return { ok: false, refused: `lane ${lane.name} has an empty marker sentinel` };
      }
      if (!unitCalls[index].includes(sentinel)) {
        return {
          ok: false,
          refused: `lane ${lane.name} marker sentinel ${JSON.stringify(sentinel)} is not part of `
            + `its unit call ${unitCalls[index]}; the sentinel must name the unit, not its file bytes`,
        };
      }
    }
    // The byte-level half. A content marker is a string the unit file's own
    // pre-write body carries; no call argument may carry it, so it can only
    // reach the wire inside the removed read's result. A stale-read lane must
    // declare one: its first read is the only copy of those bytes, and without
    // a content marker a re-keyed call id would read as a clean removal.
    const contentMarkers = lane.contentMarkers ?? [];
    if (!Array.isArray(contentMarkers)) {
      return { ok: false, refused: `lane ${lane.name} contentMarkers must be an array` };
    }
    if (contentMarkers.length > 0 && contentMarkers.length !== unitCalls.length) {
      return {
        ok: false,
        refused: `lane ${lane.name} must name one content marker per unit call`,
      };
    }
    for (const [index, marker] of contentMarkers.entries()) {
      if (!nonempty(marker)) {
        return { ok: false, refused: `lane ${lane.name} has an empty content marker` };
      }
      if (unitCalls[index].includes(marker)) {
        return {
          ok: false,
          refused: `lane ${lane.name} content marker ${JSON.stringify(marker)} is part of its unit `
            + 'call id; a content marker must name bytes that only the removed result carries',
        };
      }
      const file = files.find((candidate) => candidate.name === unitFiles[index]);
      if (file === undefined || !Array.isArray(file.markers) || !file.markers.includes(marker)) {
        return {
          ok: false,
          refused: `lane ${lane.name} content marker ${JSON.stringify(marker)} is not declared in `
            + `${String(unitFiles[index])}.markers; the world would not carry the bytes it names`,
        };
      }
      const carrier = issued.find((call) => JSON.stringify(call.input ?? null).includes(marker));
      if (carrier !== undefined) {
        return {
          ok: false,
          refused: `lane ${lane.name} content marker ${JSON.stringify(marker)} appears in the `
            + `arguments of ${carrier.id}; a tool call's own bytes would survive the removal`,
        };
      }
    }
    if (rule === 'stale-read' && contentMarkers.length === 0) {
      return {
        ok: false,
        refused: `lane ${lane.name} claims stale-read but names no contentMarkers; the removed read's `
          + 'pre-write body is the only copy of a string the twin cannot carry, so without one the '
          + 'lane proves only that its call id left',
      };
    }
    for (const name of unitFiles) {
      if (!names.has(name)) return { ok: false, refused: `lane ${lane.name} names unknown file ${name}` };
    }
    for (const id of [...unitCalls, ...supersedingCalls, ...triggerCalls]) {
      if (!issuedIds.has(id)) {
        return { ok: false, refused: `lane ${lane.name} names call ${id}, which the script never issues` };
      }
    }
    const issueOf = id => issued.find(call => call.id === id);
    const unitTurns = new Set(unitCalls.map(id => issueOf(id).turn));
    if (unitTurns.size !== 1) {
      return { ok: false, refused: `lane ${lane.name} must issue its unit calls in one reply` };
    }
    const supersederTurns = new Set(supersedingCalls.map(id => issueOf(id).turn));
    if (supersederTurns.size !== 1) {
      return { ok: false, refused: `lane ${lane.name} must issue its superseding calls in one reply` };
    }
    const triggerTurns = new Set(triggerCalls.map(id => issueOf(id).turn));
    if (triggerTurns.size !== 1) {
      return { ok: false, refused: `lane ${lane.name} must issue its trigger calls in one reply` };
    }
    const unitTurn = [...unitTurns][0];
    const supersederTurn = [...supersederTurns][0];
    const triggerTurn = [...triggerTurns][0];
    if (!(unitTurn < triggerTurn)) {
      return {
        ok: false,
        refused: `lane ${lane.name} issues its unit calls at turn ${String(unitTurn)} and its `
          + `trigger calls at turn ${String(triggerTurn)}; the trigger must come later`,
      };
    }
    if (rule === 'superseded-read' && triggerTurn !== supersederTurn) {
      return {
        ok: false,
        refused: `lane ${lane.name} claims superseded-read but issues its trigger calls at turn `
          + `${String(triggerTurn)} and its twin at turn ${String(supersederTurn)}; on this rule `
          + 'the later read is both the trigger and the twin',
      };
    }
    if (rule === 'stale-read') {
      if (!(triggerTurn < supersederTurn)) {
        return {
          ok: false,
          refused: `lane ${lane.name} issues its write at turn ${String(triggerTurn)} and its `
            + `twin read at turn ${String(supersederTurn)}; the twin read must come after the write`,
        };
      }
      const notWrite = triggerCalls.filter(id => issueOf(id).name !== 'write');
      if (notWrite.length > 0) {
        return {
          ok: false,
          refused: `lane ${lane.name} claims stale-read but its trigger call(s) `
            + `${notWrite.join(', ')} are not write calls`,
        };
      }
      const notRead = supersedingCalls.filter(id => issueOf(id).name !== 'read');
      if (notRead.length > 0) {
        return {
          ok: false,
          refused: `lane ${lane.name} claims stale-read but its twin call(s) `
            + `${notRead.join(', ')} are not read calls`,
        };
      }
    }
  }
  return { ok: true, fixture };
}

/**
 * The main turns a lane's proof spans. A call's result lands before the next
 * request, so a trigger issued at request N is provable in request N+1.
 *
 *   - `superseded-read`: the later read is both the trigger (it makes the earlier
 *     copy redundant) and the surviving twin.
 *   - `stale-read`: the write is the trigger and the later read is the twin. The
 *     removed read is already absent when the write lands, so the measured window
 *     starts at `firstStableTurn` — the first request that carries the twin too.
 *     Before that the unit may be absent (and is checked wherever it is), but no
 *     request can prove the host did not drop the tail.
 * @param {object} lane
 * @param {unknown} script
 * @returns {{rule: string, unitTurn: number, triggerTurn: number, twinTurn: number,
 *   supersederTurn: number, firstRemovalTurn: number, firstStableTurn: number}}
 */
export function laneTurns(lane, script) {
  const issued = scriptCalls(script);
  const turnsOf = ids => new Set(ids.map(id => issued.find(call => call.id === id)?.turn));
  const unitTurns = [...turnsOf(lane.unitCalls)];
  const supersederTurns = [...turnsOf(lane.supersedingCalls)];
  const triggerTurns = [...turnsOf(lane.triggerCalls ?? lane.supersedingCalls)];
  if (unitTurns.length !== 1 || typeof unitTurns[0] !== 'number') {
    throw new Error(`lane ${lane.name} does not issue its unit calls in one reply`);
  }
  if (supersederTurns.length !== 1 || typeof supersederTurns[0] !== 'number') {
    throw new Error(`lane ${lane.name} does not issue its superseding calls in one reply`);
  }
  if (triggerTurns.length !== 1 || typeof triggerTurns[0] !== 'number') {
    throw new Error(`lane ${lane.name} does not issue its trigger calls in one reply`);
  }
  const firstRemovalTurn = triggerTurns[0] + 1;
  return {
    rule: laneRule(lane),
    unitTurn: unitTurns[0],
    triggerTurn: triggerTurns[0],
    twinTurn: supersederTurns[0],
    supersederTurn: supersederTurns[0],
    firstRemovalTurn,
    firstStableTurn: Math.max(firstRemovalTurn, supersederTurns[0] + 1),
  };
}

/**
 * Every marker of a lane's removed units: their call ids, the fixture's marker
 * sentinels and any content markers. A marker sentinel is embedded in its
 * unit's call id, so it names the unit's identity; a content marker is a string
 * only the removed result's bytes carry. The file sentinels are deliberately
 * not here: the twin carries those bytes. On a `superseded-read` lane there is
 * no content marker and the lane proves id-absence only.
 */
export function laneMarkers(fixture, lane) {
  return [
    ...lane.unitCalls,
    ...(lane.markerSentinels ?? []),
    ...(lane.contentMarkers ?? []),
  ].filter(name => typeof name === 'string' && name.length > 0);
}

/** The file sentinels a lane's units read; the positive control that the bytes were on the wire. */
export function laneFileSentinels(fixture, lane) {
  const sentinelByName = new Map(fixture.files.map(file => [file.name, file.sentinel]));
  return lane.unitFiles.map(name => sentinelByName.get(name))
    .filter(name => typeof name === 'string' && name.length > 0);
}

/**
 * Every marker the surviving twin must still carry anywhere in the body: its
 * call id (the call part). The file sentinel is not here: a stale-read lane's
 * write call legitimately carries the bytes it wrote, so a body-wide sentinel
 * scan cannot prove the twin's result survived. `laneTwinResults` scopes the
 * sentinel to the twin's own tool-result message.
 */
export function laneTwinMarkers(fixture, lane) {
  return lane.supersedingCalls.filter(name => typeof name === 'string' && name.length > 0);
}

/**
 * The surviving twin's own result requirements: for each twin call, the file
 * sentinel its result must carry. The removal rule requires each marker inside
 * the tool-result message addressed to that call id, not anywhere in the body.
 * @param {object} fixture
 * @param {object} lane
 * @returns {{callId: string, markers: string[]}[]}
 */
export function laneTwinResults(fixture, lane) {
  const sentinelByName = new Map(fixture.files.map(file => [file.name, file.sentinel]));
  return lane.supersedingCalls.map((callId, index) => {
    const sentinel = sentinelByName.get(lane.unitFiles[index]);
    return {
      callId,
      markers: typeof sentinel === 'string' && sentinel.length > 0 ? [sentinel] : [],
    };
  });
}

/** The unit-file records a lane reads, in call order. */
export function laneFiles(fixture, lane) {
  const byName = new Map(fixture.files.map(file => [file.name, file]));
  return lane.unitFiles.map(name => byName.get(name));
}

/**
 * Write every fixture file into the arm world's work directory. Returns the
 * written files with their absolute path, size and sha256, so the evidence says
 * what the world held and not only what it was meant to hold.
 * @param {string} workDir
 * @param {{files: {name: string, sentinel: string, bytes: number}[]}} fixture
 */
export function writeFixtureWorld(workDir, fixture) {
  const written = [];
  mkdirSync(workDir, { recursive: true });
  for (const file of fixture.files) {
    const text = fixtureFileBytes(file);
    const path = join(workDir, file.name);
    writeFileSync(path, text, 'utf8');
    written.push({
      name: file.name,
      path,
      declaredBytes: file.bytes,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      sentinel: file.sentinel,
      markers: Array.isArray(file.markers) ? [...file.markers] : [],
      aboveReaderCap: Buffer.byteLength(text, 'utf8') > READER_CAP_BYTES,
    });
  }
  for (const file of fixture.auxiliary ?? []) {
    const path = join(workDir, file.name);
    writeFileSync(path, file.text, 'utf8');
    written.push({
      name: file.name,
      path,
      declaredBytes: Buffer.byteLength(file.text, 'utf8'),
      bytes: Buffer.byteLength(file.text, 'utf8'),
      sha256: createHash('sha256').update(file.text, 'utf8').digest('hex'),
      sentinel: null,
      aboveReaderCap: false,
    });
  }
  return written;
}

/** Replace `{{WORK}}` in every string of a parsed script; return a new object. */
export function renderScript(script, workDir) {
  const replacement = workDir.replace(/\\/gu, '/');
  const walk = (value) => {
    if (typeof value === 'string') return value.split('{{WORK}}').join(replacement);
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value)) {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      return out;
    }
    return value;
  };
  return walk(script);
}

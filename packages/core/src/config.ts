import type { DedupeClasses } from "./prune/dedupe/types.js";

export interface Thresholds {
  /**
   * Accepted and ignored. ADR-0014 (2026-10-23) scrapped the entry-time cap:
   * nothing reads these fields. They stay in the type and in `DEFAULT_CONFIG`
   * so an old config file that names them still loads and mounts; validation
   * never rejects their values.
   */
  readonly capBytes: number;
  /** Accepted and ignored; see `capBytes` (ADR-0014, 2026-10-23). */
  readonly capHeadBytes: number | null;
  readonly episodeNoNewPathSteps: number | null;
  readonly sealMaxLatencyTurns: 0 | 1;
}

export interface FreshZoneConfig {
  readonly maxNodes: number | null;
  readonly maxBytes: number | null;
}

/**
 * The two arms a host config row may name for the retired anchor A/B switch.
 * The arm belonged to the removed judge pass; an entry checkpoint renders its
 * anchors unconditionally (ADR-0028), so a mount accepts the key and reads
 * nothing from it. The type stays exported because the host-facing config row
 * still declares it, and a config file must never crash a mount.
 */
export type AnchorMode = "off" | "on";

/**
 * What the engine does with a settled verdict batch. `apply` plans the revert;
 * only the exact value `record-only` takes the agent's answers and applies
 * nothing. Enforcement defaults to `apply` for configs that omit the field:
 * the owner accepted the measured precision (spike-008 §5) as good enough to
 * ship and adopted no numeric bar (owner ruling 2026-10-23).
 */
export type ProtocolEnforcement = "record-only" | "apply";

/**
 * The verdict protocol's tuning values. PRD §3.7 and H-011 keep every number
 * here as configuration: defaults are provisional until measurement lands them.
 */
export interface ProtocolConfig {
  /** Size at or above which a processing unit must receive a verdict. */
  readonly barBytes: number;
  /** Smallest freed-byte payoff a revert cut must reach to be worth applying. */
  readonly minCutFreedBytes: number;
  /**
   * Enforcement mode. Absent means `apply`: the safe-for-progress value.
   * `record-only` is the opt-out and must be written explicitly.
   */
  readonly enforcement?: ProtocolEnforcement;
  /**
   * The superseded-read dedupe pass's per-class switches (ADR-0037 decision 6;
   * ISSUE-145). Absent means every class is off, which is the shipped state: a
   * config that omits this key plans exactly the prune it planned before the
   * pass existed. No class ships on by default, and class 4 is out of this
   * record's scope entirely.
   */
  readonly dedupe?: DedupeConfig;
}

/** The dedupe pass's switches; `classes` is the only knob it reads. */
export interface DedupeConfig {
  /** Per-class switch; absent or false plans nothing for that class. */
  readonly classes?: DedupeClasses;
}

/** How the batched entry ask chooses when to fire (ISSUE-128). */
export type EntryAskTriggerMode = "count" | "landed-bytes";

/**
 * The entry ask's trigger, declared as one object so a mode and its number
 * travel together (ISSUE-128, the live run's configuration). `count` is today's
 * cadence and reads `entryAskBatchSize`; `landed-bytes` fires when the eligible
 * results' own bytes landed since the last fire reach `bytes`.
 */
export interface EntryAskTriggerConfig {
  readonly mode: EntryAskTriggerMode;
  /**
   * Landed bytes that fire one ask. Required in `landed-bytes` mode: a trigger
   * with no threshold would never fire and never say why.
   */
  readonly bytes?: number;
}

/**
 * The answer grammar the batched entry ask states (ISSUE-129; ISSUE-183; the
 * live run's configuration). `jsonl-20` is the shipped default (owner ruling
 * 2026-11-05): one JSON object per row per line, so a malformed line refuses
 * that row only. `3option` is the original contract, byte for byte, and stays
 * selectable by name; `two-option` has no line-level option: a row is
 * `{"keepall":true}` or `{"forgetall":"…"}`, and a row that names lines is
 * refused and keeps. `jsonl-20-nokeepall` is `jsonl-20` with `keepall`
 * removed: a row answers `forgetall` or `keeplines`, and a whole row is kept as
 * a full-range `keeplines` with summary `None`.
 */
export type EntryAskGrammar = "3option" | "two-option" | "jsonl-20" | "jsonl-20-nokeepall";

/**
 * The bulk prune ask's answer grammar. `nokeepall` is the shipped default
 * (ADR-0056): it offers only `forgetall` and `keeplines`, and a whole unit is
 * kept as a `keeplines` over its whole range with summary `None`. `3option`,
 * the original contract byte for byte, stays selectable by name.
 */
export type PruneAskGrammar = "3option" | "nokeepall";

/**
 * The grammar a prune plan's label carries (ISSUE-522). The bulk grammars above
 * plus the entry contract's own two-verdict spelling, `jsonl-20-nokeepall`: an
 * adapter whose table prompt IS that entry message labels its plan with it, so
 * the label names the grammar the ask actually stated. It is a label, not a new
 * answer shape — `isTwoVerdictGrammar` decides the gate for every spelling.
 */
export type PrunePlanGrammar = PruneAskGrammar | "jsonl-20-nokeepall";

export interface RacoonsConfig {
  readonly thresholds: Thresholds;
  readonly freshZone: FreshZoneConfig;
  readonly sealMode: "append" | "replace";
  readonly validationFailureLimit: 2;
  readonly protocol: ProtocolConfig;
  /**
   * The size floor in bytes (ADR-0020 Decision 3): a tool result under it lands
   * whole and is never a candidate. Absent means `DEFAULT_CONFIG.floorBytes`;
   * a per-model table (`floorForModel`) overrides it where the mount sees the
   * model id. It is not `protocol.barBytes`, which keeps the bulk-pass job.
   */
  readonly floorBytes?: number;
  /**
   * Eligible results per batched entry ask (ADR-0035 §3): a positive safe
   * integer. Absent or `1` is today's cadence — every eligible result is asked
   * immediately, one ask each — and `1` is the shipped default. `3`, `6` and
   * `12` are arm measurement values, never defaults; a batch that never fills
   * is carried and never asked, so its units keep (ADR-0035 §6).
   */
  readonly entryAskBatchSize?: number;
  /**
   * What fires the batched entry ask (ISSUE-128; the live run's configuration).
   * Absent is `count`: `entryAskBatchSize` governs and the ask stream is today's,
   * byte for byte. `landed-bytes` sums the eligible results' own bytes since the
   * last fire — a monotone accumulator no prune can lower — and fires the whole
   * pending stream when the sum reaches `bytes`, which is then required. The
   * count knob is unread in that mode.
   */
  readonly entryAskTrigger?: EntryAskTriggerConfig;
  /**
   * The answer grammar the batched entry ask states (ISSUE-129; ISSUE-183; the
   * live run's configuration). Absent is `jsonl-20`, the shipped default (owner
   * ruling 2026-11-05) and the value `DEFAULT_CONFIG` carries: one JSON object
   * per row per line, with a summary beside the action key; a malformed line
   * refuses that row only. `3option`, the original contract, and `two-option`
   * stay selectable by name. `two-option` asks for `{"keepall":true}` or
   * `{"forgetall":"…"}` per row and has no line-level option: a row that names
   * lines is a refused row that keeps, and no range can be wrong, so the one
   * correction turn is unreachable on this grammar. `jsonl-20-nokeepall` is
   * `jsonl-20` without `keepall`: `forgetall` or `keeplines` per row, and a
   * whole row is a full-range `keeplines` with summary `None`.
   */
  readonly entryAskGrammar?: EntryAskGrammar;
  /**
   * The bulk prune ask's answer grammar. Absent is `nokeepall`, the shipped
   * default (ADR-0056): it offers only `forgetall` and `keeplines`, and a whole
   * unit is kept as a `keeplines` over its whole range with summary `None`.
   * `3option`, the original contract byte for byte, stays selectable by name.
   * `jsonl-20-nokeepall` is accepted too (ISSUE-522): it is the entry message's
   * spelling of the same two-verdict contract, so a host that names it gets the
   * entry asset and the two-verdict gate.
   */
  readonly pruneAskGrammar?: PrunePlanGrammar;
}

/** The default size floor: the calibration note's average of its nine rows. */
export const DEFAULT_FLOOR_BYTES = 512;

/**
 * Per-model size floors, in bytes (authority:
 * `docs/research/floor-calibration-2026-10-26.md` §6).
 */
export const FLOOR_BYTES_BY_MODEL: Readonly<Record<string, number>> = Object.freeze({
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
});

/**
 * The size floor for one model id: the table's exact entry, else the default
 * (authority: `docs/research/floor-calibration-2026-10-26.md` §6).
 */
export function floorForModel(model: string | null | undefined): number {
  if (typeof model !== "string" || !Object.hasOwn(FLOOR_BYTES_BY_MODEL, model)) {
    return DEFAULT_FLOOR_BYTES;
  }
  return FLOOR_BYTES_BY_MODEL[model] ?? DEFAULT_FLOOR_BYTES;
}

export const DEFAULT_CONFIG: RacoonsConfig = {
  thresholds: {
    capBytes: 8 * 1024,
    capHeadBytes: null,
    episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
  },
  freshZone: {
    maxNodes: null,
    maxBytes: null,
  },
  sealMode: "append",
  validationFailureLimit: 2,
  // ADR-0020 Decision 3: the measured default, not a provisional guess
  // (`docs/research/floor-calibration-2026-10-26.md` §6).
  floorBytes: DEFAULT_FLOOR_BYTES,
  // ADR-0035 §3, §8: batched entry asks ship off. `1` is today's per-result
  // cadence; the arm values 3/6/12 live in a launch row, never here.
  entryAskBatchSize: 1,
  // Owner ruling 2026-11-05: `jsonl-20` is the default answer format the model
  // is asked for. The other ids stay selectable by name.
  entryAskGrammar: "jsonl-20",
  // ADR-0056: the bulk prune ask ships the two-option contract; `3option` stays
  // selectable by name.
  pruneAskGrammar: "nokeepall",
  // Provisional (H-011): measurement sets these.
  protocol: {
    // Owner ruling 2026-11-08 (ADR-0051): the eligibility floor is 512 bytes;
    // the 8,192-byte minimum is removed.
    barBytes: 512,
    minCutFreedBytes: 4096,
    // Owner ruling 2026-10-23: measured precision accepted, no numeric bar
    // adopted; a wired verdict source applies by default (ADR-0008).
    enforcement: "apply",
  },
};

export function validateConfig(config: unknown): string[] {
  if (!isRecord(config)) return ["config must be an object."];
  const problems: string[] = [];
  const thresholds = config["thresholds"];
  if (!isRecord(thresholds)) {
    problems.push("thresholds must be an object.");
  } else {
    // ADR-0014 (2026-10-23): the entry-time cap is scrapped. `capBytes` and
    // `capHeadBytes` are accepted-and-ignored, not validated: an old config file
    // naming them must never crash a mount, and no value of theirs has meaning.
    checkCount(problems, "thresholds.episodeNoNewPathSteps", thresholds["episodeNoNewPathSteps"], true);
    if (thresholds["sealMaxLatencyTurns"] !== 0 && thresholds["sealMaxLatencyTurns"] !== 1) {
      problems.push("thresholds.sealMaxLatencyTurns must be 0 or 1.");
    }
  }

  const freshZone = config["freshZone"];
  if (!isRecord(freshZone)) {
    problems.push("freshZone must be an object.");
  } else {
    checkCount(problems, "freshZone.maxNodes", freshZone["maxNodes"], true);
    checkCount(problems, "freshZone.maxBytes", freshZone["maxBytes"], true);
  }
  if (config["sealMode"] !== "append" && config["sealMode"] !== "replace") {
    problems.push('sealMode must be "append" or "replace".');
  }
  if (config["validationFailureLimit"] !== 2) {
    problems.push("validationFailureLimit must be 2.");
  }
  // ADR-0020 Decision 3: the size floor is optional (the default is 512) but a
  // declared value must be a positive integer; zero would floor nothing.
  if (config["floorBytes"] !== undefined) {
    checkPositiveCount(problems, "floorBytes", config["floorBytes"]);
  }
  // ADR-0035 §3: the batch knob is optional (the default is 1) but a declared
  // value must be a positive integer; zero would never fire an ask.
  if (config["entryAskBatchSize"] !== undefined) {
    checkPositiveCount(problems, "entryAskBatchSize", config["entryAskBatchSize"]);
  }
  // ISSUE-128: the trigger is optional (absent = count mode, today's cadence). A
  // `landed-bytes` mode without a threshold never fires, so the number is
  // required there; a count mode may carry one harmlessly and it must still count.
  if (config["entryAskTrigger"] !== undefined) {
    const trigger = config["entryAskTrigger"];
    if (!isRecord(trigger)) {
      problems.push("entryAskTrigger must be an object.");
    } else {
      const mode = trigger["mode"];
      if (mode !== "count" && mode !== "landed-bytes") {
        problems.push('entryAskTrigger.mode must be "count" or "landed-bytes".');
      }
      if (mode === "landed-bytes" || trigger["bytes"] !== undefined) {
        checkPositiveCount(problems, "entryAskTrigger.bytes", trigger["bytes"]);
      }
    }
  }
  // ISSUE-129: the grammar is optional (absent resolves to `jsonl-20`, the
  // shipped default, where a config is built from defaults; owner ruling
  // 2026-11-05). A declared value must be one the batch ask can render and read
  // (ISSUE-183 adds `jsonl-20`; ISSUE-221's variant adds `jsonl-20-nokeepall`).
  if (config["entryAskGrammar"] !== undefined) {
    const grammar = config["entryAskGrammar"];
    if (grammar !== "3option" && grammar !== "two-option" && grammar !== "jsonl-20"
      && grammar !== "jsonl-20-nokeepall") {
      problems.push(
        'entryAskGrammar must be "3option", "two-option", "jsonl-20" or "jsonl-20-nokeepall"'
          + " when declared.",
      );
    }
  }
  // The bulk ask's grammar is optional (absent is `3option`); a declared value
  // must be one this build can render and read. `jsonl-20-nokeepall` names the
  // entry asset for the same two-verdict contract (ISSUE-522).
  if (config["pruneAskGrammar"] !== undefined) {
    const grammar = config["pruneAskGrammar"];
    if (grammar !== "3option" && grammar !== "nokeepall"
      && grammar !== "jsonl-20-nokeepall") {
      problems.push('pruneAskGrammar must be "3option", "nokeepall" or '
        + '"jsonl-20-nokeepall" when declared.');
    }
  }
  // Optional with a default: absent is valid, a declared value must be a count.
  const protocol = config["protocol"];
  if (!isRecord(protocol)) {
    problems.push("protocol must be an object.");
  } else {
    checkCount(problems, "protocol.barBytes", protocol["barBytes"], false);
    checkCount(problems, "protocol.minCutFreedBytes", protocol["minCutFreedBytes"], false);
    const enforcement = protocol["enforcement"];
    if (enforcement !== undefined && enforcement !== "record-only" && enforcement !== "apply") {
      problems.push('protocol.enforcement must be "record-only" or "apply" when declared.');
    }
    checkDedupe(problems, protocol["dedupe"]);
  }
  return problems;
}

/**
 * The dedupe switches (ADR-0037 decision 6; ISSUE-145; ISSUE-151). Absent is
 * every class off, which is the shipped state and why no default is written into
 * `DEFAULT_CONFIG`. A declared class must be a boolean, and a class this build
 * does not ship is refused BY NAME: a switch that silently plans nothing would
 * read as "on" in a launch row while removing nothing.
 *
 * This build ships class 2 (`supersededByReread`) and class 1's exact-echo
 * subset (`callEcho`). Class 3 and class 4 are declared in the type for later
 * phases and are refused here until each one's probe closes.
 */
function checkDedupe(problems: string[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    problems.push("protocol.dedupe must be an object.");
    return;
  }
  const classes = value["classes"];
  if (classes === undefined) return;
  if (!isRecord(classes)) {
    problems.push("protocol.dedupe.classes must be an object.");
    return;
  }
  for (const [name, flag] of Object.entries(classes)) {
    if (name !== "supersededByReread" && name !== "callEcho") {
      problems.push(`protocol.dedupe.classes.${name} is not a class this build ships.`);
      continue;
    }
    if (typeof flag !== "boolean") {
      problems.push(`protocol.dedupe.classes.${name} must be a boolean.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkCount(
  problems: string[],
  name: string,
  value: unknown,
  nullable: boolean,
): void {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    problems.push(`${name} must be a non-negative safe integer${nullable ? " or null" : ""}.`);
  }
}

/** A limit of zero would advertise a label the agent cannot write. */
function checkPositiveCount(problems: string[], name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    problems.push(`${name} must be a positive safe integer.`);
  }
}

#!/usr/bin/env node
/**
 * The synthetic source database for the opencode replay bench.
 *
 * `opencode-run.mjs` replays one session out of a source host database
 * (`seedSessionDb`). No evidence-grade source may be committed: the real session
 * on the owner's machine is private work. This builder writes a source with the
 * shapes that function reads, and nothing else.
 *
 * Usage:
 *   node dev/bench/opencode-fixture-build.mjs [--out <dir>] [--force] [--seed <int>]
 *   node dev/bench/opencode-fixture-build.mjs --verify [--out <dir>]
 *
 * It writes `replay.db` and `manifest.json` under
 * `dev/bench/fixtures/opencode/` by default. `--verify` recomputes the manifest
 * from the database and exits 1 on any difference.
 *
 * Determinism: fixed ids, fixed timestamps, and a seeded PRNG for the filler
 * bytes only. No clock, no network, no dependency on the machine's global
 * opencode database. Two default builds are byte-identical.
 *
 * The DDL is the installed opencode 2.2.5 schema (read from the host binary's
 * own schema strings), consolidated to its post-migration columns. Foreign keys
 * that point at the legacy `session` table are omitted: `session` is not in
 * `seedSessionDb`'s copy lists, so the fixture does not create it.
 *
 * **Stored shapes are load-bearing, not cosmetic.** The host brands ids
 * (`ses_`/`msg_` + 26 alphanumerics) and decodes every stored message through
 * those brands. A stored tool part must **not** carry `executed: true`: the real
 * host never writes that key, and with it the decoder hands the OpenAI-compatible
 * adapter a `tool-result` inside an assistant message, which it refuses
 * ("assistant messages only support text, reasoning, and tool-call content").
 * `analyzeFixture` measures both, and `assertShape` gates both.
 *
 * Exit: 0 = written or verified; 1 = verify mismatch; 2 = bad argument, a
 * refused overwrite, or a failed shape invariant.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { fixtureFileBytes } from './opencode-removal-fixture.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_OUT = join(HERE, 'fixtures', 'opencode');
const DB_FILE = 'replay.db';
const MANIFEST_FILE = 'manifest.json';
const SCHEMA = 'cremator-opencode-replay-fixture/1';
const MARKER = 'RACOONS-SYNTHETIC';
/**
 * The host brands a session id `ses_` + `Identifier.descending()`: 26 alphanumeric
 * characters (`@opencode/schema/dist/identifier.js`, `session-id.js`). The old
 * `RACOONS-SYNTHETIC-SESSION-0001` was refused with
 * `Expected a string starting with "ses"`. Still synthetic, still fixed.
 */
const SESSION_ID = 'ses_RAC00NS5YNTH3T1C0000000000';
/** The brand the host enforces: `ses_` then 26 alphanumeric characters. */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{26}$/u;
/** The message brand the host enforces: `msg_` then 26 alphanumerics. */
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{26}$/u;
/** The `workspace` columns the installed host queries, in its own order. */
const WORKSPACE_COLUMNS = Object.freeze(['id', 'provider', 'binding', 'created_at', 'last_used_at']);
const PROJECT_ID = `${MARKER}-PROJECT-0001`;
/**
 * The model the mock route runs (`opencode-run.mjs` composes `mock/mock-model`).
 * The host rewrites `session_v2.model` when it resumes a session under a
 * different model; seeding the same model the run uses keeps the seeded row
 * byte-identical after the run.
 */
const MODEL_ID = 'mock-model';
const PROVIDER_ID = 'mock';
const MODEL_SELECTOR = `${PROVIDER_ID}/${MODEL_ID}`;
/**
 * `session_v2.model` is a JSON column (`Session.Info.model` in
 * `@opencode/schema/dist/session.d.ts`): `{id, providerID, variant}`. The host
 * writes `{"id":..., "providerID":...}` when it continues a session; a bare
 * `provider/model` string is refused by its JSON parse.
 */
const MODEL_JSON = JSON.stringify({ id: MODEL_ID, providerID: PROVIDER_ID });
const WORKSPACE = 'C:\\RACOONS-SYNTHETIC\\workspace';
const REPEAT_PATH = `${WORKSPACE}\\repeat.txt`;
/**
 * The superseded-read lane's unit file. Its seeded tool result is the installed
 * host's own read rendering of this file, so a live re-read of the same path is
 * byte-identical and the product's exact-byte `superseded-read` proof holds.
 * The earlier seed was raw sentinel text; a live read carries the host's
 * `Read file <path>, lines 1-N` header and numbered lines, so the two never
 * matched and nothing was ever superseded.
 */
export const UNIT_FILE = 'big-b.log';
/** The unit file's byte size: the sentinel line plus 299 filler lines. */
export const UNIT_FILE_BYTES = 20_962;

/** A file stem with every run of non-alphanumerics collapsed: `BIG-B`. */
function fixtureStem(name) {
  return String(name).replace(/\.[^.]*$/u, '').replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '').toUpperCase();
}

/** The unit file's first line; the script declares the same sentinel. */
export function fixtureUnitSentinel(name = UNIT_FILE) {
  return `RACOONS-FIXTURE-UNIT-${fixtureStem(name)}-0001`;
}

/**
 * The exact bytes `writeFixtureWorld` writes for the unit file. Both the seed
 * and the run's world call `fixtureFileBytes` with the same `{name, sentinel,
 * bytes}`, so the file a live read sees is the file this seed describes.
 */
export function fixtureUnitFileText(name = UNIT_FILE, bytes = UNIT_FILE_BYTES) {
  return fixtureFileBytes({ name, sentinel: fixtureUnitSentinel(name), bytes });
}

/**
 * The installed host's read rendering (`ReadTool`, 2.2.5), replicated
 * byte-for-byte: the header `Read file <path>, lines <first>-<last>`, then one
 * `<n>: <line>` per line. The host strips exactly one trailing newline, splits
 * on `\n`, and numbers from the read's offset (1 for a whole-file read). A
 * seeded result that is merely "the file's text" is not what a re-read holds.
 */
export function hostReadText(path, text) {
  const lines = text.replace(/\n$/u, '').split('\n');
  const head = lines.length === 0
    ? `Read file ${path}, 0 lines`
    : `Read file ${path}, lines 1-${lines.length}`;
  return [head, ...lines.map((line, index) => `${index + 1}: ${line}`)].join('\n');
}

/** The seeded unit result: the host's whole-file read of the fixture file. */
export function fixtureUnitResultText(path = `${WORKSPACE}\\${UNIT_FILE}`) {
  return hostReadText(path, fixtureUnitFileText());
}
const BASE_TIME = 1_760_000_000_000;
/**
 * The session ends on a user turn. A host resuming a session whose last row is
 * an assistant message appends its own turns after that seeded answer, so the
 * seeded answer stays the last assistant text on stdout and the run's answer is
 * not the final text. Ending on a user turn makes the host's appended rows sort
 * after the whole seeded history. 63 user turns and 61 assistant turns keep the
 * message count at the same 124 the fixture has always declared.
 */
const USER_TURNS = 63;
const ASSISTANT_TURNS = 61;
/**
 * The old 8,192-byte floor this shipped fixture was built to clear. It is the
 * fixture's measurement parameter, not a product default (ADR-0051).
 */
const TOOL_RESULT_FLOOR = 8_192;
const DEFAULT_SEED = 20_261_107;

/** The 2.2.5 migration ids the host records as applied. Schema metadata only. */
const MIGRATION_IDS = Object.freeze(`
20260127222353_familiar_lady_ursula
20260211171708_add_project_commands
20260213144116_wakeful_the_professor
20260225215848_workspace
20260227213759_add_session_workspace_id
20260228203230_blue_harpoon
20260303231226_add_workspace_fields
20260309230000_move_org_to_state
20260312043431_session_message_cursor
20260323234822_events
20260410174513_workspace-name
20260413175956_chief_energizer
20260423070820_add_icon_url_override
20260427172553_slow_nightmare
20260428004200_add_session_path
20260501142318_next_venus
20260504145000_add_sync_owner
20260507164347_add_workspace_time
20260510033149_session_usage
20260511000411_data_migration_state
20260511173437_session-metadata
20260601010001_normalize_storage_paths
20260601202201_amazing_prowler
20260602002951_lowly_union_jack
20260602182828_add_project_directories
20260603001617_session_message_projection_indexes
20260603040000_session_message_projection_order
20260603141458_session_input_inbox
20260603160727_jittery_ezekiel_stane
20260604172448_event_sourced_session_input
20260605003541_add_session_context_snapshot
20260605042240_add_context_epoch_agent
20260611035744_credential
20260611192811_lush_chimera
20260612174303_project_dir_strategy
20260622142730_simplify_session_context_epoch
20260622170816_reset_v2_session_state
20260622202450_simplify_session_input
20260730195856_optional_session_title
20260804233008_loose_psylocke
20260805200742_import_legacy_credentials
20260808023530_workspace_domain
20260811161259_execution_claim_attempts
20260812181746_session_inbox
20260812213948_worktree
20260819222447_session_viewed_state
20260823191254_nullable_workspace_binding
20260910120000_clear_v1_session_permission
20260923013825_project_time_active
20261007190000_azure_cli_external_credential
20261010180456_project_time_archived
20261024002554_session_allowance
20261024175301_drop_session_allowance
20261025123711_blob
20261025154125_drop_session_pending
20261026223005_schedule
20261029002625_session_part
20261029073502_session_time_busy
20261029165540_schedule_checks
20261030054400_job
`.trim().split(/\r?\n/u));

/**
 * The tables `seedSessionDb`'s copy lists name (17), plus the `workspace`
 * bookkeeping table the host opens every database with (18), parent-first.
 */
const DDL = Object.freeze([
  `CREATE TABLE \`project\` (
    \`id\` text PRIMARY KEY,
    \`worktree\` text NOT NULL,
    \`vcs\` text,
    \`name\` text,
    \`icon_url\` text,
    \`icon_color\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`time_initialized\` integer,
    \`sandboxes\` text NOT NULL,
    \`commands\` text,
    \`icon_url_override\` text,
    \`time_active\` integer DEFAULT 0 NOT NULL,
    \`time_archived\` integer
  )`,
  `CREATE TABLE \`project_directory\` (
    \`project_id\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`type\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`strategy\` text,
    CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
    CONSTRAINT \`fk_project_directory_project_id\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`worktree\` (
    \`project_id\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`strategy\` text,
    \`time_created\` integer NOT NULL,
    CONSTRAINT \`worktree_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
    CONSTRAINT \`fk_worktree_project_id\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  // The installed host runs its migration bookkeeping over this table on open;
  // without it every open failed with `SQLiteError: no such table: workspace`.
  // Columns are the host's own (`sqlite_master` of a 2.2.5 database). No row is
  // seeded: the replayed session's `workspace_id` is NULL.
  `CREATE TABLE \`workspace\` (
    \`id\` text PRIMARY KEY,
    \`provider\` text NOT NULL,
    \`binding\` text,
    \`created_at\` integer NOT NULL,
    \`last_used_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`session_v2\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`workspace_id\` text,
    \`parent_id\` text,
    \`fork_session_id\` text,
    \`fork_boundary\` text,
    \`slug\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`path\` text,
    \`title\` text,
    \`version\` text NOT NULL,
    \`share_url\` text,
    \`summary_additions\` integer,
    \`summary_deletions\` integer,
    \`summary_files\` integer,
    \`summary_diffs\` text,
    \`metadata\` text,
    \`cost\` real DEFAULT 0 NOT NULL,
    \`tokens_input\` integer DEFAULT 0 NOT NULL,
    \`tokens_output\` integer DEFAULT 0 NOT NULL,
    \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
    \`revert\` text,
    \`permission\` text,
    \`agent\` text,
    \`model\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`time_busy\` integer,
    \`time_idle\` integer,
    \`time_viewed\` integer,
    \`idle_outcome\` text,
    \`time_compacting\` integer,
    \`time_archived\` integer,
    \`time_suspended\` integer,
    \`resume_attempts\` integer DEFAULT 0 NOT NULL,
    CONSTRAINT \`fk_session_v2_project_id\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`session_message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    \`seq\` integer NOT NULL
  )`,
  `CREATE TABLE \`session_part\` (
    \`message_id\` text NOT NULL,
    \`session_id\` text NOT NULL,
    \`ordinal\` integer NOT NULL,
    \`type\` text NOT NULL,
    \`call_id\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`session_part_pk\` PRIMARY KEY(\`message_id\`, \`ordinal\`),
    CONSTRAINT \`fk_session_part_message_id\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_session_part_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL
  )`,
  `CREATE TABLE \`part\` (
    \`id\` text PRIMARY KEY,
    \`message_id\` text NOT NULL,
    \`session_id\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_part_message_id\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`todo\` (
    \`session_id\` text NOT NULL,
    \`content\` text NOT NULL,
    \`status\` text NOT NULL,
    \`priority\` text NOT NULL,
    \`position\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`)
  )`,
  `CREATE TABLE \`session_inbox\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`payload\` text NOT NULL,
    \`delivery\` text NOT NULL,
    \`enqueued_seq\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    CONSTRAINT \`fk_session_inbox_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`event_sequence\` (
    \`aggregate_id\` text PRIMARY KEY,
    \`seq\` integer NOT NULL,
    \`owner_id\` text
  )`,
  `CREATE TABLE \`event\` (
    \`id\` text PRIMARY KEY,
    \`aggregate_id\` text NOT NULL,
    \`seq\` integer NOT NULL,
    \`type\` text NOT NULL,
    \`data\` text NOT NULL,
    \`created\` integer DEFAULT 0 NOT NULL,
    CONSTRAINT \`fk_event_aggregate_id\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`job\` (
    \`notification_id\` text PRIMARY KEY,
    \`id\` text NOT NULL,
    \`session_id\` text NOT NULL,
    \`child_session_id\` text,
    \`kind\` text NOT NULL,
    \`title\` text,
    \`status\` text NOT NULL,
    \`output\` text,
    \`error\` text,
    \`recovery\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`,
  `CREATE TABLE \`schedule\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text,
    \`name\` text,
    \`action\` text NOT NULL,
    \`when\` text NOT NULL,
    \`tz\` text NOT NULL,
    \`status\` text DEFAULT 'active' NOT NULL,
    \`next_due_at\` integer,
    \`ends_at\` integer,
    \`remaining_runs\` integer,
    \`run_count\` integer DEFAULT 0 NOT NULL,
    \`last_fired_at\` integer,
    \`last_message_id\` text,
    \`last_outcome\` text,
    \`retry_at\` integer,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`check\` text,
    \`checks\` integer DEFAULT 0 NOT NULL,
    \`failures\` integer DEFAULT 0 NOT NULL,
    \`state\` text,
    CONSTRAINT \`fk_schedule_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  // The installed host opens a database with its whole plugin set, and those
  // plugins query tables the replay copy lists do not name: the provider plugin
  // read `credential` and failed the open with `no such table: credential`.
  // These tables are part of the 2.2.5 schema (`sqlite_master` of a real host
  // database), carry no rows here, and are not copied by `seedSessionDb` — the
  // DDL is copied, so the host finds the table and an empty result.
  `CREATE TABLE \`credential\` (
    \`id\` text PRIMARY KEY,
    \`integration_id\` text,
    \`label\` text NOT NULL,
    \`value\` text NOT NULL,
    \`connector_id\` text,
    \`method_id\` text,
    \`active\` integer,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`,
  `CREATE TABLE \`account\` (
    \`id\` text PRIMARY KEY,
    \`email\` text NOT NULL,
    \`url\` text NOT NULL,
    \`access_token\` text NOT NULL,
    \`refresh_token\` text NOT NULL,
    \`token_expiry\` integer,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`,
  `CREATE TABLE \`account_state\` (
    \`id\` integer PRIMARY KEY NOT NULL,
    \`active_account_id\` text,
    \`active_org_id\` text,
    CONSTRAINT \`fk_account_state_active_account_id\` FOREIGN KEY (\`active_account_id\`)
      REFERENCES \`account\`(\`id\`) ON UPDATE no action ON DELETE set null
  )`,
  `CREATE TABLE \`control_account\` (
    \`email\` text NOT NULL,
    \`url\` text NOT NULL,
    \`access_token\` text NOT NULL,
    \`refresh_token\` text NOT NULL,
    \`token_expiry\` integer,
    \`active\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
  )`,
  `CREATE TABLE \`permission\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`action\` text NOT NULL,
    \`resource\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`fk_permission_project_id\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`session\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`parent_id\` text,
    \`slug\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`title\` text NOT NULL,
    \`version\` text NOT NULL,
    \`share_url\` text,
    \`summary_additions\` integer,
    \`summary_deletions\` integer,
    \`summary_files\` integer,
    \`summary_diffs\` text,
    \`revert\` text,
    \`permission\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`time_compacting\` integer,
    \`time_archived\` integer,
    \`workspace_id\` text,
    \`path\` text,
    \`agent\` text,
    \`model\` text,
    \`cost\` real DEFAULT 0 NOT NULL,
    \`tokens_input\` integer DEFAULT 0 NOT NULL,
    \`tokens_output\` integer DEFAULT 0 NOT NULL,
    \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
    \`metadata\` text,
    CONSTRAINT \`fk_session_project_id\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`session_share\` (
    \`session_id\` text PRIMARY KEY,
    \`id\` text NOT NULL,
    \`secret\` text NOT NULL,
    \`url\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`fk_session_share_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`blob\` (
    \`hash\` text PRIMARY KEY,
    \`mime\` text NOT NULL,
    \`bytes\` integer NOT NULL,
    \`width\` integer,
    \`height\` integer,
    \`data\` blob NOT NULL,
    \`time_created\` integer NOT NULL
  )`,
  `CREATE TABLE \`blob_ref\` (
    \`session_id\` text NOT NULL,
    \`message_id\` text NOT NULL,
    \`hash\` text NOT NULL,
    \`seq\` integer NOT NULL,
    CONSTRAINT \`blob_ref_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`, \`hash\`),
    CONSTRAINT \`fk_blob_ref_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_blob_ref_hash\` FOREIGN KEY (\`hash\`) REFERENCES \`blob\`(\`hash\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`instruction_blob\` (
    \`hash\` text PRIMARY KEY,
    \`value\` text
  )`,
  `CREATE TABLE \`instruction_entry\` (
    \`session_id\` text NOT NULL,
    \`key\` text NOT NULL,
    \`value\` text,
    \`removed\` integer DEFAULT false NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
    CONSTRAINT \`fk_instruction_entry_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`instruction_state\` (
    \`session_id\` text PRIMARY KEY,
    \`epoch_start\` integer NOT NULL,
    \`through_seq\` integer NOT NULL,
    \`initial_values\` text NOT NULL,
    \`current_values\` text NOT NULL,
    CONSTRAINT \`fk_instruction_state_session_id\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`migration\` (
    \`id\` text PRIMARY KEY,
    \`time_completed\` integer NOT NULL
  )`,
  `CREATE TABLE \`__drizzle_migrations\` (
    \`id\` integer PRIMARY KEY,
    \`hash\` text NOT NULL,
    \`created_at\` numeric,
    \`name\` text,
    \`applied_at\` text
  )`,
  `CREATE TABLE \`kv\` (
    \`key\` text PRIMARY KEY,
    \`value\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`,
]);

const OPTIONS = optionsOf([
  ['--out', 'string'],
  ['--force', 'boolean'],
  ['--verify', 'boolean'],
  ['--seed', 'string'],
]);

function usage() {
  return 'usage: node dev/bench/opencode-fixture-build.mjs [--out <dir>] [--force] [--seed <int>]\n'
    + '       node dev/bench/opencode-fixture-build.mjs --verify [--out <dir>]';
}

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const seedText = values.seed ?? String(DEFAULT_SEED);
  const seed = Number(seedText);
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffff_ffff) {
    throw new Error(`--seed must be a positive 32-bit integer (got ${seedText})`);
  }
  return {
    out: values.out ?? null,
    force: values.force === true,
    verify: values.verify === true,
    seed,
  };
}

/** A 32-bit seeded generator. Only filler bytes use it; ids and times are fixed. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pad = (value, width = 4) => String(value).padStart(width, '0');
/**
 * A host message id: `msg_` then `Identifier.ascending()`'s 26 alphanumerics
 * (`@opencode/schema/dist/session-message.js`: `isStartingWith("msg_")`). The
 * host decodes every stored message through that brand and failed the whole
 * session with `Expected a string starting with "msg_"` on the old ids.
 */
const messageId = (seq) => `msg_${String(seq).padStart(26, '0')}`;
const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function toolResult(label, lines, random) {
  const body = [];
  for (let line = 1; line <= lines; line += 1) {
    const width = 40 + Math.floor(random() * 40);
    body.push(`${MARKER}-${label}-LINE-${pad(line)}-${'x'.repeat(width)}`);
  }
  return `${MARKER}-${label}-RESULT-0001\n${body.join('\n')}\n`;
}

/**
 * The 12 tool calls: three reads of one path, two oversized reads, two failed
 * searches, and five ordinary calls. Every input and result carries the marker.
 */
function toolSpecs(random) {
  const repeat = `${MARKER}-REPEAT-RESULT-0001\n`
    + [`ONE`, `TWO`, `THREE`, `FOUR`]
      .map((name, index) => `${MARKER}-REPEAT-LINE-${pad(index + 1)}-${name} stable synthetic body`)
      .join('\n') + '\n';
  const bigA = toolResult('BIG-A', 180, random);
  const bigB = fixtureUnitResultText(`${WORKSPACE}\\${UNIT_FILE}`);
  if (byteLength(bigA) <= TOOL_RESULT_FLOOR || byteLength(bigB) <= TOOL_RESULT_FLOOR) {
    throw new Error('fixture-shape: an oversized result did not clear 8192 bytes');
  }
  const specs = [
    { assistant: 4, name: 'read', input: { path: REPEAT_PATH }, result: repeat },
    { assistant: 6, name: 'read', input: { path: REPEAT_PATH }, result: repeat },
    { assistant: 8, name: 'read', input: { path: REPEAT_PATH }, result: repeat },
    { assistant: 11, name: 'read', input: { path: `${WORKSPACE}\\big-a.log` }, result: bigA },
    { assistant: 13, name: 'read', input: { path: `${WORKSPACE}\\${UNIT_FILE}` }, result: bigB },
    // A failed search is stored as an ordinary completed result whose text says
    // it failed. An `error` state is re-encoded by the host as
    // `{"error":...,"content":[...]}` on the wire, so the failed-search marker
    // never reaches the request verbatim; a completed plain-text part does.
    { assistant: 16, name: 'grep',
      input: { pattern: `${MARKER}-MISSING-ALPHA-0001` },
      result: `${MARKER}-SEARCH-FAILED-0001: no files found for ${MARKER}-MISSING-ALPHA-0001` },
    { assistant: 19, name: 'grep',
      input: { pattern: `${MARKER}-MISSING-BETA-0001` },
      result: `${MARKER}-SEARCH-FAILED-0002: no files found for ${MARKER}-MISSING-BETA-0001` },
    { assistant: 22, name: 'glob',
      input: { pattern: `${WORKSPACE}\\**\\*.txt` },
      result: `${MARKER}-GLOB-RESULT-0001\n${REPEAT_PATH}\n${WORKSPACE}\\hello.txt\n` },
    { assistant: 25, name: 'write',
      input: { path: `${WORKSPACE}\\updated.txt`,
        content: `${MARKER}-WRITE-INPUT-0001: one synthetic line\n` },
      result: `${MARKER}-WRITE-RESULT-0001: wrote ${WORKSPACE}\\updated.txt` },
    { assistant: 28, name: 'read', input: { path: `${WORKSPACE}\\updated.txt` },
      result: `${MARKER}-UPDATED-RESULT-0001: ${MARKER}-WRITE-INPUT-0001: one synthetic line\n` },
    { assistant: 31, name: 'bash', input: { command: `ls ${WORKSPACE}` },
      result: `${MARKER}-BASH-RESULT-0001\nrepeat.txt\nbig-a.log\nbig-b.log\nhello.txt\n` },
    { assistant: 34, name: 'read', input: { path: `${WORKSPACE}\\hello.txt` },
      result: `${MARKER}-HELLO-RESULT-0001: hello from the synthetic workspace\n` },
  ];
  return specs.map((spec, index) => ({
    ...spec,
    callId: `${MARKER}-CALL-${pad(index + 1)}`,
    status: spec.status ?? 'completed',
  }));
}

/** The session, its rows and the token totals the rows imply. */
function buildSession(seed) {
  const random = mulberry32(seed);
  const specs = toolSpecs(random);
  const messages = [];
  const tokenSums = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let priorContextBytes = 0;
  let seq = 0;
  for (let turn = 1; turn <= USER_TURNS; turn += 1) {
    const userSeq = seq;
    seq += 1;
    const userTime = BASE_TIME + userSeq * 1_000;
    const userText = `${MARKER}-USER-${pad(turn)}: continue the synthetic replay transcript;`
      + ' inspect the next fixture file.';
    const userId = messageId(userSeq);
    messages.push({
      id: userId, type: 'user', seq: userSeq, timeCreated: userTime, timeUpdated: userTime,
      data: { id: userId, time: { created: userTime }, text: userText },
    });
    priorContextBytes += byteLength(userText);

    // The last two user turns carry no assistant answer: the seeded session must
    // end on a user row (see USER_TURNS).
    if (turn > ASSISTANT_TURNS) continue;

    const assistantSeq = seq;
    seq += 1;
    const time = BASE_TIME + assistantSeq * 1_000;
    const assistantText = `${MARKER}-ASSISTANT-${pad(turn)}: recorded synthetic answer`
      + ` ${pad(turn)} for the replay shape.`;
    const reasoningText = `${MARKER}-REASONING-${pad(turn)}: deterministic synthetic thought`
      + ` ${pad(turn)}; no real user text is present.`;
    const reasoningBytes = byteLength(reasoningText);
    const reasoningTokens = Math.max(1, Math.ceil(reasoningBytes / 4));
    const input = 600 + turn * 7 + Math.floor(priorContextBytes / 8);
    const output = Math.ceil((byteLength(assistantText) + reasoningBytes) / 4);
    const cacheRead = Math.floor(input * 0.65);
    const content = [
      { type: 'reasoning', text: reasoningText,
        time: { created: time + 100, completed: time + 200 } },
      { type: 'text', text: assistantText },
    ];
    let turnResultBytes = 0;
    for (const spec of specs.filter((row) => row.assistant === turn)) {
      const state = spec.status === 'error'
        ? { status: 'error', input: spec.input,
          error: { type: 'not-found',
            message: `${MARKER}-SEARCH-ERROR-${spec.callId.slice(-4)}: no files found` },
          content: [{ type: 'text', text: spec.result }], metadata: {} }
        : { status: 'completed', input: spec.input,
          content: [{ type: 'text', text: spec.result }], metadata: {} };
      content.push({
        type: 'tool', id: spec.callId, name: spec.name, state,
        time: { created: time + 250, completed: time + 400 },
      });
      turnResultBytes += byteLength(spec.result);
    }
    const turnSpecs = specs.filter((row) => row.assistant === turn);
    const assistantId = messageId(assistantSeq);
    messages.push({
      id: assistantId, type: 'assistant', seq: assistantSeq,
      timeCreated: time, timeUpdated: time + 500,
      data: {
        id: assistantId, type: 'assistant', agent: 'build',
        model: { id: MODEL_ID, providerID: PROVIDER_ID },
        content,
        finish: turnSpecs.length > 0 ? 'tool-calls' : 'stop',
        cost: 0,
        tokens: { input, output, reasoning: reasoningTokens,
          cache: { read: cacheRead, write: 0 } },
        time: { created: time, completed: time + 500 },
      },
    });
    priorContextBytes += byteLength(assistantText) + reasoningBytes + turnResultBytes;
    tokenSums.input += input;
    tokenSums.output += output;
    tokenSums.reasoning += reasoningTokens;
    tokenSums.cacheRead += cacheRead;
    tokenSums.cacheWrite += 0;
  }

  const lastTime = BASE_TIME + (messages.length - 1) * 1_000 + 500;
  const session = {
    id: SESSION_ID, project_id: PROJECT_ID, workspace_id: null, parent_id: null,
    fork_session_id: null, fork_boundary: null, slug: 'racoons-synthetic-session',
    directory: WORKSPACE, path: null, title: `${MARKER}-SESSION-TITLE-0001`, version: '2.2.5',
    share_url: null, summary_additions: null, summary_deletions: null, summary_files: null,
    summary_diffs: null, metadata: '{}', cost: 0,
    tokens_input: tokenSums.input, tokens_output: tokenSums.output,
    tokens_reasoning: tokenSums.reasoning, tokens_cache_read: tokenSums.cacheRead,
    tokens_cache_write: tokenSums.cacheWrite, revert: null, permission: null,
    agent: 'build', model: MODEL_JSON, time_created: BASE_TIME - 1_000,
    time_updated: lastTime, time_busy: null, time_idle: null, time_viewed: null,
    idle_outcome: null, time_compacting: null, time_archived: null, time_suspended: null,
    resume_attempts: 0,
  };
  const project = {
    id: PROJECT_ID, worktree: WORKSPACE, vcs: 'git', name: `${MARKER}-PROJECT-NAME-0001`,
    icon_url: null, icon_color: null, time_created: BASE_TIME - 1_000,
    time_updated: lastTime, time_initialized: BASE_TIME - 1_000, sandboxes: '[]',
    commands: null, icon_url_override: null, time_active: 0, time_archived: null,
  };
  return {
    messages,
    session,
    project,
    projectDirectory: {
      project_id: PROJECT_ID, directory: WORKSPACE, type: 'main',
      time_created: BASE_TIME - 1_000, strategy: null,
    },
    worktree: {
      project_id: PROJECT_ID, directory: WORKSPACE, strategy: null,
      time_created: BASE_TIME - 1_000,
    },
    /**
     * The last sequence value the seeded messages use. The host's next event
     * sequence must be after every seeded row, or its new turn is written with
     * seq 1, 2, ... and interleaves inside the seeded history. `seedSessionDb`
     * also advances a lagging value, but the source states its own last seq.
     */
    eventSequence: { aggregate_id: SESSION_ID, seq: seq - 1, owner_id: null },
    migrationRows: MIGRATION_IDS.map((id, index) => ({
      id, time_completed: BASE_TIME - 2_000 + index,
    })),
    drizzleRows: [{
      id: 1, hash: `${MARKER}-DRIZZLE-HASH-0001`, created_at: BASE_TIME - 3_000,
    }],
    kvRows: [
      { key: 'migration.v1-v2',
        value: JSON.stringify({ phase: 'completed', marker: `${MARKER}-KV-0001` }),
        time_created: BASE_TIME - 1_000, time_updated: BASE_TIME - 1_000 },
      { key: 'models-dev:synthetic-cache',
        value: JSON.stringify({ marker: `${MARKER}-KV-CACHE-0001`, body: 'not copied by the seed' }),
        time_created: BASE_TIME - 1_000, time_updated: BASE_TIME - 1_000 },
    ],
    tokenSums,
  };
}

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) `
    + `VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
}

/** Write the database to `dbPath`. The caller renames it into place. */
function writeDatabase(dbPath, seed) {
  const built = buildSession(seed);
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  mkdirSync(resolve(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA page_size = 4096');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      for (const statement of DDL) db.exec(statement);
      insertRow(db, 'project', built.project);
      insertRow(db, 'project_directory', built.projectDirectory);
      insertRow(db, 'worktree', built.worktree);
      insertRow(db, 'session_v2', built.session);
      for (const message of built.messages) {
        insertRow(db, 'session_message', {
          id: message.id, session_id: SESSION_ID, type: message.type,
          time_created: message.timeCreated, time_updated: message.timeUpdated,
          data: JSON.stringify(message.data), seq: message.seq,
        });
      }
      insertRow(db, 'event_sequence', built.eventSequence);
      for (const row of built.migrationRows) insertRow(db, 'migration', row);
      for (const row of built.drizzleRows) insertRow(db, '__drizzle_migrations', row);
      for (const row of built.kvRows) insertRow(db, 'kv', row);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    }
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`fixture-integrity: PRAGMA integrity_check returned `
        + `${String(integrity?.integrity_check)}`);
    }
  } finally {
    db.close();
  }
  return built;
}

/** Every text value in the database, for the marker scan and the row counts. */
function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' "
    + "AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
}

/**
 * Recompute the manifest's measured half from the database. This is the single
 * source for both the build's manifest and `--verify`, so the two cannot drift.
 */
function analyzeFixture(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`fixture-integrity: PRAGMA integrity_check returned `
        + `${String(integrity?.integrity_check)}`);
    }
    const tableRowCounts = {};
    for (const table of tableNames(db)) {
      tableRowCounts[table] = Number(
        db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n,
      );
    }
    const session = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(SESSION_ID);
    if (session === undefined) throw new Error(`fixture-shape: no session_v2 row ${SESSION_ID}`);
    const messages = db.prepare('SELECT type, seq, data FROM session_message '
      + 'WHERE session_id = ? ORDER BY seq').all(SESSION_ID);
    const assistantTurns = messages.filter((row) => row.type === 'assistant').length;
    const userTurns = messages.filter((row) => row.type === 'user').length;
    const reasoning = db.prepare(`
      SELECT count(*) AS parts,
        coalesce(sum(length(cast(json_extract(part.value, '$.text') AS BLOB))), 0) AS bytes,
        sum(CASE WHEN json_extract(part.value, '$.time.completed') IS NOT NULL
          THEN 1 ELSE 0 END) AS completed
      FROM session_message AS message, json_each(message.data, '$.content') AS part
      WHERE message.session_id = ? AND message.type = 'assistant'
        AND json_extract(part.value, '$.type') = 'reasoning'
    `).get(SESSION_ID);
    const toolRows = db.prepare(`
      SELECT json_extract(part.value, '$.id') AS call_id,
        json_extract(part.value, '$.name') AS name,
        json_extract(part.value, '$.state.status') AS status,
        coalesce(json_extract(part.value, '$.state.input.path'),
          json_extract(part.value, '$.state.input.filePath')) AS file_path,
        (SELECT json_extract(block.value, '$.text')
          FROM json_each(json_extract(part.value, '$.state.content')) AS block
          WHERE json_extract(block.value, '$.type') = 'text' LIMIT 1) AS result_text
      FROM session_message AS message, json_each(message.data, '$.content') AS part
      WHERE message.session_id = ? AND message.type = 'assistant'
        AND json_extract(part.value, '$.type') = 'tool'
      ORDER BY message.seq, part.key
    `).all(SESSION_ID);
    const resultTexts = toolRows
      .map((row) => (typeof row.result_text === 'string' ? row.result_text : null))
      .filter((text) => text !== null);
    const resultBytes = resultTexts.map(byteLength);
    // The real host writes no `executed` key on a stored tool part. With it the
    // decoder marks the result as inline, and the OpenAI-compatible adapter
    // refuses the assistant message. Measured so a regression cannot ship.
    const toolPartsWithExecutedFlag = Number(db.prepare(`
      SELECT count(*) AS n
      FROM session_message AS message, json_each(message.data, '$.content') AS part
      WHERE message.session_id = ? AND message.type = 'assistant'
        AND json_extract(part.value, '$.type') = 'tool'
        AND json_extract(part.value, '$.executed') IS NOT NULL
    `).get(SESSION_ID).n);
    const tokenSums = db.prepare(`
      SELECT coalesce(sum(json_extract(data, '$.tokens.input')), 0) AS input,
        coalesce(sum(json_extract(data, '$.tokens.output')), 0) AS output,
        coalesce(sum(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
        coalesce(sum(json_extract(data, '$.tokens.cache.read')), 0) AS cache_read,
        coalesce(sum(json_extract(data, '$.tokens.cache.write')), 0) AS cache_write
      FROM session_message WHERE session_id = ? AND type = 'assistant'
    `).get(SESSION_ID);
    const sessionTokens = {
      input: Number(session.tokens_input), output: Number(session.tokens_output),
      reasoning: Number(session.tokens_reasoning),
      cacheRead: Number(session.tokens_cache_read),
      cacheWrite: Number(session.tokens_cache_write),
    };
    const messageSums = {
      input: Number(tokenSums.input), output: Number(tokenSums.output),
      reasoning: Number(tokenSums.reasoning),
      cacheRead: Number(tokenSums.cache_read), cacheWrite: Number(tokenSums.cache_write),
    };
    const tokensMatch = Object.keys(sessionTokens)
      .every((key) => sessionTokens[key] === messageSums[key]);
    const allMessagesMarked = messages.every((row) =>
      typeof row.data === 'string' && row.data.includes(MARKER));
    const messageIds = db.prepare('SELECT id FROM session_message WHERE session_id = ?')
      .all(SESSION_ID).map((row) => String(row.id));
    const brandedMessageIds = messageIds.filter((id) => MESSAGE_ID_PATTERN.test(id)).length;
    const workspaceColumns = tableNames(db).includes('workspace')
      ? db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('workspace')
        .map((row) => String(row.name))
      : [];
    let modelId = null;
    let modelProviderId = null;
    try {
      const parsed = JSON.parse(String(session.model));
      modelId = typeof parsed?.id === 'string' ? parsed.id : null;
      modelProviderId = typeof parsed?.providerID === 'string' ? parsed.providerID : null;
    } catch { /* the shape check reports the raw value */ }
    return {
      schema: SCHEMA,
      fixture: 'opencode',
      note: 'Synthetic opencode 2.2.5 source database for seedSessionDb. The session id is'
        + ' ses_-branded and fabricated; every message, tool input and tool result carries'
        + ' RACOONS-SYNTHETIC- plus a counter. No real user text, session id or home path'
        + ' is present.',
      sessionId: String(session.id),
      projectId: String(session.project_id),
      model: String(session.model),
      modelId,
      modelProviderId,
      workspaceTableColumns: workspaceColumns,
      sha256: sha256File(dbPath),
      bytes: statSync(dbPath).size,
      messageCount: messages.length,
      userTurnCount: userTurns,
      assistantTurnCount: assistantTurns,
      reasoningPartCount: Number(reasoning.parts),
      sendableReasoningPartCount: Number(reasoning.completed),
      reasoningBytes: Number(reasoning.bytes),
      toolCallCount: toolRows.length,
      toolResultCount: resultTexts.length,
      toolPartsWithExecutedFlag,
      largestResultBytes: resultBytes.length === 0 ? 0 : Math.max(...resultBytes),
      largeResultCount: resultBytes.filter((size) => size > TOOL_RESULT_FLOOR).length,
      repeatCount: toolRows.filter((row) =>
        row.name === 'read' && row.file_path === REPEAT_PATH).length,
      // A failed search is a grep whose stored result text says it found
      // nothing. It is not an `error` state: the host re-encodes that as JSON
      // and the marker never reaches the request verbatim.
      failedSearchCount: toolRows.filter((row) =>
        row.name === 'grep' && typeof row.result_text === 'string'
        && row.result_text.includes(`${MARKER}-SEARCH-FAILED-`)).length,
      allMessagesMarked,
      brandedMessageIds,
      messageIdsTotal: messageIds.length,
      tableRowCounts,
      tokens: {
        session: sessionTokens,
        messageSums,
        match: tokensMatch,
      },
    };
  } finally {
    db.close();
  }
}

/** The fixture must have the shape the bench's replay claims to measure. */
function assertShape(manifest) {
  const problems = [];
  if (manifest.messageCount < 120) problems.push(`messageCount ${manifest.messageCount} < 120`);
  if (manifest.assistantTurnCount < 60) {
    problems.push(`assistantTurnCount ${manifest.assistantTurnCount} < 60`);
  }
  if (manifest.reasoningPartCount < 60) {
    problems.push(`reasoningPartCount ${manifest.reasoningPartCount} < 60`);
  }
  if (manifest.sendableReasoningPartCount !== manifest.reasoningPartCount) {
    problems.push(`${manifest.reasoningPartCount - manifest.sendableReasoningPartCount} `
      + 'reasoning part(s) lack time.completed');
  }
  if (manifest.toolCallCount < 8) problems.push(`toolCallCount ${manifest.toolCallCount} < 8`);
  if (manifest.toolResultCount < 8) problems.push(`toolResultCount ${manifest.toolResultCount} < 8`);
  if (manifest.largestResultBytes <= TOOL_RESULT_FLOOR) {
    problems.push(`largestResultBytes ${manifest.largestResultBytes} <= ${TOOL_RESULT_FLOOR}`);
  }
  if (manifest.largeResultCount < 2) {
    problems.push(`largeResultCount ${manifest.largeResultCount} < 2`);
  }
  if (manifest.repeatCount < 3) problems.push(`repeatCount ${manifest.repeatCount} < 3`);
  if (manifest.failedSearchCount !== 2) {
    problems.push(`failedSearchCount ${manifest.failedSearchCount} != 2`);
  }
  if (manifest.allMessagesMarked !== true) problems.push('a message lacks the synthetic marker');
  if (manifest.tokens.match !== true) problems.push('session token totals differ from message sums');
  if (!SESSION_ID_PATTERN.test(manifest.sessionId)) {
    problems.push(`sessionId ${JSON.stringify(manifest.sessionId)} is not ses_ + 26 alphanumerics`);
  }
  if (manifest.brandedMessageIds !== manifest.messageIdsTotal) {
    problems.push(`${manifest.messageIdsTotal - manifest.brandedMessageIds} message id(s) are not `
      + 'msg_ + 26 alphanumerics; the host decodes every stored message through that brand');
  }
  if (manifest.toolPartsWithExecutedFlag !== 0) {
    problems.push(`${manifest.toolPartsWithExecutedFlag} stored tool part(s) carry the "executed" `
      + 'flag; the host then sends a tool-result inside an assistant message and the '
      + 'OpenAI-compatible adapter refuses it');
  }
  if (manifest.modelId !== MODEL_ID || manifest.modelProviderId !== PROVIDER_ID) {
    problems.push(`the session model ${JSON.stringify(manifest.model)} is not the JSON `
      + `${JSON.stringify({ id: MODEL_ID, providerID: PROVIDER_ID })} the host parses`);
  }
  if (!Array.isArray(manifest.workspaceTableColumns)
    || manifest.workspaceTableColumns.join(',') !== WORKSPACE_COLUMNS.join(',')) {
    problems.push(`the workspace table columns ${JSON.stringify(manifest.workspaceTableColumns)} `
      + `are not ${JSON.stringify(WORKSPACE_COLUMNS)}`);
  }
  if (problems.length > 0) throw new Error(`fixture-shape: ${problems.join('; ')}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Recompute and compare. Returns the list of mismatching keys, empty when okay. */
function verifyDirectory(outDir) {
  const dbPath = join(outDir, DB_FILE);
  const manifestPath = join(outDir, MANIFEST_FILE);
  if (!existsSync(dbPath)) return { ok: false, problems: [`missing ${dbPath}`], manifest: null };
  if (!existsSync(manifestPath)) {
    return { ok: false, problems: [`missing ${manifestPath}`], manifest: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, problems: [`manifest.json is not JSON: ${error.message}`], manifest: null };
  }
  let actual;
  try {
    actual = analyzeFixture(dbPath);
  } catch (error) {
    return { ok: false, problems: [`database could not be read: ${error.message}`], manifest };
  }
  const problems = [];
  for (const key of [...new Set([...Object.keys(manifest), ...Object.keys(actual)])].sort()) {
    if (!(key in manifest)) { problems.push(`${key}: missing from manifest`); continue; }
    if (!(key in actual)) { problems.push(`${key}: not a measured field`); continue; }
    if (!sameValue(manifest[key], actual[key])) {
      problems.push(`${key}: manifest ${JSON.stringify(manifest[key])} != actual `
        + `${JSON.stringify(actual[key])}`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

function writeAtomic(path, text) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out === null ? DEFAULT_OUT : resolve(REPO_ROOT, opts.out);
  if (opts.verify) {
    const verified = verifyDirectory(outDir);
    if (!verified.ok) {
      process.stderr.write(`opencode fixture verify: ${verified.problems.length} mismatch(es)\n`);
      for (const problem of verified.problems.slice(0, 8)) {
        process.stderr.write(`  ${problem}\n`);
      }
      process.exitCode = 1;
      return;
    }
    const manifest = verified.manifest;
    process.stdout.write(`opencode fixture verify: ok (messages=${manifest.messageCount}`
      + ` assistant=${manifest.assistantTurnCount} reasoning=${manifest.reasoningPartCount}`
      + ` tools=${manifest.toolCallCount} largest=${manifest.largestResultBytes}`
      + ` sha256=${manifest.sha256.slice(0, 16)})\n`);
    return;
  }

  const finalDb = join(outDir, DB_FILE);
  const finalManifest = join(outDir, MANIFEST_FILE);
  const existing = [finalDb, finalManifest].filter((path) => existsSync(path));
  if (!opts.force && existing.length > 0) {
    process.stderr.write(`opencode fixture: refusing to overwrite ${existing.join(', ')};`
      + ' pass --force\n');
    process.exitCode = 2;
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const temporaryDb = join(outDir, `${DB_FILE}.tmp`);
  rmSync(temporaryDb, { force: true });
  rmSync(`${temporaryDb}-wal`, { force: true });
  rmSync(`${temporaryDb}-shm`, { force: true });
  try {
    writeDatabase(temporaryDb, opts.seed);
    const manifest = analyzeFixture(temporaryDb);
    assertShape(manifest);
    if (opts.force) {
      for (const path of [finalDb, finalManifest]) rmSync(path, { force: true });
      for (const suffix of ['-wal', '-shm']) rmSync(`${finalDb}${suffix}`, { force: true });
    }
    renameSync(temporaryDb, finalDb);
    writeAtomic(finalManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = verifyDirectory(outDir);
    if (!verified.ok) {
      throw new Error(`fixture-verify: ${verified.problems.join('; ')}`);
    }
    process.stdout.write(`opencode fixture: messages=${manifest.messageCount}`
      + ` user=${manifest.userTurnCount} assistant=${manifest.assistantTurnCount}`
      + ` reasoning=${manifest.reasoningPartCount} tools=${manifest.toolCallCount}`
      + ` results=${manifest.toolResultCount} largest=${manifest.largestResultBytes}`
      + ` repeat=${manifest.repeatCount} failedSearches=${manifest.failedSearchCount}\n`);
    process.stdout.write(`  sha256 ${manifest.sha256}\n`);
    process.stdout.write(`  wrote ${outDir}\n`);
  } catch (error) {
    rmSync(temporaryDb, { force: true });
    rmSync(`${temporaryDb}-wal`, { force: true });
    rmSync(`${temporaryDb}-shm`, { force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`opencode fixture: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}

export {
  ASSISTANT_TURNS, BASE_TIME, DDL, DB_FILE, DEFAULT_OUT, MANIFEST_FILE, MARKER,
  MESSAGE_ID_PATTERN, MIGRATION_IDS, MODEL_ID, MODEL_JSON, MODEL_SELECTOR, PROVIDER_ID,
  REPEAT_PATH, SCHEMA,
  SESSION_ID, SESSION_ID_PATTERN, TOOL_RESULT_FLOOR, USER_TURNS, WORKSPACE,
  WORKSPACE_COLUMNS, analyzeFixture, assertShape, buildSession, verifyDirectory,
  writeDatabase,
};

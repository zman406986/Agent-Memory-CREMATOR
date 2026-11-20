/**
 * The mount's journal vocabulary, as one closed list (CRITIC-022 P3 #14).
 *
 * A journal line is the only evidence an operator has for what the mount did,
 * and every consumer reads it by a literal `kind`. While the kinds were bare
 * strings, a typo in one `journal('...')` call was a line no reader ever saw and
 * no compiler ever caught. The union below closes the vocabulary: `journal` in
 * `./plugin.ts` takes `RacoonsJournalKind`, so a misspelling is a compile error.
 *
 * ADR-0028 removed the judge pass, so the table loop has one caller (the bulk
 * prune) and its kinds are literal `prune-*` spellings; the `judge-*` and
 * gate-verdict kinds it wrote are gone with the seam that wrote them.
 *
 * This module has no imports on purpose: both the mount and the seams it hands
 * a `MountJournal` to need the type, and a leaf keeps those wires acyclic.
 */

/** Every kind this mount journals. */
export const CREMATOR_JOURNAL_KINDS = [
  // mount lifecycle
  'mounted', 'capabilities', 'telemetry',
  // a session's clean ending released its open entry (ISSUE-377): the drain
  // flushed owed appends first, then the same per-entry release `close()` uses
  // closed the owned ledger and evicted the per-session maps. `reason` names
  // the host event that triggered it.
  'session-evicted',
  // step and turn boundaries
  'at-rest', 'at-rest-error', 'entry', 'entry-error', 'skip', 'publish',
  // storage (ADR-0013)
  'storage-plan', 'storage-retry', 'storage-recovered', 'storage-unavailable',
  // the prune pass (ISSUE-022; ADR-0028: the ONE table ask left)
  'prune-requested', 'prune-off', 'prune-unseeded', 'prune-plan', 'prune-seed',
  'prune-seed-refused', 'prune-send-refused', 'prune-skip', 'prune-table',
  // the bulk prune's ask COST (ISSUE-178): one line per table send, answered or
  // refused, carrying the host's `usage` reading under the same field names the
  // entry lane's `entry-ask` / `entry-ask-refused` rows use. Additive: the
  // `prune-table` line keeps its meaning and an old journal still parses. An
  // absent `usage` field means the host claimed nothing, never a zero reading.
  'prune-ask',
  // the pass's ONE correction turn (ISSUE-113): one line per correction turn
  // actually sent, naming the rows it re-asked, the reason per index and how
  // many it recovered. A pass whose first answer was clean writes no such line.
  'prune-correction',
  'prune-verdict', 'prune-recorded', 'prune-threshold', 'prune-error',
  'prune-round-error', 'prune-round-resumed',
  // the depth latch's state came back from the round file on remount
  // (ISSUE-336): one line naming the restored post-pass baseline
  'prune-trigger-resumed',
  'prune-apply', 'prune-apply-error', 'prune-apply-skipped',
  // the host's own compaction, observed never touched (ISSUE-029)
  'native-compaction',
  // per-request token accounting (G8, ISSUE-045 D1): a reconciled reading, and
  // an `assistant/message` step that carried no usage row at all
  'usage-reconciled', 'usage-missing',
  // the manual forget tool's apply leg (G1, ISSUE-045 D2): one line per request
  // the mount drained at a boundary, and one for a drain that threw
  'forget', 'forget-error',
  // the entry checkpoint's ask (G7, ISSUE-056 C6a; ADR-0022): `entry-ask`
  // carries the answer, its action fields and the observed ask cost;
  // `entry-ask-refused` carries the refusal code, the wire parser's own code
  // under `wireCode` when a malformed row had one (ISSUE-179), and, when the
  // seam returned a text, that text in `raw` (a bounded prefix); `entry-ask-off`
  // says the seam did not ask, naming why — an unarmed seam, a closed breaker,
  // an absent unit, or, on the ISSUE-188 live re-read, a row that can no longer
  // show the two quotes a tabled row carries (`no-quotes`; ADR-0042). Without
  // these three a dead seam reads as a green zero-shaping run, so the mount
  // journals one of them per over-floor result (C6b); a result under the floor
  // or unable to quote two lines is not tabled and writes none (ADR-0042
  // Decision 5).
  'entry-ask', 'entry-ask-refused', 'entry-ask-off',
  // a batch whose NO row answered (ISSUE-185): the ask pair is collapsed as a
  // keep-all collapses it, because a refused exchange is not a record and both
  // turns are user messages the next model turn would answer instead of the
  // task. `status` is the host write's (`applied` / `refused` / `unknown`), and
  // `code` names a refusal. Written once per collapsed batch; a refused row's
  // own `entry-ask-refused` line is unchanged.
  'entry-ask-collapsed',
  // the cold boundary's recovery (ISSUE-341): one line when a resumed session's
  // first boundary collapsed an orphaned ask exchange, re-queued a landing the
  // buffer lost, or rebuilt a settled keep from the ledger. `collapsed`,
  // `redelivered` and `kept` count each; a fresh session writes none.
  'entry-resume-recovered',
  // a boundary's flush of committed-but-unpublished append applications
  // (ISSUE-342) threw: `pending` counts the requests still queued for the next
  // boundary's retry, and `message` is the host append's own error.
  'append-publish-failed',
  // the durable pending-append intent (ISSUE-374) could not be written: the
  // in-memory queue still flushes this process, only the restart durability
  // is lost. `pending` counts the records the write carried; `message` names
  // the storage error. Fail-open, like every other mount seam.
  'append-persist-error',
  // the batch accumulator's hold (ISSUE-117 chunk B3; ADR-0035 §1–§3, §6):
  // one line per eligible result a batch of size > 1 carries instead of
  // asking. The row names the result, its unit and how many are now pending;
  // a session that ends on a partial batch simply holds these and asks
  // nothing more (no `entry-ask` line ever follows for them).
  'entry-ask-hold',
  // a HELD row whose content or unit changed between its landing and the batch
  // fire (ISSUE-188): the ask table is built from a fresh read of the live
  // transcript, and a row whose bytes or unit id no longer match the landing
  // copy is dropped rather than described to the model as current. `rowIndex`
  // is its 1-based position in the fired batch, `changed` names `hash`, `unit`,
  // `unit+hash` or `absent`, and the landing/live values ride beside it. The
  // dropped row answers nothing, settles nothing and its unit stays landed.
  'entry-ask-row-stale',
  // the entry checkpoint's APPLY (ISSUE-058 chunk P3c-2; ADR-0022 §11–§14):
  // `entry-apply` carries the surface outcome — `rewound` for a keep-all,
  // `landed` for a forget — with the host seqs the write consumed;
  // `entry-apply-refused` names why an answered exchange wrote nothing and the
  // result stands whole. Additive: the three ask kinds above keep their
  // meanings, so a reader of the earlier lines sees the same vocabulary.
  'entry-apply', 'entry-apply-refused',
] as const;

/** One journal record's kind. */
export type RacoonsJournalKind = (typeof CREMATOR_JOURNAL_KINDS)[number];

/** One journal call: a kind from the closed list plus its fields. */
export type MountJournal = (kind: RacoonsJournalKind, fields: Record<string, unknown>) => void;

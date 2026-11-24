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
  // a second apply of one durable root joined the live mount instead of being
  // refused (ISSUE-577; ADR-0075: two terminals on one folder must both work).
  // `status: 'reused'` and `scope: 'process'` name the join, `shares` counts the
  // holders (this one included), and the root rides as `storageRoot`/`storage`.
  // The joined apply's own options are not adopted by the live mount.
  'mount-shared',
  // this mount could not publish its record under the root's `mounts/` folder
  // (ISSUE-578): the folder or the record could not be written. The mount
  // still completes — a record is presence evidence, never an admission gate,
  // and `reason` names the failure. Other processes simply see one mount fewer.
  'mount-record-error',
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
  // a unit the two retention rules keep out of the pass (ISSUE-519): `reason`
  // is `recall-answer-retained` for the recall tool's own answer, or
  // `contained-in-live-result` with `containedInNodeId` naming the longer live
  // result whose bytes already carry this unit. The unit was never planned, so
  // the pass frees none of its bytes.
  'prune-retained',
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
  // `prune-round-error`: a durable round/latch/queue write failed (the
  // in-memory fact still serves this process) or was refused because a
  // transient read failure would have republished a merged empty document over
  // intact facts (ISSUE-499; `refused: true`, `fact`, `reason`). Reads name a
  // refused document or record the same way before failing open.
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
  // the mount drained at a boundary, and one for a drain that threw. A thrown
  // process applied nothing, so the request is re-queued and its durable record
  // stands: the `forget-error` row carries `requeued: true` (ISSUE-523 item 3).
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
  // `appendAskTurns` failed partway (ISSUE-403): `appended` counts the ask/
  // answer turns the call wrote before the host threw, `collapse` is the
  // prefix's rewind status, `code` names a refused rewind, and `message` is the
  // host's own error. The mount fails open and writes no `entry-ask`.
  'entry-ask-append-failed',
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
  // boundary's retry, and `message` is the host append's own error. A PERMANENT
  // failure is set aside instead of stalling the queue (ISSUE-523 item 2):
  // `permanent: true`, `code` names it, `intentId` names the request, and
  // `pending` counts what remains behind it.
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
  // an invalid fixed `judgeRoute` (ISSUE-427): one line at mount naming the
  // field whose runtime type was not a string. The pass and both ask lanes
  // then run as if no route were configured, never as if one were guessed.
  'route-invalid',
  // the native status card could not be opened or closed (ISSUE-429). `phase`
  // is `open` or `close`, `commandId` pairs the attempt, `cardKind` names the
  // outcome the close tried to write, and `message` is the host seam's own
  // error. The ask still runs and settles: the card is presentation, never a
  // product outcome.
  'ask-card-error',
  // the host refused the tool registration at mount (ISSUE-443). Registration
  // is all-or-nothing, so `registered` is 0 and `offered` names the inventory
  // the mount tried to advertise; `message` is the host `register` error. The
  // apply still completes (fail-open): a mount with no tools is a named state,
  // never silent.
  'tool-registration-error',
  // the tool outcome when registration did NOT throw (ISSUE-454): `status` is
  // `registered` or `absent`, `registered` counts the tools advertised (0 for
  // `absent`), `offered` names the inventory the mount tried to advertise, and
  // an absent service adds `reason: 'no-tools-service'`. One line per mount,
  // so "no tools offered" is never byte-identical to "both offered".
  'tool-registration',
  // a pending-append intent this session's round file carries is malformed
  // (ISSUE-430): on a fresh process the corrupt record is dropped fail-open,
  // and this line names the position and the defect instead of reading as an
  // empty queue.
  'pending-append-corrupt',
  // the install boundary (ISSUE-414): one line per mount of a durable session,
  // naming the mount generation and whether this mount recorded the first one
  // (`fresh: true`) or resumed state this session already owned. A fresh mount
  // over a session with pre-install history records that history as the
  // session's inherited set; the set is fork/clone identity evidence, never an
  // eligibility gate, so a later pass tables and removes those results exactly
  // like one the mount observed land. The count of recorded node ids rides
  // beside the line.
  'install-boundary',
  // a durable mount-state write (install identity, pending forgets, receipts)
  // failed: the in-memory state still serves this process, only its restart
  // durability is lost. Fail-open, like every other mount seam. ISSUE-499: a
  // read this build could not trust is named the same way — `refused: true`,
  // the `fact` and its `reason`; a writer then refuses to republish a merged
  // empty document over the facts it could not read. A malformed record inside
  // a readable document is named here too, before the read fails open.
  'mount-state-error',
  // the durable install identity could not be written (ISSUE-439). The mount
  // never journals a boundary it did not record: `state` names the boundary the
  // failed write was for, and the next boundary retries the same identity until
  // it lands (ADR-0065).
  'install-persist-error',
  // a mount with no readable install record classified itself `restart`
  // instead of `inherited` on ledger evidence (ISSUE-460). `reason` says which
  // evidence: `ledger-rows` when this session's own rows were read (a fork's
  // copied rows carry the parent's id and do not count), `ledger-unreadable`
  // when the read itself failed (ISSUE-573) — the mount cannot prove absence,
  // so it keeps recovery on and promotes nothing. Either way `source` names
  // where the inherited set came from (`preinstall-record` when the mount's own
  // durable proof answers, `surface-unsafe` when no proof exists and the
  // surface's results are recorded by name), and `preInstall` counts that set
  // (ISSUE-477).
  'install-fallback',
  // a fork mount dropped the parent's owed durable work from the child's copy
  // (ISSUE-437): `parentSessionId` names the session the copied state belongs
  // to, and `forgets`/`appends` count the facts cleared, with
  // `round`/`latch`/`entryAskFired` naming the parent's header facts when one
  // was dropped. Skipping a durable fact is not removing it, and a later child
  // mount would replay it as its own.
  'fork-state-dropped',
  // a fork's clear of an inherited fact failed (ISSUE-456): `file` names the
  // sibling file (`mount-state.json` for a forget, `prune-round.json` for an
  // append), `fact` names the inherited fact and `count` how many copies
  // remain. The drop line never claims a fact whose write
  // returned false, and the fork keeps the parent's install identity so the
  // next mount re-forks and retries.
  'fork-clear-failed',
  // a fork mount still owed the parent's fact clear (ISSUE-478): the durable
  // preinstall record carries `pendingClear`, the withheld install identity is
  // not the marker, and `ids` counts the pre-install set the fork keeps so a
  // child's own results are never reclassified as inherited history.
  'fork-clear-pending',
  // the durable preinstall record could not be written (ISSUE-477/ISSUE-478):
  // `preInstall` counts the ids it carried and `pendingClear` says whether it
  // was the fork's pending-clear marker. Fail-open: the in-memory state still
  // serves this process, only the proof across a restart is lost.
  'preinstall-persist-error',
  // recovery (ISSUE-428) did not finish at this boundary: `step` names the leg
  // that threw (`collapse`, `surface-read`, `marks`, `appends`, `sync`), the
  // entry keeps owing its recovery and the next boundary retries it.
  'entry-recovery-retry',
  // the ledger-derived kept marks could not be read during recovery
  // (ISSUE-428): the surface recovery still stands, and this line names the
  // failure instead of a bare host warning.
  'entry-recovery-mark-error',
  // a queued manual forget came back from the durable mount state on mount
  // (ISSUE-417): `count` names how many were re-queued for the boundary drain.
  'forget-recovered',
  // the durable pending-forget write failed (ISSUE-417). The mount refuses the
  // tool's "scheduled" answer rather than promise an unload-durable removal;
  // `message` names the storage error.
  'forget-persist-error',
  // applied receipts came back from the durable mount state on mount
  // (ISSUE-417): a prepared ledger row the previous process landed can now be
  // resolved by the port's `lookupReceipt` instead of blocking recovery.
  'receipts-resumed',
  // ISSUE-423: a host compaction landed while an ask/apply window was open, so
  // the depth latch was NOT re-armed mid-flight. `phase` and `generation` name
  // the compaction; `window` names the open lanes — `entry`, `prune`, or
  // `entry+prune` when a direct prune overlaps an in-flight entry ask
  // (ISSUE-501). The last window's end re-arms the latch once no apply is
  // running (ADR-0050's native-compaction backstop).
  'native-compaction-deferred',
  // ISSUE-432: the live host route changed under this session id, so the
  // per-entry floor was re-derived and stamped with its provider/model. `from`
  // and `to` name the old and new route/floor; `window` names what is not
  // model-derived (a mount option) instead of pretending it refreshed.
  'model-refresh',
  // ISSUE-432: the main-wire capture names a different provider/model from the
  // live route, so the seed is invalidated by name instead of serving a prefix
  // that belongs to the old model.
  'seed-model-stale',
  // ISSUE-606: no main request has been observed yet (a restarted mount), so the
  // seed's tool list came from the host's logged request header instead of a
  // capture; `tools` counts them. With `reason` instead, that fallback was
  // refused by name and the ask keeps its `no-seed`.
  'seed-prefix',
  // the routed model's context window (ADR-0071, ADR-0072): `window-resolved`
  // names the route and the source when the host model-info seam answers;
  // `window-unresolved` names why a route's lookup produced no window, once per
  // route and session; `model-switch` names a route change that re-armed the
  // depth latch without forcing a pass.
  'window-resolved', 'window-unresolved', 'model-switch',
] as const;

/** One journal record's kind. */
export type RacoonsJournalKind = (typeof CREMATOR_JOURNAL_KINDS)[number];

/** One journal call: a kind from the closed list plus its fields. */
export type MountJournal = (kind: RacoonsJournalKind, fields: Record<string, unknown>) => void;

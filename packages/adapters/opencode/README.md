# cremator-opencode

CREMATOR adapter for the [OpenCode](https://opencode.ai) 2.4.0 harness. Thin seam mapping, no
policy: it maps OpenCode's request `Message[]` onto the public seams of `@cremator/core` and
applies what the core guard approved. Every removal is recorded in the trash ledger under a
recall id. CREMATOR never summarizes.

**Status: functional tests; live 2.2.5 runs exist but their evidence is withdrawn. The 36-record test runs 1i, 2a and 3b are withdrawn pending a clean rerun for key isolation, real-data safety, restore proof and lower-bound gaps (2026-11-11); the 1c vanilla control and the original 1c test arm are also not citable.** Every test
in this package drives a duck-typed fake host: no OpenCode binary, no API key, no live call. Live
2.2.5 runs are recorded in ISSUE-255 and ISSUE-256. No citable claim rests on them; a clean rerun is
queued after the fixes. The package targets the installed
`@opencode/cli` 2.4.0 family; the type-only devDependencies are `@opencode/plugin@2.4.0`,
`@opencode/ai@2.4.0` and `@opencode/schema@2.4.0`. The 2.4.0 target is covered by the offline
suite and typecheck; a live 2.4.0 run is pending. A version change is a new verification, not a
drop-in test (ADR-0017 §4; ISSUE-192).

## Live-run warning

A live route writes to real host state. On 2026-11-11 pilot `1d` changed the real
`~/.local/share/opencode/opencode.db` and its `-wal` (ISSUE-260); the cause was not established. Read
`docs/guides/ref-live-testing.md` before any live run. Keep evidence under
`scratchpad/launch/<yyyy-mm-dd>-<slug>/` — never a new Desktop folder, never committed. The live route
needs the host's provider key; keep the key value out of argv, a config file, a log and evidence. The
run uses a 200M-token soft cap; a run that exceeds it needs a recorded reason.

## Install

```sh
npm install cremator-opencode
```

`@cremator/core` installs as a dependency. Requires Node
`>=22.13.0 <23.0.0 || >=23.4.0`; the OpenCode API is duck-typed by the server
part, never imported.

## Mount

Add the package to the `plugins` list in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "cremator-opencode",
      "options": { "crematorStorageRoot": "C:/Users/TZhen/.cremator/opencode" } }
  ]
}
```

The host loads the package's `./server` export, whose default is
`{ id: "cremator-opencode", setup(context) }` (`dist/server.js`). The `./tui`
and `./gui-experimental` exports add the `/cremate` menu entry. `setup`
registers the context hook, the observation-only `execute.after` hook, the
`necromancy` tool, the event consumer and the server-wide RPC the menu uses.
For a local checkout, build it and use the package directory as a `file:///`
`package` value instead.

The options object carries the durable root and the test-only tool exclusion:

```json
{
  "plugins": [
    { "package": "cremator-opencode",
      "options": { "crematorStorageRoot": "C:/Users/TZhen/.cremator/opencode" } }
  ]
}
```

`crematorStorageRoot` must be absolute; see *Storage*. `crematorJournalFile` is an absolute path
the mount appends one JSON record per line to; it is the JSON-config form of the function sink,
optional, and a write failure never changes an outcome. `excludeTools` is the test-only tool
exclusion described below.

OpenCode 2.4.0 calls `setup` once per location in one server process. Every location shares the
one process-wide mount for the configured durable root, so each session has one ledger and one
ask lane; each location still registers its own tools and RPC, so a chat works whichever folder
the server was started in. A location whose options differ from the first one's joins the mount
and says so on its `mount-shared` journal line; the first mount's options win.

### The `/cremate` command

The desktop and terminal parts register the menu entry; the mount registers no location-scoped
command, because that entry belongs to the server's own folder and duplicated the parts' entry
(ISSUE-607). Both parts call the server-wide `cremator-opencode` RPC, which every location
registers and which runs the same table pass on demand, not gated by the depth latch. The mount
saves the last assembled request per session, so `/cremate` works after a restart without a new
message; a missing save still reports `no-session` (ADR-0076).

### Status surface

The manual pass is observable on the host's RPC event channel (ADR-0073): `started`, `ended`,
`failed`, and `applied` for first-time judged removals. A refusal is a named reason, not a silent
`fired:false`. The desktop part contributes a composer pill showing context fill and the last
applied pass, and its row runs the same `/cremate` RPC. The terminal part shows the lifecycle as
toasts and puts the last pass in the command label. This is display-only: no background pass, no
extra model call, and the terminal footer slot stays deferred (ADR-0062 D4).

## What the mount does

Per primary request, on `context.session.hook("context", ...)`, before the host converts the
messages to the provider request (the host's compaction request uses its own `compaction` hook,
which this adapter does not register):

1. **observe** — re-derive the snapshot from the messages the host handed in (host message ids,
   call ids for tool units, content position otherwise; ADR-0044);
2. **at-rest** — one engine pass (`reason: 'step'`), which plans, validates and stages;
3. **staged commit** — `commit()` splices the staged derivation onto the caller's own array,
   exactly once. Nothing staged means the array is byte-identical and no write happens.

On `session.idle` it journals one turn-end observation (`reason: 'turn-end'`) and **no model
call**. The idle carries no array the host will send, so it runs no applying pass and commits
nothing; the next context hook's step pass plans and commits from the array the host rebuilds.
On `session.compaction.started|delta|ended|failed` it journals one
`compacted` line per phase, with the phase's reason, cost, token count and text length; a host
compaction is never read as a forced loss.

### No result cap

On `tool.hook("execute.after")` the mount journals the tool and call id only. The product never
caps, shortens or rewrites a tool result (ADR-0048): a 200 KB result is left exactly as the tool
produced it, with no marker, no recall id and no `metadata.truncated` from this adapter. The host's
own `ToolOutput.truncate` then runs as it ships — head only, 2,000 lines or 50 KiB, whichever comes
first, with the full text saved to a file — and whatever it stores is what later requests carry. A
result under those limits is stored and sent whole.

OpenCode rebuilds the request from persisted history before every model call, so a context-hook
mutation is not durable. The adapter re-derives `(messages, ledger)` each request and keys
idempotency by intent id; `rehydrateOnResume` is `false` and says so.

### Auto-compaction stays on

The pass reads and rewrites `messages` only. The one other write is the optional
`excludeTools` deletion from `context.tools`; the mount never touches `context.options`, and this
package writes no config. `compaction.auto` stays at its default `true` (ADR-0043).

### Subagent tool off for a test harness

2.4.0 offers the subagent tool as `subagent` (the built-in `opencode.tool.subagent`; the
legacy name `task` is a display/permission alias the host normalizes). The host's `tool.use` policy stops a call at permission time but still offers the tool; to
leave it out of the request, add the name to `excludeTools`:

```json
{
  "plugins": [
    { "package": "file:///C:/Users/TZhen/Desktop/racoons/packages/adapters/opencode",
      "options": { "excludeTools": ["subagent"] } }
  ]
}
```

The adapter deletes each excluded name from `context.tools` before the host builds the request's
tool list. The exported `OPENCODE_TEST_EXCLUDE_TOOLS` is `["subagent"]` for a harness that wants the
same setting from code.

## The necromancy tool

`necromancy` takes a recall id and returns the bytes the ledger archived for that record, verbatim:
a single-part record comes back as its archived bytes, a multi-part record as one entry per part
(never a joined body). For a tool-result unit the archived bytes are the canonical JSON envelope
`{"name":...,"input":...,"result":...}` the unit was recorded under, so the tool name and its
arguments are part of the answer; for a text or reasoning part they are that part's exact text.
The id is verified against the ledger's manifest-derived id; invalid UTF-8 throws instead of
substituting. The necromancy tool is
registered through `context.tool.transform` with the JSON Schema from the spec, so no schema
library is imported. It carries `options.codemode: false`: 2.4.0 offers only tools with that exact
flag as their own entries in a request's tool table, and folds every other registered tool into
the code-mode catalog behind its `execute` tool.

## Capability flags

Each flag is true only where a code path honours it, and false only where the refusal is named
(ISSUE-010). The mount journals its declaration once per session.

| Flag | Value | Backed by / refused because |
| --- | --- | --- |
| `mutateResult` | `false` | `execute.after` observes the tool and call id only; the product never caps or rewrites a result body (ADR-0048), so the host's own truncation runs as it ships. |
| `rewriteHistory` | `false` | Nothing persisted is rewritten; a context hook mutation lives for one request. |
| `revertHistory` | `true` in the mount, `false` from `createOpencodeCapabilities()` | Earned by `test/wire-revert.test.ts`: messages before the cut byte-identical, the named unit gone with its call, receipts present once after their anchor, a second run idempotent, every refusal class leaving the array untouched. The flag exists only beside the derivation that performs it. |
| `atRest` | `true` | The step pass (`reason: 'step'`) plans at rest with no model call; `session.idle` only observes the turn end. |
| `liveTokens` | `true` | `session.step.ended` usage; `inputTokens = input + cache.read + cache.write`, because the host's `input` is already net of cache and passing it raw would make the cached share exceed 1. `session.usage.updated` is a session roll-up and is not used. |
| `log` | `true` | One ledger per session under the storage root. |
| `appendRecords` | `false` | An appended record must be durable and host-accepted; a context-hook message is neither. A receipt renders a ledger record, it is not one. |
| `rehydrateOnResume` | `false` | The applied-plan index is in-process; a restart re-applies nothing. |

## Storage

One durable ledger per session (ADR-0013): `<crematorStorageRoot>/sessions/<sessionId>/ledger.sqlite`
with its blob tree in the sibling `blobs/` directory. A recall id keeps working after a restart of
the same session. The same directory holds `mount-state.json` (durable ask and install facts,
ADR-0063) and `last-request.json` (the last assembled request, ADR-0076), so `/cremate` works right
after a restart. `':memory:'` is for tests only; no configuration value selects it.

The default root is `~/.cremator/opencode` (`C:\Users\TZhen\.cremator\opencode` on one owner
device, `C:\Users\TZ\.cremator\opencode` on the other). The host's own data directory is never guessed and
never written. A relative root and a per-session `{databasePath, blobRoot}` pair are typed
refusals. A session whose id cannot be a directory name is refused the same way. If the ledger
cannot open, the request proceeds with the messages untouched and journals
`storage-unavailable`; the open is retried at the next hook.

## License

Apache-2.0.

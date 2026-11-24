# Subagent denial — one patch row set, both arms, with a probe that must fail

Status: design, verified against `dsh 0.2.1-rc.2` by `--dump-config` only. No
dsh run was made while writing this file (the BUILD phase forbids it). The probe
below is the run that proves it at RUN time; until that probe fails as
specified, this design is unproven.

## What dsh actually offers

Checked in the installed package
(`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/`):

| Fact | Where |
| --- | --- |
| Five rows register the delegation surface in `@deepseek-ai/dsh-base`'s bundle patch: `tool-subagent` (`subagent`), `tool-subagent-fork` (`subagent_fork`), `tool-workflow` (`workflow`), `tool-subagent-control` (`send_message`, `interrupt_agent`), `tool-subagent-list-agents` (`list_agents`). | `dsh-base/cordis.patch.yml` lines ~359–397 |
| Three provider rows back them: `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process`, plus `workflow-ptc`. | same file |
| `ToolRestriction` (`{ allow?: string[], deny?: string[] }`) exists, but it is a **per-subagent** filter on a delegation descriptor (`toolFilter`), not a deployment switch; it cannot disable the delegation tools themselves. | `dsh-tools/lib/types/index.d.ts` § `ToolRestriction`; `dsh-subagent` descriptor types |
| `dsh-tools` has pre-dispatch decision points (`allow` / `deny` / `ask` / `cancel`) but no config surface that lists denied tool names. Its only `deny` field is `ToolRestriction`'s. | `dsh-tools/lib/index.js` § `prepareExecution` |
| A `--patch` overlay row with `- id: <row>` and `disabled: true` composes to `disabled: true` on that row in `--dump-config`. Verified for `tool-subagent`, `tool-subagent-fork`, `tool-workflow`, `tool-subagent-control`, `tool-subagent-list-agents`, `subagent-spawn-in-process`, `subagent-fork-in-process`, `workflow-ptc`. | `node .../dsh/lib/bin.js --profile headless --patch <file> --dump-config` |
| A model call to a name registered nowhere yields `ToolNotFoundError`, code `UNKNOWN_TOOL`, text `Error: unknown tool "<name>"`, recorded as a `tool/result` with `isError: true`. | `dsh-tools/lib/index.js` § `ToolNotFoundError`, § `createExecution`, § `toolErrorResult` |

So the deny is **row removal**, not a permission preset. There is no
"tool-deny list" config in this dsh version; anyone looking for one should stop
looking and use the patch rows.

## The patch file (identical bytes in both arms)

Both arms get this file as an extra `--patch` layer, written by the launcher
into the arm's evidence dir, never into `~/.dsh`:

`<evidence>/subagent-deny.yml`

```yaml
# Bench law: no delegation. Both arms load this same file. Removing any row
# re-opens one delegation path, so the probe below names each row's tool.
- id: tool-subagent
  disabled: true          # removes `subagent`
- id: tool-subagent-fork
  disabled: true          # removes `subagent_fork`
- id: tool-workflow
  disabled: true          # removes `workflow` (fan-out to many children)
- id: tool-subagent-control
  disabled: true          # removes `send_message`, `interrupt_agent`
- id: tool-subagent-list-agents
  disabled: true          # removes `list_agents`
- id: subagent-spawn-in-process
  disabled: true          # removes the `spawn` provider behind the tools
- id: subagent-fork-in-process
  disabled: true          # removes the `fork` provider
- id: workflow-ptc
  disabled: true          # removes the workflow PTC bridge
```

Why eight rows and not one: disabling `tool-subagent` alone leaves
`subagent_fork` and `workflow` mounted and visible to the model, which is a
different bench. Removing the provider rows as well means a future row that
re-adds a tool by name has no provider to bind, so the deny fails closed rather
than open.

What is deliberately **not** disabled: `tool-fs`, `tool-fs-search`, `tool-bash`,
`tool-pwsh`, `tool-todo`, `tool-skill`, `tool-web`, `compaction-basic`,
`tool-result-pruner`. Those are the work surface; removing them would measure
the wrong thing. `compaction-basic` must stay in **both** arms: it is the
vanilla behaviour the racoons arm is compared against.

## Where the patch goes in each arm

| Arm | Extra patch layers, in order |
| --- | --- |
| vanilla | `tier3-patch.yml` (or the launcher's equivalent), then `subagent-deny.yml` |
| racoons | `tier3-patch.yml`, then the `racoons-mount` insert row, then `subagent-deny.yml` |

`--patch` is repeatable and later layers win, so putting the deny **last** means
no earlier layer can re-enable a removed row. The launcher must pass it last;
the runbook checks that in `result.json`'s recorded launch command.

## The probe: a summon that MUST fail

Two legs, both cheap in tokens, both run per arm before the real bench run.
Each leg is one `dsh --profile headless --json` process against the live route
(the live route is needed because a mock run cannot attempt a real summon, and
because "the tool is absent" must be observed by a live model).

### Leg A — the tool list (zero-cost, no model call)

`dsh --profile headless --patch <deny> --dump-config` and assert none of the eight
row ids carries `disabled: false`. This is a static check; it proves composition
but not behaviour. It is cheap enough to run in CI-less form on every launch.

Better: after any run that reached a model, read the session log's
`request/header` event and assert the tool-name set excludes all six tool
names. That reads what the model was actually offered, not what the config said.

Leg A, as the operator or a later `probe-deny.mjs` runs it:

```js
const names = header.tools.map((tool) => tool.name);
const DENIED = ['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent', 'list_agents'];
const present = DENIED.filter((name) => names.includes(name));
```

No probe script is committed in this phase; the legs below are the specification
one must implement.

A pre-bench measurement on 2026-10-22 (tier-3 smoke session log,
`scratchpad/dsh-rig/2026-10-22-tier3-smoke/`) shows the undefended header
carries `subagent`, `subagent_fork`, `workflow`, `send_message`,
`interrupt_agent`, `list_agents`. That is the positive control: without the
patch the names are there, so a header lacking them is evidence of the deny and
not of a broken log.

### Leg B — the scripted summon (one short real run)

Task text, verbatim, same in both arms:

```text
Call the subagent tool with the prompt "reply READY" and report its result. If
the tool is not available, reply with exactly: DENY-CONFIRMED then the tool error
text you received.
```

Pass/fail is read from the session log, not from the answer's wording:

| Assertion | Pass condition |
| --- | --- |
| A `tool/call` named `subagent` exists | **The run may or may not contain one.** The model is free to answer from the header alone. If absent, the run proves only the header leg; mark the probe `partial`, not `pass`. |
| If a `tool/call` named `subagent` exists, the following `tool/result` has `isError: true` | required |
| That result's `error.info.name` is `ToolNotFoundError` and `error.info.code` is `UNKNOWN_TOOL` | required |
| The result text starts with `Error: unknown tool "subagent"` | required |
| No `subagent/descriptor` or `subagent/catalog` session event appears | required |
| The final assistant text contains `DENY-CONFIRMED` | required for `pass`, not for `partial` |

The output shape, printed by `probe-deny.mjs` and appended to
`<evidence>/deny-probe.txt`:

```text
arm=<racoons|vanilla>
legA header-tools=<N> denied-present=<comma list or none> verdict=<pass|fail>
legB tool-call=<present|absent> result-error=<yes|no> code=<UNKNOWN_TOOL|other> text=<first 80 chars> verdict=<pass|partial|fail>
DENY <PASS|PARTIAL|FAIL> arm=<name> reason=<one line>
```

Exit codes: `0` = both legs pass; `3` = leg B partial (header-only proof);
`1` = any fail. A `partial` is not good enough to start the bench: the operator
re-runs leg B until the model actually attempts the call, or records the partial
and escalates to the PM. This is the "proven non-vacuously" requirement in
ISSUE-018 §3 — a probe that never tried cannot prove anything.

## Perturbation (the probe must be able to fail)

Apply this to prove the probe is not vacuous, once per bench campaign:

- Remove `- id: tool-subagent` and `- id: tool-subagent-fork` from
  `subagent-deny.yml`, re-run leg B. The run must now contain a `tool/call`
  named `subagent` whose `tool/result` is **not** an error, and leg A must list
  `subagent` in the header. Restore the file, re-run, both green.

A probe that stays green with the deny removed is measuring nothing.

## The one thing this design cannot promise offline

`dsh-tool-pwsh`/`dsh-tool-bash` remain live, and a determined model can start a
second `dsh` process from the shell, which is a subagent by another name. That
is out of scope for this bench: the brief does not mention dsh, and the model has
no reason to look for it. The rubric's reviewer notes the case if it happens;
it is not a deny failure.

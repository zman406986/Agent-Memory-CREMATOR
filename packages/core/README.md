# @cremator/core

Harness-agnostic context hygiene for coding agents. It removes provably useless content from a
transcript while it is still fresh, records every removal in a trash ledger under a recall id, and
never summarizes. Deterministic code never judges usefulness and never protects a content class; it
only proves a failed search (Seal), a stale read, and a superseded re-read. The agent itself answers
keep-or-forget verdicts at the depth-triggered table.

This package carries the engine and no harness code: the meter, the episode tracker, the Seal and
verdict-protocol rules with the two proof rules (stale read, superseded read), the all-or-nothing
guard, the append-only SQLite trash ledger with content-addressed blobs and export/hydrate, and the
revert planner.

## Install

```sh
npm install @cremator/core
```

Requires Node `>=22.13.0 <23.0.0 || >=23.4.0` (flagless `node:sqlite`). The
adapters install it as a dependency; install it directly only when using the
core without an adapter.

## Use

```ts
import { CharHeuristicTokenMeter, CoverageMeter, Meter } from '@cremator/core';

const meter = new Meter(new CharHeuristicTokenMeter());
const tokens = meter.estimate(new TextEncoder().encode('a tool result body'));
```

`CoverageMeter` answers the other question — bytes per source path — and adds no threshold of its
own (ADR-0006). The engine, guard and ledger are the other entry points; every export is typed and
declared in `dist/`. Most users want a harness adapter instead of wiring the engine themselves.

## Related

- `cremator-dsh` — the dsh harness adapter, including the `cremator-dsh/plugin` mount entry.
- Full design and limits: the project README at
  https://github.com/zman406986/Agent-Memory-CREMATOR

## License

Apache-2.0.

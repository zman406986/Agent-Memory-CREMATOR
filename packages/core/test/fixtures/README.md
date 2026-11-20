# Offline fixtures

These files need no LLM, API key, provider package, or network.
All content is invented for these tests.
Paths name files in an example project. The loader never opens those paths.

Each scenario is one JSON file. This is a complete small example.

```json
{
  "version": 1,
  "sessionId": "session-example",
  "revision": "revision-1",
  "currentTurnOrdinal": 1,
  "completedThroughTurnOrdinal": 0,
  "currentStepOrdinal": 1,
  "cache": { "kind": "warm", "watermarkNodeIndex": 0 },
  "nodes": [
    {
      "id": "call-1", "kind": "message", "role": "assistant",
      "turnOrdinal": 1, "stepOrdinal": 1, "toolCallIds": ["read-1"],
      "content": { "utf8": "Read src/settings.ts." }
    },
    {
      "id": "result-1", "kind": "tool-result", "callId": "read-1",
      "turnOrdinal": 1, "stepOrdinal": 1, "embeddedRecords": [],
      "content": { "utf8": "export const retries = 3;\n" },
      "evidence": {
        "kind": "read", "target": null, "sourceRecallId": null,
        "paths": [{ "pathKey": "src/settings.ts", "displayPath": "src/settings.ts", "title": null, "lineCount": 1, "byteLength": null, "outcome": "unknown" }]
      }
    }
  ]
}
```

`version` must be `1`. All shown fields are required.
IDs and revisions are nonempty strings.
Ordinals are nonnegative integers. Steps count across the session.
Nodes stay in transcript order. Nodes in one step may share its ordinal.
`completedThroughTurnOrdinal` records the last completed turn.
A completed turn closes its search episodes. Assistant prose alone does not.

A message has a role and `toolCallIds`, even when that list is empty.
Roles are `system`, `developer`, `user`, or `assistant`.
A tool result has a nonempty `callId`, evidence, and `embeddedRecords`.
The call ID matches one declared by an assistant message.
A partial transcript may start after its call message.
`crlf-bom.json` does this so its first node contains the BOM.

`content.utf8` is the node body. JSON escapes become literal content bytes.
Optional `content.repeat` repeats that string before UTF-8 encoding.
It defaults to `1` and must be a positive integer.
This keeps the large log fixture small on disk.
The loader does not add separators or change line endings.
Use `\r\n` for CRLF and `\ufeff` for a BOM.
Keep these escapes in JSON so Git line-ending settings cannot change them.
This format covers UTF-8 text. It does not encode arbitrary binary data.

The loader creates fresh `Uint8Array` bodies, byte lengths, and SHA-256 hashes.
It sets each tool result's `evidence.source` from that result's original bytes.
Path `byteLength` and `lineCount` describe the file searched or read.
They may be `null` when the full file was not measured.
They are not the byte length and line count of a search output.

Evidence kinds are `read`, `search`, `glob`, `write`, or `other`.
`target` is `null` or `{ "key": "symbol:parse", "label": "parse" }`.
`paths` contains explicit path evidence. Outcomes are `hit`, `miss`, or `unknown`.
Use `miss` only when the scenario supplies proof for that target.
`sourceRecallId` is `null` for these original results.
`embeddedRecords` lists byte ranges for generated records already inside a result.

Cache state is one of these objects.

```json
{ "kind": "warm", "watermarkNodeIndex": 2 }
{ "kind": "cold", "boundary": { "kind": "resume", "observedAtMs": 1792483200000 } }
{ "kind": "unknown" }
```

The warm watermark is a node index from zero through the node count.
Cold boundary kinds are `resume`, `idle-past-ttl`, or `model-switch`.
The timestamp is explicit fixture data. The loader never reads the clock.

Offsets are zero-based bytes. The end is exclusive.
The loader rejects an embedded record range past the node's byte length.
It returns `retentionEvidence: []`. Tests needing span evidence add it explicitly.

Load a scenario from a test next to these files.

```ts
import { loadFixture } from './load.ts';
const snapshot = loadFixture(new URL('./cap-under.json', import.meta.url));
```

String paths are also accepted. They use the caller's working directory.
`types.ts` temporarily holds the design's exact snapshot contracts.
C1's types were absent when this harness was added.
Once C1 lands, replace those declarations with type-only exports.
The loader has no runtime imports from product code.
Capabilities belong to engine options, outside a snapshot.
Tests must pass them explicitly. There is no default capability tier here.
An application port can return this snapshot from its `snapshot()` method.
Atomic application and receipt handling belong to the later engine tests.
For entry-time cap tests, remove the selected incoming result from the snapshot.
Pass that node separately as the entry result. It is not yet inserted at entry.
These fixtures do not choose product defaults or implement cap rules.

`MockLLM` is a synchronous queue of assistant replies.
Each `respond(messages)` call consumes one reply.
It records every message list, including requests after script exhaustion.
The script, returned replies, and request records are independent copies.
Exhaustion throws an error with the request number and script length.
It has no timers, randomness, I/O, or provider SDK.

```ts
import { MockLLM } from './mock-llm.ts';
const model = new MockLLM([
  { toolCalls: [{ callId: 'read-1', name: 'read_file', arguments: '{"path":"src/settings.ts"}' }] },
  { text: 'The retry limit is 3.' },
]);
const first = model.respond([{ role: 'user', text: 'Read the retry limit.' }]);
const second = model.respond([
  { role: 'assistant', ...first },
  { role: 'tool', callId: 'read-1', text: 'export const retries = 3;' },
]);
const requests = model.requests;
```

A reply can have `text`, `toolCalls`, or both.
Tool call arguments are a literal JSON string. The stand-in does not execute tools.
Tests feed tool results back with the same `callId`.

Run from the repository root with Node that supports TypeScript stripping.
No install step is needed.

```sh
node --experimental-strip-types --test packages/core/test/fixtures/fixtures.test.ts
```

The tests check all six scenarios, exact bytes, BOM, CRLF, invalid inputs,
and the reply queue. They do not import unfinished product code.

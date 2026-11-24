# core, offline

`offline.ts` is the smallest honest use of `@cremator/core` with no harness around it: a fake tool
result, a manual `forget` resolved to that result's unit, `RacoonsEngine` planning it and the
`Guard` approving it against an in-memory trash ledger, then the ledger's `recall` read restoring
the exact bytes by the id the receipt names. `Meter` estimates tokens.

```sh
npm run build                                    # repo root; writes the dist trees
node --experimental-strip-types examples/core-offline/offline.ts
```

Expected output (the recall id differs on every run):

```text
estimated tokens: 9
forget: applied
receipt: [not retained] src/needle.ts — about: auth retry path · necromancy recall:sha256:…
result still in transcript: false
recalled 34 bytes byte-exact: true
```

A forget needs no cap: the human names a path and the core resolves it to the one unit that holds
those bytes (ADR-0014 scrapped the entry-time cap). The guard needs a real ledger: here an
in-memory SQLite one; the mounts use a durable per-session file (ADR-0013). The host half of the seam
is the small `InMemoryPort` in the file — it holds the transcript and applies the approved
checkpoint-revert, which is all any adapter does.

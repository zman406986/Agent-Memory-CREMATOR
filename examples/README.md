# Examples

Two runnable entry points. Both work against the built packages (`npm run build` at the repo root
first).

- `dsh-mount/` — mount the shipped `cremator-dsh/plugin` entry with one `dsh --patch` row.
- `core-offline/` — drive the core alone: estimate, forget a result, recall it by id. No harness,
  no network, no LLM.

```sh
npm run build
node --experimental-strip-types examples/core-offline/offline.ts
```

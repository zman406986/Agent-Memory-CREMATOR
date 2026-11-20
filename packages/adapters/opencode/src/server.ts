/**
 * The 2.2.5 plugin module a host loads from its `plugins` list (ISSUE-192;
 * ADR-0017).
 *
 * OpenCode 2.2.5's loader reads a default export as one of two variants —
 * `{ id, setup(context) }` or `{ id, effect }` — and refuses anything else with
 * `Plugin must export a default definition with an id and an effect or setup
 * function.` (loader schema in the installed binary; `@opencode/plugin@2.2.5`
 * `dist/promise/plugin.d.ts` `Plugin`). This module is the `setup` variant, and
 * `package.json` maps `./server` to it.
 *
 * **No host import.** The file imports the adapter's own modules only, so the
 * package carries no runtime dependency on `@opencode/plugin`; the type-only
 * devDependency is used by tests.
 *
 * **Options.** The config tuple form (`["cremator-opencode", {...}]`) carries
 * JSON; `plugin.ts` reads `crematorStorageRoot`, `excludeTools` and
 * `crematorJournalFile` from it. A storage root must be absolute; an unusable
 * value is refused by the storage seam at mount, journalled, and the request
 * messages are left untouched (ADR-0013). A journal file is an absolute path
 * the mount appends one JSON record per line to; it is the durable form of the
 * function sink a test supplies.
 */

import { OPENCODE_PLUGIN_NAME, createOpencodePlugin } from './plugin.js';
import type { OpencodePluginContext, OpencodePluginDefinition } from './host.js';

/** The default export's shape, as the 2.2.5 loader reads it. */
export type OpencodeServerModule = OpencodePluginDefinition;

/**
 * The default export. `id` is the package name, so a loader log line has one
 * value to record; `setup` is called once per process and its cleanup runs at
 * dispose.
 */
const module: OpencodeServerModule = Object.freeze({
  id: OPENCODE_PLUGIN_NAME,
  setup: (context: OpencodePluginContext) => createOpencodePlugin().setup(context),
});

export default module;

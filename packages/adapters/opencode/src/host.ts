/**
 * Duck-typed OpenCode 2.4.0 host shapes (ISSUE-192; ADR-0044).
 *
 * Zero imports. These interfaces copy the field names of
 * `@opencode/plugin@2.4.0` / `@opencode/ai@2.4.0` / `@opencode/schema@2.4.0`:
 * the `context` hook's `SessionContext`, `Message { id?, role, content[] }`, the
 * `tool.transform` editor, `tool.hook('execute.after')`, the event stream and
 * step usage. The host packages stay devDependencies used by tests only; the
 * adapter reads a host object without a runtime dependency on the host.
 *
 * Two shapes are deliberately open rather than closed unions:
 *   - `OpencodeContentPart.type` is a `string` and every part keeps its extra
 *     fields under an index signature. A part this build does not model is still
 *     a part the host sent; the snapshot projects it as evidence and never drops
 *     it silently.
 *   - every message/part carries `[field: string]: unknown`, so a host field the
 *     adapter never reads survives on the caller's object untouched.
 *
 * `OpencodeMessage` carries three adapter-owned marker fields. They are written
 * only on a receipt message the adapter itself inserts; they are never read from
 * host data. The host's `Message` schema has no metadata field, so a marker on
 * the message object is the only in-array place a receipt can keep its record
 * identity (ADR-0044 decision 1).
 */

/** One token count as the host reports it at `session.step.ended`. */
export interface OpencodeTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: {
    readonly read: number;
    readonly write: number;
  };
  readonly [field: string]: unknown;
}

/** The provider message roles 2.4.0 declares. */
export type OpencodeMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * The `content` element of a `Message`. `type` stays open on purpose; an
 * unknown part is evidence, never a node.
 */
export interface OpencodeContentPart {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface OpencodeTextPart extends OpencodeContentPart {
  readonly type: 'text';
  readonly text: string;
}

export interface OpencodeReasoningPart extends OpencodeContentPart {
  readonly type: 'reasoning';
  readonly text: string;
}

export interface OpencodeMediaSource {
  readonly type: string;
  readonly url?: string;
  readonly [field: string]: unknown;
}

export interface OpencodeMediaAsset {
  readonly source: OpencodeMediaSource;
  readonly [field: string]: unknown;
}

export interface OpencodeMediaPart extends OpencodeContentPart {
  readonly type: 'media';
  readonly media: OpencodeMediaAsset;
  readonly filename?: string;
}

/** One tool call: arguments and name, no result yet. */
export interface OpencodeToolCallPart extends OpencodeContentPart {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly namespace?: string;
  readonly input: unknown;
}

export interface OpencodeToolContentText {
  readonly type: 'text';
  readonly text: string;
}

export interface OpencodeToolContentFile {
  readonly type: 'file';
  readonly uri: string;
  readonly mime: string;
  readonly name?: string;
}

export type OpencodeToolContent = OpencodeToolContentText | OpencodeToolContentFile;

/** The tagged result value 2.4.0 puts on a `tool-result` part. */
export type OpencodeToolResultValue =
  | { readonly type: 'json'; readonly value: unknown }
  | { readonly type: 'text'; readonly value: unknown }
  | { readonly type: 'error'; readonly value: unknown }
  | { readonly type: 'content'; readonly value: readonly OpencodeToolContent[] };

/** One tool result: the unit of removal, already tagged by the host. */
export interface OpencodeToolResultPart extends OpencodeContentPart {
  readonly type: 'tool-result';
  readonly id: string;
  readonly name: string;
  readonly namespace?: string;
  readonly result: OpencodeToolResultValue;
}

/** A provider context checkpoint. Never a node; evidence only. */
export interface OpencodeCompactionPart extends OpencodeContentPart {
  readonly type: 'compaction';
  readonly provider: string;
  readonly id?: string;
  readonly encrypted?: string;
  readonly text?: string | null;
}

export interface OpencodeEffortPart extends OpencodeContentPart {
  readonly type: 'effort';
  readonly effort?: string;
  readonly previous?: string;
}

/**
 * One request message. `id` is optional in 2.4.0; a message without one is keyed
 * by its position (ADR-0044 decision 1). `content` is mutable because the port's
 * `commit()` splices the caller's own array.
 */
export interface OpencodeMessage {
  readonly id?: string;
  readonly role: OpencodeMessageRole;
  content: OpencodeContentPart[];
  /** Set only on a receipt message the adapter inserted. */
  readonly racoonsRecordId?: string;
  /** Set only on a receipt message: the ledger record it renders. */
  readonly racoonsReceiptOf?: string;
  /** Set only on a receipt message: the node the plan forgot. */
  readonly racoonsForgottenNodeId?: string;
  readonly [field: string]: unknown;
}

/** The `context` hook's payload: one request's whole assembled state. */
export interface OpencodeSessionContext {
  readonly sessionID: string;
  readonly model?: unknown;
  readonly system?: readonly unknown[];
  messages: OpencodeMessage[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly agent?: unknown;
  /** The request's tool table, by effective name. Deleting a key removes the tool. */
  tools?: Record<string, { readonly description: string;
    readonly input: Readonly<Record<string, unknown>> }>;
  readonly [field: string]: unknown;
}

/**
 * The `compaction` hook's payload (`SessionCompaction` in 2.4.0):
 * `SessionContext` plus the host's own summary slot. Setting `result` supplies
 * the summary and skips the model call — the one thing this product must never
 * do — so the mount reads the field never and sets it never (ADR-0074 decision
 * 5). The type states it so the omission is deliberate, not an oversight.
 */
export interface OpencodeCompactionContext extends OpencodeSessionContext {
  /** The host's summary override. Never read, never set. */
  readonly result?: unknown;
}

/** The execution context a registered tool receives. */
export interface OpencodeToolContext {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly [field: string]: unknown;
}

/** What `execute` may return: the host wraps it into the model's tool result. */
export interface OpencodeToolResult {
  readonly output?: unknown;
  readonly content?: string | readonly OpencodeToolContent[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The `options` a registered tool may carry (`Tool.Options` in
 * `@opencode/schema@2.4.0`).
 *
 * `codemode` is not cosmetic. When the agent may run code, the host offers only
 * tools whose `options.codemode` is exactly `false` as their own entries; every
 * other tool is folded into the single code-mode tool's catalog. A tool added
 * without this key is accepted by the editor and then never named in the
 * request (`Tool.snapshot` in the 2.4.0 binary).
 */
export interface OpencodeToolOptions {
  readonly codemode?: boolean;
  readonly namespace?: string;
  readonly permission?: string;
}

/** One tool exactly as `context.tool.transform`'s editor accepts it. */
export interface OpencodeToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (`Tool.ValueSchema` accepts a plain JsonSchema object). */
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly options?: OpencodeToolOptions;
  readonly execute: (
    input: unknown, context: OpencodeToolContext,
  ) => Promise<OpencodeToolResult>;
}

export interface OpencodeToolEditor {
  add(tool: OpencodeToolDefinition): void;
}

/** The slice of `tool.hook('execute.after')`'s input this mount reads. */
export interface OpencodeAfterToolInput {
  readonly tool: string;
  readonly sessionID: string;
  /** The tool call id; 1.x called it `callID`. */
  readonly id: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly input?: unknown;
  readonly status?: 'completed' | 'error';
  /**
   * The result object the host is about to store. The host reads
   * `event.result.content` after the hook, then applies its own
   * `ToolOutput.truncate`. This adapter reads the field for observation only and
   * never assigns it: the product does not cap or rewrite a result body
   * (ADR-0048).
   */
  result?: OpencodeToolResult;
  readonly error?: unknown;
  readonly [field: string]: unknown;
}

/**
 * The kind a `session.step.ended` row may declare for its request. 2.4.0's
 * declared payload states none; `generate`/`ask` are the names a host that
 * reports the transient lane uses, and the mount reads them defensively
 * (`meter.ts` `requestKindOf`) instead of assuming the field exists.
 */
export type OpencodeStepRequestKind = 'main' | 'ask' | 'generate';

/** One event from `context.event.subscribe`; `data` is the 2.x payload. */
export interface OpencodeHostEvent {
  readonly type: string;
  /**
   * The open 2.x payload. A step row may carry `requestKind` (or the legacy
   * `request_kind`) naming one of `OpencodeStepRequestKind`; absent means the
   * host stated nothing and the mount accounts the row as a main turn while
   * journaling `requestKind: 'unstated'`.
   */
  readonly data?: Readonly<Record<string, unknown>> & {
    readonly requestKind?: OpencodeStepRequestKind;
    readonly request_kind?: OpencodeStepRequestKind;
  };
  readonly [field: string]: unknown;
}

/**
 * One transient generation request (`session.generate` in 2.4.0's promise API).
 * It reads the active session context, appends `prompt`, makes one model
 * request and returns the reply text; it mutates no session history.
 *
 * 2.4.0 takes no `AbortSignal` here, so the mount cannot cancel the call. The
 * host-reachable cancellation seam is the event stream instead:
 * `session.execution.interrupted` with `{sessionID, reason}` (ISSUE-413). The
 * mount subscribes to it and stops waiting; the call itself is abandoned.
 */
export interface OpencodeGenerateInput {
  readonly sessionID: string;
  readonly prompt: string;
}

export interface OpencodeGenerateOutput {
  readonly text: string;
  /**
   * The host's own reading of this transient request. 2.4.0 declares the
   * `session.generate` success body as `{text, tokens, cost}`
   * (`@opencode/protocol@2.4.0` `dist/groups/session.d.ts`;
   * `@opencode/client@2.4.0` `SessionGenerateResponse`), so the mount records
   * the ask lane's exact cost and token counts from here. Shape:
   * `TokenUsage.Info` (`input`, `output`, `reasoning`, `cache: {read, write}`),
   * read through the same `tokenUsageOf` mapping as a step row.
   */
  readonly tokens?: unknown;
  /** The host's stated cost for this generate call. Telemetry only. */
  readonly cost?: unknown;
  /**
   * The open usage field an older host or a bench mock may state instead of
   * `tokens`. It is the fallback: a declared `tokens` object wins.
   */
  readonly usage?: unknown;
}

/**
 * One manual command invocation (`context.command.execute` in 2.4.0). The host
 * names the live session; `prompt` and `delivery` are the host's own payload
 * and are never read by this adapter.
 */
export interface OpencodeCommandInvocation {
  readonly sessionID: string;
  readonly prompt?: unknown;
  readonly delivery?: unknown;
  readonly [field: string]: unknown;
}

/** One command exactly as `context.command.transform`'s editor accepts it. */
export interface OpencodeCommandDefinition {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: OpencodeCommandInvocation) => Promise<void>;
}

export interface OpencodeCommandEditor {
  add(definition: OpencodeCommandDefinition): void;
}

/**
 * The optional command seam (`CommandDomain` in 2.4.0's promise API). A host
 * that predates it simply has no `command` field; the mount then registers no
 * manual command and still mounts.
 */
export interface OpencodeCommandDomain {
  transform(
    callback: (editor: OpencodeCommandEditor) => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * The event channel a registration returns (`RpcRegistration.events` in
 * `@opencode/plugin@2.4.0`; ADR-0073). The mount calls `emit` with a name the
 * definition declares and that event's payload, and never awaits it.
 */
export interface OpencodeRpcEvents {
  emit(name: string, data: Readonly<Record<string, unknown>>): Promise<void>;
}

/**
 * What `rpc.register` answers. `events` is optional in this structural shape
 * because a host (or a test's fake) may answer without a channel: the mount
 * guards the result and publishes nothing, and never throws because the seam
 * is absent.
 */
export interface OpencodeRpcRegistration {
  readonly events?: OpencodeRpcEvents;
  /** The host's own registration cleanup; present on the 2.4.0 RPC service. */
  dispose?(): Promise<void> | void;
}

/**
 * The server-wide RPC seam (`Context.rpc` in 2.4.0). The menu parts call it
 * because `context.command.transform` registers a command for the server's
 * own location only; a session in another folder cannot see that command.
 */
export interface OpencodeRpcDomain {
  register(
    definition: Readonly<Record<string, unknown>>,
    handlers: Readonly<Record<string,
      (input: unknown, context: unknown) => Promise<unknown> | unknown>>,
  ): Promise<OpencodeRpcRegistration>;
}

/**
 * The `experimental.idle` hook's payload (`SessionIdle` in 2.4.0): the session
 * about to go idle, and the background work still running. The host awaits the
 * hook inside its single drain before queued input runs (ADR-0062 D2). The
 * mount reads only `sessionID`; `background` stays open evidence.
 */
export interface OpencodeIdleHookInput {
  readonly sessionID: string;
  readonly background?: readonly unknown[];
  readonly [field: string]: unknown;
}

/** The model-catalog slice this mount reads (`Model.Info` in 2.4.0). */
export interface OpencodeModelInfo {
  readonly limit?: { readonly context?: number };
  readonly [field: string]: unknown;
}

/**
 * 2.4.0's model catalog seam (`Context.model`). The mount reads it only to name
 * the context window a newly selected model declares (ISSUE-432); it never
 * overrides a window the operator configured. Optional: a host that lacks it
 * mounts and still observes a switch.
 */
export interface OpencodeModelCatalog {
  get(providerID: string, modelID: string): OpencodeModelInfo | undefined;
}

/**
 * The location one plugin activation serves (`Context.location` in 2.4.0).
 *
 * The host activates a plugin once per location. `directory` is the folder the
 * activation was created for; commands, tools and session hooks registered by
 * that activation belong to that folder. The fields are optional because a
 * host that predates the field still mounts; an activation that names no
 * directory is handled by the process-wide shared mount's primary lease.
 */
export interface OpencodeLocationInfo {
  readonly directory?: string;
  readonly workspaceID?: string;
  readonly [field: string]: unknown;
}

/**
 * The part of the 2.4.0 setup context this adapter uses. Structural, so the
 * real `Context` satisfies it without the adapter importing the host at runtime.
 *
 * `session.generate` is optional because it is only needed by the bench-only
 * ask: a mount with the ask off must work on a host whose context lacks it, and
 * a mount with the ask on checks for it at runtime (`createOpencodePlugin`).
 */
export interface OpencodePluginContext {
  readonly options?: Readonly<Record<string, unknown>>;
  /**
   * The location this activation serves. The host calls `setup` once per
   * location in one process; a single durable mount is shared by all of them
   * and each activation registers its own location-scoped command and hooks.
   */
  readonly location?: OpencodeLocationInfo;
  readonly session: {
    hook(
      name: 'context',
      callback: (input: OpencodeSessionContext) => Promise<void> | void,
    ): Promise<unknown>;
    /**
     * 2.4.0's checkpoint-summary hook (`SessionHooks['compaction']`, ADR-0074).
     * The payload is the same `SessionContext` plus the host's `result` slot;
     * the mount applies settled removals to `messages` and leaves `result`
     * unset, so the host's own summary prompt and model still run.
     */
    hook(
      name: 'compaction',
      callback: (input: OpencodeCompactionContext) => Promise<void> | void,
    ): Promise<unknown>;
    /**
     * 2.4.0's transient-request hook (`SessionHooks['generate']`, ADR-0074): the
     * `session.generate` request the bench-only ask makes. A host that predates
     * the hook refuses the registration; the mount journals the refusal and
     * keeps mounting.
     */
    hook(
      name: 'generate',
      callback: (input: OpencodeSessionContext) => Promise<void> | void,
    ): Promise<unknown>;
    /**
     * 2.4.0's awaited idle seam (`SessionHooks['experimental.idle']`). A host
     * that predates it refuses the registration; the mount then keeps the
     * `session.idle` event path for the idle-origin ask (ISSUE-373).
     */
    hook(
      name: 'experimental.idle',
      callback: (input: OpencodeIdleHookInput) => Promise<void> | void,
    ): Promise<unknown>;
    /** 2.4.0's transient generation seam; absent on a host that predates it. */
    generate?(
      input: OpencodeGenerateInput,
    ): Promise<OpencodeGenerateOutput>;
  };
  readonly tool: {
    transform(callback: (editor: OpencodeToolEditor) => Promise<void> | void): Promise<unknown>;
    hook(
      name: 'execute.after',
      callback: (input: OpencodeAfterToolInput) => Promise<void> | void,
    ): Promise<unknown>;
  };
  /**
   * The manual-command seam 2.4.0 exposes as `Context.command`. Optional: a
   * host that lacks it mounts without a `/cremate` command, and the mount says
   * so on the journal instead of failing every hook.
   */
  readonly command?: OpencodeCommandDomain;
  /**
   * The model catalog 2.4.0 exposes as `Context.model` (ISSUE-432). Optional:
   * a host that lacks it still mounts, and a switch is named without a window.
   */
  readonly model?: OpencodeModelCatalog;
  /**
   * The server-wide RPC seam 2.4.0 exposes as `Context.rpc`. The menu parts
   * call it because a plugin command is scoped to the server's own location,
   * while sessions opened in another folder get an empty command list.
   */
  readonly rpc?: OpencodeRpcDomain;
  readonly event: {
    subscribe(options?: { readonly types?: readonly string[] }): AsyncIterable<OpencodeHostEvent>;
  };
}

export type OpencodeCleanup = () => Promise<void> | void;

/** The default export 2.4.0's loader accepts. */
export interface OpencodePluginDefinition {
  readonly id: string;
  readonly setup: (context: OpencodePluginContext) => Promise<OpencodeCleanup>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when this host result is an error or a cancelled-tool envelope — a
 * failure the model may need, never removable context (1f diagnosis FIX 2).
 *
 * Two shapes:
 *   - the host's `error` tag, whatever the tool;
 *   - a `question` result whose value carries an `error` object, which is how
 *     the non-interactive host cancels the tool (`{"error":{"type":
 *     "tool.execution","message":"This non-interactive run cannot ask the user
 *     questions …"},"content":[]}`). The tag a host picks for the cancellation
 *     is not part of the fact; the `question` name and the `error` field are.
 *
 * Both the snapshot's read-outcome derivation and the removal retention rules
 * read this one predicate, so a read is a miss and an error result is retained
 * under the same definition. This module is the neutral host-shape home: it
 * imports nothing, so neither caller creates a cycle.
 */
export function opencodeIsErrorResult(part: OpencodeToolResultPart): boolean {
  if (part.result.type === 'error') return true;
  const value = part.result.value;
  return part.name === 'question'
    && isRecord(value) && value['error'] !== undefined && value['error'] !== null;
}

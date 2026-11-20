/**
 * The additive tool surface (ISSUE-192; plan §2, §7 C5; ISSUE-300 item 19).
 *
 * 2.2.5 registers a tool through `context.tool.transform(editor => editor.add({
 * name, description, input, output?, execute }))`. `input` is JSON Schema
 * (`Tool.ValueSchema` accepts a plain JsonSchema object), so the adapter's
 * existing `ToolSpec.parameters` is passed through and no schema library is
 * imported. The call and its result are the host's own; nothing here replaces a
 * native read (ADR-0007).
 *
 * Both declared tools now have an execution path. `necromancy` restores an
 * archived unit; `forget` resolves a path and line ranges against the request's
 * own snapshot and schedules the removal for the next request boundary, where
 * the engine applies it through the ledger (`forget.ts`). A build whose mount
 * supplies no forget handler does not register the tool, so the model is never
 * offered a tool that would fail.
 */

import type { NodeId, RecallId, RecallRecord, ToolSpec } from '@cremator/core';
import {
  RECALL_TOOL_DESCRIPTION, canonicalManifestBytes, normalizeRecallId, sha256Sync,
} from '@cremator/core';
import { forgetAnswerText } from './forget.js';
import type { OpencodeForgetValue } from './forget.js';
import type { OpencodeToolContext, OpencodeToolDefinition } from './host.js';

/**
 * The core literal names what the tool does. The adapter appends only what a
 * caller must know to read an answer here: one part comes back as the bytes the
 * ledger archived for it, which for a tool-result unit is the canonical
 * `{name,input,result}` JSON envelope the unit was recorded under (the exact
 * text of a text or reasoning part is that part's own text). Several parts come
 * back one entry each and never as a joined body.
 */
const RECALL_TOOL_DESCRIPTION_OPENCODE = RECALL_TOOL_DESCRIPTION
  + ' One part returns the bytes the ledger archived for it, verbatim: for a tool-result unit'
  + ' that is the canonical JSON envelope `{"name":...,"input":...,"result":...}` the unit was'
  + ' recorded under, and for a text or reasoning part it is that part\'s exact text. Several'
  + ' parts return one entry each in `parts`, and no field holds a joined body (`text` is null).';

/**
 * The one tool the mount registers. A recall is the restore path; the product
 * never caps its answer or any other result body (ADR-0048), so the tool returns
 * the archived bytes the model asked for.
 */
export const OPENCODE_RECALL_TOOL_NAME = 'necromancy';

/**
 * Deep-freeze a tool spec and every object or array under it (ISSUE-269). The
 * inventory is a module constant a host or a test can reach, and a shallow
 * freeze left `parameters.properties.*` mutable: one caller could change the
 * schema the next host request offered. Recursing is the proof the nested
 * objects are as fixed as the outer one.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

/**
 * The two additive tools the contract names (`ToolSpec`). Nothing replaces a
 * native read (ADR-0007); they sit beside the host's own tools. The inventory
 * and every nested `parameters` object are deep-frozen (ISSUE-269).
 */
export const OPENCODE_TOOL_SPECS: readonly ToolSpec[] = deepFreeze<readonly ToolSpec[]>([
  { name: 'forget',
    description: 'marks listed content as not retained; give the path and line ranges. '
      + 'A necromancy id restores the exact original bytes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the path the content came from' },
        ranges: { type: 'array', items: {
          type: 'object',
          properties: { startLine: { type: 'integer' }, endLine: { type: 'integer' } },
          required: ['startLine', 'endLine'], additionalProperties: false,
        } },
      },
      required: ['path'], additionalProperties: false,
    } },
  { name: 'necromancy',
    description: RECALL_TOOL_DESCRIPTION_OPENCODE,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string',
        description: 'the necromancy id a marker or receipt names; a bare 64-character hex id is accepted too' } },
      required: ['id'], additionalProperties: false,
    } },
]);

export interface OpencodeRecallPart {
  readonly nodeId: NodeId;
  readonly byteLength: number;
  readonly sha256: string;
  readonly text: string;
}

/**
 * A restored record, one part at a time. Each entry carries that part's
 * `nodeId`, `sha256`, `byteLength` and its exact archived bytes decoded as
 * UTF-8; no entry spans two parts. For a tool-result unit those bytes are the
 * canonical `{name,input,result}` envelope; for a text or reasoning part they
 * are the part's own text. `text` repeats the body only when the record has
 * exactly one part and is `null` when it has several, so nothing returned ever
 * claims bytes no single part held (ADR-0003).
 */
export interface OpencodeRecallOutput {
  readonly recallId: RecallId;
  readonly text: string | null;
  readonly byteLength: number;
  readonly parts: readonly OpencodeRecallPart[];
}

/**
 * Delegates verification to the core ledger (`ledger.recall` proves the manifest
 * hash, every body and every removed span) and checks only that the record it
 * received is the one asked for: the requested id and the manifest-derived id
 * must name the same archive. Decoding is lossless — invalid UTF-8 throws rather
 * than substituting replacement characters, and the BOM is kept — so a model
 * never reads text that is not the original bytes.
 *
 * **The mount's own byte proof (ISSUE-269).** The record's id and manifest hash
 * are hash facts over the manifest, not over the bodies: a same-length
 * substitution of `part.bytes` keeps both intact. Every part is therefore
 * re-hashed here and must equal the archived `source.sha256` (and its length
 * must equal `source.byteLength`); a mismatch throws before any text is
 * returned. The `sha256` this function reports is the recomputed digest, so a
 * payload can never claim a hash its bytes do not have.
 */
export function recallText(record: RecallRecord, expected: RecallId): OpencodeRecallOutput {
  const manifestSha = sha256Sync(canonicalManifestBytes(record.manifest));
  if (record.id !== expected || record.id !== `recall:sha256:${manifestSha}`
    || record.manifestSha256 !== manifestSha) {
    throw new Error('recall returned a record that is not the requested archive');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts = record.parts.map((part) => {
    const sha256 = sha256Sync(part.bytes);
    if (sha256 !== part.source.sha256 || part.bytes.length !== part.source.byteLength) {
      throw new Error('recall returned a part whose bytes do not match its archived source');
    }
    return { nodeId: part.source.nodeId,
      byteLength: part.bytes.length, sha256, text: decoder.decode(part.bytes) };
  });
  // Per-part restore: a join would hand back bytes that belong to no single
  // part, so `text` is populated only when there is exactly one body to name.
  const only = parts.length === 1 ? parts[0]?.text : undefined;
  return { recallId: record.id, text: only ?? null,
    byteLength: parts.reduce((sum, part) => sum + part.byteLength, 0), parts };
}

/**
 * The one string the host's tool result carries. A single-part record is
 * returned as its archived bytes, so a model reads exactly what the ledger
 * banked: a tool-result unit's canonical `{name,input,result}` envelope, or a
 * text/reasoning part's own text. A multi-part record has no single body, so it
 * is returned as JSON naming each part separately — never a join (ADR-0003).
 */
export function recallOutputText(output: OpencodeRecallOutput): string {
  return output.text ?? JSON.stringify({ recallId: output.recallId, text: null,
    byteLength: output.byteLength, parts: output.parts });
}

/** What the adapter can answer today. An absent handler means an unregistered tool. */
export interface OpencodeToolSources {
  readonly recall: (id: RecallId) => Promise<RecallRecord>;
  /**
   * The manual forget handler: it resolves the arguments and answers a
   * scheduled request or the lookup's own refusal. Absent means the `forget`
   * tool is not registered.
   */
  readonly forget?: (args: unknown) => Promise<OpencodeForgetValue>;
}

/**
 * The stated id in its one canonical spelling. The model may write the receipt
 * form, `sha256:<hex>`, or the bare hex; core's reader accepts exactly those
 * three and refuses every other spelling with the ledger's own `not-found`.
 */
function recallIdArg(input: unknown): RecallId {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('recall expects an object with an id');
  }
  const id = (input as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || id.length === 0) throw new Error('recall expects a non-empty id');
  return normalizeRecallId(id);
}

/**
 * The one tool 2.2.5's editor receives. `execute` returns `{content}`: the host
 * wraps it into the model's tool result, and a record that failed its id check
 * never reaches the model. An unknown or malformed id surfaces as a rejection
 * (the ledger's `not-found`, or the id check above), never as fabricated text.
 *
 * `options.codemode: false` is what makes the tool visible by name. The host
 * splits registered tools: exactly `false` is a direct entry in the request's
 * tool table, anything else joins the code-mode catalog behind the `execute`
 * tool. Without it `editor.add` still succeeds (`editor.list()` shows the tool)
 * and the request never names it.
 */
export function createOpencodeTool(sources: OpencodeToolSources): OpencodeToolDefinition {
  const recallSpec = OPENCODE_TOOL_SPECS.find(spec => spec.name === OPENCODE_RECALL_TOOL_NAME);
  if (recallSpec === undefined) throw new Error('The recall spec left the inventory');
  return Object.freeze({
    name: OPENCODE_RECALL_TOOL_NAME,
    description: recallSpec.description,
    // The clone keeps the spec's own bytes, and the deep freeze makes the host's
    // copy immutable to the same depth as the inventory (ISSUE-269).
    input: deepFreeze(structuredClone(recallSpec.parameters)),
    options: Object.freeze({ codemode: false }),
    execute: async (input: unknown, _context: OpencodeToolContext) => {
      const id = recallIdArg(input);
      return { content: recallOutputText(recallText(await sources.recall(id), id)) };
    },
  });
}

/**
 * The manual `forget` tool, when the mount supplies a handler. Its execution
 * answers the scheduled/refused value as text; the removal itself lands at the
 * next request boundary through the engine, never inside the call.
 *
 * `options.codemode: false` is what makes the tool visible by name, exactly as
 * it is for `necromancy`.
 */
export function createOpencodeForgetTool(sources: OpencodeToolSources): OpencodeToolDefinition | null {
  const forget = sources.forget;
  if (forget === undefined) return null;
  const spec = OPENCODE_TOOL_SPECS.find(candidate => candidate.name === 'forget');
  if (spec === undefined) throw new Error('The forget spec left the inventory');
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    input: deepFreeze(structuredClone(spec.parameters)),
    options: Object.freeze({ codemode: false }),
    execute: async (input: unknown, _context: OpencodeToolContext) => ({
      content: forgetAnswerText(await forget(input)),
    }),
  });
}

/** The specs the contract declares, in a stable order, for adapters to advertise. */
export function opencodeToolSpecs(): readonly ToolSpec[] {
  return OPENCODE_TOOL_SPECS.map(spec => deepFreeze<ToolSpec>({
    ...spec, parameters: structuredClone(spec.parameters),
  }));
}

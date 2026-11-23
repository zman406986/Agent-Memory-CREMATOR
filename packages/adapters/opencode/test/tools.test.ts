// Recall-tool gate for the 2.4.0 editor seam (ISSUE-192; plan §7 C5).
//
// 2.4.0 registers a tool through `context.tool.transform(editor => editor.add({
// name, description, input, output?, execute }))`; `input` is JSON Schema, not a
// zod shape. This suite proves the adapter's declared JSON Schema is the schema
// the host's `Tool.ValueSchema` accepts, that a record restores its exact banked
// bytes through a real ledger, and that an id which is not both the requested and
// the manifest-derived one is rejected before any text is handed back.
//
// The ledger is a real `SqliteLedger` over a tmp directory with a `FileBlobStore`,
// so the bytes the tool returns travelled through the same publication and
// verification path a shipped mount uses. No key, no harness, no live call.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Tool } from '@opencode/schema/tool';
import type { Ledger, RecallManifest, RecallRecord } from '@cremator/core';
import {
  FileBlobStore, LedgerError, RECALL_TOOL_DESCRIPTION, SqliteLedger,
  canonicalManifestBytes, sha256Sync,
} from '@cremator/core';
import type { OpencodeToolResult } from '../src/host.js';
import type { OpencodeToolDefinition } from '../src/host.js';
import {
  OPENCODE_TOOL_SPECS, createOpencodeTool, opencodeToolSpecs, recallText,
} from '../src/tools.js';
import type { OpencodeToolSources } from '../src/tools.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

// Type-only conformance with 2.4.0's own schema: the JSON Schema object the
// adapter builds is a value `Tool.ValueSchema` accepts, and the result the
// execute returns is a `Tool.Result`. Nothing from the host is loaded at run
// time; a host type that drifts on a pin bump fails `tsc` here.
function hostSchemaAccepts(schema: Readonly<Record<string, unknown>>): Tool.ValueSchema {
  return schema as Tool.ValueSchema;
}
function hostResultAccepts(result: OpencodeToolResult): Tool.Result {
  return result;
}
void hostSchemaAccepts;
void hostResultAccepts;

const encoder = new TextEncoder();
const clock = { nowMs: () => 100 };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-tools-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

// A record is banked the way the ledger banks one: every body hashed, a manifest
// over those hashes, and the id derived from the manifest hash.
function recallFixture(bodies: readonly Uint8Array[], sessionId = 'session-1'): RecallRecord {
  const parts = bodies.map((body, index) => {
    const hash = sha256Sync(body);
    return {
      source: { nodeId: `node-${index}`, sha256: hash, byteLength: body.length },
      bytes: new Uint8Array(body),
      removedRanges: body.length === 0 ? []
        : [{ range: { startByte: 0, endByteExclusive: body.length }, sha256: hash }],
    };
  });
  const manifest: RecallManifest = { version: 1, sessionId,
    parts: parts.map(part => ({ source: part.source, blobSha256: part.source.sha256,
      removedRanges: part.removedRanges })) };
  const manifestSha256 = sha256Sync(canonicalManifestBytes(manifest));
  return { id: `recall:sha256:${manifestSha256}`, manifestSha256, manifest, parts };
}

async function openTmpLedger(root: string): Promise<Ledger> {
  const blobRoot = join(root, 'blobs');
  mkdirSync(blobRoot, { recursive: true });
  return SqliteLedger.open({ databasePath: join(root, 'ledger.sqlite'),
    blobStore: new FileBlobStore(blobRoot), clock });
}

async function bank(ledger: Ledger, record: RecallRecord): Promise<void> {
  await ledger.prepare({
    sessionId: record.manifest.sessionId, eventId: 'event-1', baseRevision: 'revision-1',
    phase: 'entry', applicationSha256: sha256Sync(encoder.encode('guard-verified application')),
    archives: [{ ruleId: 'cap', removalId: 'removal-1', operationKind: 'cap',
      episodeId: null, title: 'Original body', recall: record }],
    appendRecords: [], sealedEpisodeIds: [],
  });
}

function toolFor(sources: OpencodeToolSources): OpencodeToolDefinition {
  return createOpencodeTool(sources);
}

/** The one string the host tool result carries, whichever way it is wrapped. */
function contentText(result: OpencodeToolResult): string | null {
  return typeof result.content === 'string' ? result.content : null;
}

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

const ROWS: readonly Row[] = [
  { name: 'description-starts-from-core-literal', run(at) {
    const spec = OPENCODE_TOOL_SPECS.find(candidate => candidate.name === 'necromancy');
    assert.ok(spec !== undefined, at('recall is in the declared inventory'));
    assert.ok(spec.description.startsWith(RECALL_TOOL_DESCRIPTION),
      at('the model-facing inventory owns the sentence core pins'));
    assert.match(spec.description, /one part/iu,
      at('the description states the one-part read shape'));
    assert.match(spec.description, /several parts/iu,
      at('the description states the several-parts read shape'));
  } },
  { name: 'declared-inventory-cannot-be-mutated', run(at) {
    assert.ok(Object.isFrozen(OPENCODE_TOOL_SPECS), at('the inventory is frozen'));
    assert.ok(Object.isFrozen(OPENCODE_TOOL_SPECS[0]?.parameters),
      at('the first spec parameters object is frozen'));
    const properties = (OPENCODE_TOOL_SPECS[0]?.parameters as {
      properties?: Record<string, unknown> }).properties;
    assert.ok(Object.isFrozen(properties),
      at('the nested properties object is frozen too'));
    const copy = opencodeToolSpecs();
    assert.deepEqual(copy, [...OPENCODE_TOOL_SPECS], at('the copy equals the inventory'));
    assert.throws(() => { (copy[0]?.parameters as { type: string }).type = 'mutated'; },
      TypeError, at('a mutation of the returned copy throws'));
    assert.notEqual((OPENCODE_TOOL_SPECS[0]?.parameters as { type: string }).type, 'mutated',
      at('the returned specs are copies, not the frozen inventory'));
  } },
  { name: 'a-nested-schema-mutation-cannot-change-a-later-tool', run(at) {
    const tool = toolFor({ recall: async () => { throw new Error('not called'); } });
    const idSchema = ((tool.input['properties'] as Record<string, unknown>)['id']) as
      { type?: string; description?: string };
    assert.equal(idSchema.type, 'string', at('the nested id schema starts as declared'));
    assert.ok(Object.isFrozen(idSchema), at('the nested id schema is frozen'));
    assert.throws(() => { idSchema.type = 'mutated'; }, TypeError,
      at('a nested mutation throws'));
    assert.throws(() => { idSchema.description = 'forged'; }, TypeError,
      at('a nested description mutation throws too'));
    assert.equal(idSchema.type, 'string', at('the mutation changed nothing'));
    // A second tool built after the attempt still carries the declared schema.
    const later = toolFor({ recall: async () => { throw new Error('not called'); } });
    const laterId = ((later.input['properties'] as Record<string, unknown>)['id']) as
      { type?: string; description?: string };
    assert.equal(laterId.type, 'string',
      at('a later tool still offers the declared id type'));
    assert.equal(laterId.description,
      'the necromancy id a marker or receipt names; a bare 64-character hex id is accepted too',
    at('a later tool still offers the declared description'));
  } },
  { name: 'the-editor-receives-json-schema-not-a-zod-shape', run(at) {
    const tool = toolFor({ recall: async () => { throw new Error('not called'); } });
    assert.equal(tool.name, 'necromancy', at('the host sees the recall name'));
    assert.equal(typeof tool.description, 'string', at('the host sees a description'));
    // The schema is the spec's own JSON Schema, passed through.
    const spec = OPENCODE_TOOL_SPECS.find(candidate => candidate.name === 'necromancy');
    assert.deepEqual(tool.input, spec?.parameters, at('the input is the declared JSON Schema'));
    assert.equal(tool.input['type'], 'object', at('the schema names an object'));
    assert.deepEqual(Object.keys(tool.input['properties'] as Record<string, unknown>), ['id'],
      at('the schema names one id property'));
    assert.equal(tool.output, undefined, at('no output schema is claimed'));
    // The value is one 2.4.0 accepts through Tool.ValueSchema.
    assert.doesNotThrow(() => hostSchemaAccepts(tool.input),
      at('the JSON Schema is accepted by the host type'));
  } },
  { name: 'recall-restores-exact-banked-bytes', async run(at) {
    const root = scratch();
    const body = '\uFEFFé\r\nnot normalized\r\nend';
    const record = recallFixture([encoder.encode(body)]);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, record);
      const tool = toolFor({ recall: id => ledger!.recall(id) });
      const answer = await tool.execute({ id: record.id }, { sessionID: 'session-1' });
      assert.equal(contentText(answer), body,
        at('one part returns its exact bytes, BOM and CRLF included'));
      assert.deepEqual(hostResultAccepts(answer), { content: body },
        at('the result is the host Tool.Result shape'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'a-unit-part-restores-its-archived-bytes-exactly', async run(at) {
    const root = scratch();
    const value = '# Note\n\nbody\n';
    const envelope = `{"input":{"filePath":"NOTES.md"},"name":"read","result":`
      + `{"type":"text","value":${JSON.stringify(value)}}}`;
    const record = recallFixture([encoder.encode(envelope)]);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, record);
      const tool = toolFor({ recall: id => ledger!.recall(id) });
      const answer = await tool.execute({ id: record.id }, { sessionID: 'session-1' });
      const text = contentText(answer);
      assert.equal(text, envelope,
        at('a unit part comes back as its archived bytes, never a re-rendered result value'));
      assert.equal(sha256Sync(encoder.encode(text as string)), record.parts[0]?.source.sha256,
        at('the returned bytes hash to the archived part'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'the-tool-description-names-the-unit-text', run(at) {
    const spec = OPENCODE_TOOL_SPECS.find(candidate => candidate.name === 'necromancy');
    assert.ok(spec !== undefined, at('recall is in the declared inventory'));
    assert.match(spec.description, /decoded tool-result text/u,
      at('the model-facing description names the decoded result text'));
    assert.doesNotMatch(spec.description, /canonical JSON envelope/u,
      at('the description no longer names the retired envelope'));
  } },
  { name: 'a-host-cache-path-is-never-a-recall-id', async run(at) {
    /**
     * ADR-0057: the host's saved-output cache is the host's own file. The
     * restore path takes a recall id, never a path, so a model handing back the
     * host's `full output saved to <path>` pointer cannot make the product read
     * that file; the id grammar refuses it before any ledger lookup.
     */
    const root = scratch();
    const hostCacheRoot = join(root, 'world', '.local', 'share', 'opencode', 'tool-output');
    mkdirSync(hostCacheRoot, { recursive: true });
    const savedPath = join(hostCacheRoot, 'tool_1c1eaf9ad001sKLLZmkGoc5IrH');
    writeFileSync(savedPath, 'the host saved this\n', 'utf8');
    let calls = 0;
    const tool = toolFor({ recall: async () => {
      calls += 1;
      throw new Error('no recall source may run for a path');
    } });
    try {
      for (const [label, id] of [
        ['the host saved-output path', savedPath],
        ['the call id a restore may be written as', 'call_00_oup8zVQm3gxYon5jewgC8430'],
      ] as const) {
        await assert.rejects(tool.execute({ id }, { sessionID: 'session-1' }),
          (error: unknown) => error instanceof LedgerError && error.code === 'not-found'
            && /Invalid recall id/u.test(error.message),
          at(`${label} is not a recall id and is refused by the id grammar`));
      }
      assert.equal(calls, 0, at('no path or call id reaches the recall source'));
      assert.equal(readFileSync(savedPath, 'utf8'), 'the host saved this\n',
        at('the host cache file is neither read nor changed by the tool'));
    } finally {
      cleanup(root);
    }
  } },
  { name: 'a-restore-over-the-host-reader-cap-returns-only-ledger-bytes', async run(at) {
    /**
     * A restore answer can be over the host's 50 KiB reader cap; the host then
     * cuts it and points at its own cache (ADR-0048 § Context). The product's
     * answer is exactly the ledger bytes, with no product-made pointer,
     * metadata or truncation marker.
     */
    const root = scratch();
    const value = 'x'.repeat(60 * 1024);
    const body = `{"input":{"limit":300,"pattern":"other games reference material/**"},`
      + `"name":"glob","result":{"type":"text","value":${JSON.stringify(value)}}}`;
    const record = recallFixture([encoder.encode(body)]);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, record);
      const tool = toolFor({ recall: id => ledger!.recall(id) });
      const answer = await tool.execute({ id: record.id }, { sessionID: 'session-1' });
      assert.ok(Buffer.byteLength(body, 'utf8') > 50 * 1024,
        at('the fixture is over the host reader cap, so the host would cut it'));
      assert.equal(contentText(answer), body,
        at('the tool returns the exact banked bytes, not a cut body or a pointer'));
      assert.equal(answer.metadata, undefined,
        at('the product writes no metadata, outputPath or truncation marker'));
      assert.equal(String(answer.content).includes('tool-output'), false,
        at('the product names no host cache path'));
      assert.equal(String(answer.content).includes('full output saved to'), false,
        at('the product writes no host truncation notice'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'id-must-be-requested-and-manifest-derived', run(at) {
    const record = recallFixture([encoder.encode('body')]);
    const output = recallText(record, record.id);
    assert.equal(output.recallId, record.id, at('the matching id is accepted'));
    assert.equal(output.text, 'body', at('and its bytes come back'));
    assert.throws(() => recallText(record, `recall:sha256:${'1'.repeat(64)}`),
      /not the requested archive/u,
      at('a requested id that differs from the record must fail'));
    const forgedId = `recall:sha256:${'2'.repeat(64)}`;
    assert.throws(() => recallText({ ...record, id: forgedId }, forgedId),
      /not the requested archive/u,
      at('an id no manifest hashes to must fail'));
    assert.throws(() => recallText({ ...record, manifestSha256: '3'.repeat(64) }, record.id),
      /not the requested archive/u,
      at('a drifted manifestSha256 field must fail even when the id matches'));
  } },
  { name: 'a-same-length-byte-substitution-fails-the-mount-proof', async run(at) {
    const original = 'archived body';
    const altered = 'replaced body';
    assert.equal(altered.length, original.length,
      at('the substitution has the same byte length'));
    const record = recallFixture([encoder.encode(original)]);
    const tampered: RecallRecord = {
      ...record,
      parts: record.parts.map(part => ({ ...part, bytes: encoder.encode(altered) })),
    };
    assert.equal(tampered.parts[0]?.bytes.length, record.parts[0]?.bytes.length,
      at('the tampered part is the same length as the archived one'));
    assert.equal(tampered.id, record.id,
      at('the id and manifest still verify: only the bytes changed'));
    const tool = toolFor({ recall: async () => tampered });
    await assert.rejects(tool.execute({ id: record.id }, { sessionID: 'session-1' }),
      /do not match its archived source/u,
      at('the mount proof hashes the returned bytes and refuses the substitution'));
    assert.throws(() => recallText(tampered, record.id),
      /do not match its archived source/u,
      at('the same proof refuses outside the host wrapper too'));
  } },
  { name: 'several-parts-are-one-entry-each', async run(at) {
    const root = scratch();
    const bodies = [encoder.encode('first body\n'), encoder.encode('second body \uFEFF')];
    const record = recallFixture(bodies);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, record);
      const tool = toolFor({ recall: id => ledger!.recall(id) });
      const answer = await tool.execute({ id: record.id }, { sessionID: 'session-1' });
      const text = contentText(answer);
      assert.equal(typeof text, 'string', at('a multi-part recall renders as JSON text'));
      const parsed = JSON.parse(text as string) as { recallId: string; text: string | null;
        parts: readonly { text: string; sha256: string }[] };
      assert.equal(parsed.text, null,
        at('no field claims a whole body the archive never held'));
      assert.deepEqual(Object.keys(parsed).sort(), ['byteLength', 'parts', 'recallId', 'text'],
        at('the payload names one entry per part and no joined body field'));
      assert.deepEqual(parsed.parts.map(part => part.text),
        bodies.map(body => new TextDecoder().decode(body)),
        at('each part carries its own bytes'));
      const joined = bodies.map(body => new TextDecoder().decode(body)).join('');
      for (const part of parsed.parts) {
        assert.notEqual(part.text, joined, at("a part never carries another part's bytes"));
      }
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'unknown-id-is-the-ledger-refusal', async run(at) {
    const root = scratch();
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, recallFixture([encoder.encode('banked')]));
      const tool = toolFor({ recall: id => ledger!.recall(id) });
      await assert.rejects(tool.execute({ id: `recall:sha256:${'0'.repeat(64)}` },
        { sessionID: 'session-1' }), code('not-found'),
      at('a well-formed but unbaked id is not-found'));
      await assert.rejects(tool.execute({ id: 'not-a-recall-id' }, { sessionID: 'session-1' }),
        code('not-found'), at('a malformed id is the same not-found, not invented text'));
      let calls = 0;
      const counting = toolFor({ recall: async (id) => {
        calls += 1; return ledger!.recall(id);
      } });
      await assert.rejects(counting.execute({}, { sessionID: 'session-1' }),
        /non-empty id/u, at('an absent id is refused by name'));
      await assert.rejects(counting.execute(null, { sessionID: 'session-1' }),
        /object with an id/u, at('a non-object argument is refused by name'));
      assert.equal(calls, 0, at('no malformed argument reaches the ledger'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'every-accepted-id-form-restores-the-same-bytes', async run(at) {
    const root = scratch();
    const body = '\uFEFFé\r\nnot normalized\r\nend';
    const record = recallFixture([encoder.encode(body)]);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      await bank(ledger, record);
      const asked: string[] = [];
      const tool = toolFor({ recall: id => { asked.push(id); return ledger!.recall(id); } });
      const forms = [
        ['receipt', record.id],
        ['sha256-prefix', `sha256:${record.manifestSha256}`],
        ['bare-hex', record.manifestSha256],
      ] as const;
      for (const [form, id] of forms) {
        const answer = await tool.execute({ id }, { sessionID: 'session-1' });
        assert.equal(contentText(answer), body,
          at(`the ${form} form restores the exact banked bytes`));
      }
      assert.deepEqual(asked, [record.id, record.id, record.id],
        at('every accepted form reaches the ledger as the canonical id'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'rejected-id-spellings-fail-by-name', async run(at) {
    const hex = 'a'.repeat(64);
    let calls = 0;
    const tool = toolFor({ recall: async id => {
      calls += 1; throw new Error(`unexpected recall for ${id}`);
    } });
    const rejected = [
      ['uppercase hex', `recall:sha256:${hex.toUpperCase()}`],
      ['short hex', `recall:sha256:${hex.slice(1)}`],
      ['long hex', `recall:sha256:${hex}0`],
      ['leading space', ` recall:sha256:${hex}`],
      ['trailing space', `recall:sha256:${hex} `],
      ['missing sha256 prefix', `recall:${hex}`],
      ['uppercase prefix', `RECALL:sha256:${hex}`],
      ['foreign algorithm', `recall:sha512:${hex}`],
      ['doubled sha256 prefix', `sha256:sha256:${hex}`],
      ['empty hex', 'recall:sha256:'],
      ['newline suffix', `${hex}\n`],
    ] as const;
    for (const [label, id] of rejected) {
      await assert.rejects(tool.execute({ id }, { sessionID: 'session-1' }), (error: unknown) =>
        error instanceof LedgerError && error.code === 'not-found'
        && /Invalid recall id/u.test(error.message),
      at(`the ${label} spelling is refused as an invalid recall id`));
    }
    assert.equal(calls, 0, at('no rejected spelling reaches the ledger'));
  } },
  { name: 'accepted-form-for-a-missing-manifest-still-fails', async run(at) {
    const root = scratch();
    const hex = 'b'.repeat(64);
    let ledger: Ledger | undefined;
    try {
      ledger = await openTmpLedger(root);
      const asked: string[] = [];
      const tool = toolFor({ recall: id => { asked.push(id); return ledger!.recall(id); } });
      for (const [form, id] of [
        ['receipt', `recall:sha256:${hex}`],
        ['sha256-prefix', `sha256:${hex}`],
        ['bare-hex', hex],
      ] as const) {
        await assert.rejects(tool.execute({ id }, { sessionID: 'session-1' }), code('not-found'),
          at(`the ${form} form for an unknown manifest is not-found`));
      }
      assert.deepEqual(asked, [`recall:sha256:${hex}`, `recall:sha256:${hex}`,
        `recall:sha256:${hex}`],
      at('an unknown manifest is looked up under the canonical id'));
    } finally {
      await ledger?.close();
      cleanup(root);
    }
  } },
  { name: 'invalid-utf8-throws', run(at) {
    const record = recallFixture([new Uint8Array([0x61, 0xff, 0x62])]);
    assert.throws(() => recallText(record, record.id), (error: unknown) =>
      error instanceof TypeError || (error instanceof Error && /utf-8|not valid/iu.test(error.message)),
    at('invalid UTF-8 throws instead of substituting replacement characters'));
    const valid = recallFixture([encoder.encode('a\u00e9b')]);
    assert.equal(recallText(valid, valid.id).text, 'a\u00e9b',
      at('the same path decodes valid bytes'));
  } },
];

test('the recall tool — one row per claim', async () => {
  await runRows(ROWS);
});

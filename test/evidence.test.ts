/**
 * The evidence derivation (ADR-0037): what a tool result PROVES about a path.
 *
 * Folded into four rows, each a family of the same claim — a miss needs an
 * explicit exhaustive zero-match, a write never claims hit or miss, a read
 * declares coverage only when the host said so, and everything ambiguous stays
 * unknown. Every case below is a row in a table so a red run names the shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDshTool, deriveToolEvidence } from '../src/evidence.js';
import type { DshEvidenceInput, DshResultFacts } from '../src/evidence.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

const source = { nodeId: 'result', sha256: 'source-hash', byteLength: 0 };
const observed = (overrides: Partial<DshEvidenceInput> = {}): DshEvidenceInput => ({
  toolName: 'search', input: { pattern: 'needle', path: 'a.ts' },
  result: { complete: true, failed: false, paths: [{ path: 'a.ts', matchCount: 0 }] },
  ...overrides,
});

/** The outcome one input derives, which most rows below assert on. */
function outcomeOf(item: DshEvidenceInput): string | undefined {
  return deriveToolEvidence(item, source).paths[0]?.outcome;
}

const ROWS: readonly Row[] = [
  { name: 'a miss needs an explicit exhaustive zero-match; everything else stays unknown',
    run(at) {
      // The one proven miss: a search that completed, did not fail, and reported
      // a zero count for the path it looked at.
      const evidence = deriveToolEvidence(observed(), source);
      assert.equal(evidence.kind, 'search', at('a search is its own kind'));
      assert.deepEqual(evidence.target, { key: 'needle', label: 'needle' },
        at('the pattern is the target'));
      assert.equal(evidence.paths[0]?.outcome, 'miss', at('an exhaustive zero count is a miss'));
      assert.deepEqual(evidence.source, source, at('the source travels with the evidence'));
      // Eight shapes that must NOT become a miss: no facts, incomplete, failed,
      // no `failed` flag, no count at all, an ordinary read, another tool, NaN.
      const unknown: readonly { readonly name: string; readonly item: DshEvidenceInput }[] = [
        { name: 'no facts at all', item: observed({ result: {} }) },
        { name: 'incomplete work', item: observed({ result: { complete: false, failed: false,
          paths: [{ path: 'a.ts', matchCount: 0 }] } }) },
        { name: 'a failed call', item: observed({ result: { complete: true, failed: true,
          paths: [{ path: 'a.ts', matchCount: 0 }] } }) },
        { name: 'no failed flag', item: observed({ result: { complete: true,
          paths: [{ path: 'a.ts', matchCount: 0 }] } }) },
        { name: 'no count', item: observed({ result: { complete: true, failed: false,
          paths: [{ path: 'a.ts' }] } }) },
        { name: 'a read with no span', item: observed({ toolName: 'read', input: { path: 'a.ts' } }) },
        { name: 'another tool family', item: observed({ toolName: 'other' }) },
        { name: 'a NaN count', item: observed({ result: { complete: true, failed: false,
          paths: [{ path: 'a.ts', matchCount: NaN }] } }) },
      ];
      for (const pair of unknown) {
        assert.equal(outcomeOf(pair.item), 'unknown', `${at('stays unknown')}: ${pair.name}`);
      }
      // A positive observed count is a hit, whether or not coverage is complete.
      assert.equal(outcomeOf(observed({ result: { complete: false, failed: false,
        paths: [{ path: 'a.ts', matchCount: 2 }] } })), 'hit',
      at('a positive count is a hit without claiming complete coverage'));
      // Duplicate path observations never turn an unknown into a miss, in either order.
      for (const paths of [
        [{ path: 'a.ts' }, { path: 'a.ts', matchCount: 0 }],
        [{ path: 'a.ts', matchCount: 0 }, { path: 'a.ts' }],
      ]) {
        const evidence = deriveToolEvidence(
          observed({ result: { complete: true, failed: false, paths } }), source);
        assert.equal(evidence.paths.length, 1, at('duplicates collapse to one path'));
        assert.equal(evidence.paths[0]?.outcome, 'unknown', at('and they never prove a miss'));
      }
    } },
  { name: 'a write keeps its target path and never claims a hit or a miss',
    run(at) {
      const cases: readonly DshEvidenceInput[] = [
        { toolName: 'write', input: { file_path: 'src/a.ts', content: 'x' },
          result: { complete: true, failed: false, paths: [{ path: 'src/a.ts', matchCount: 0 }] } },
        { toolName: 'edit', input: { filePath: 'src/a.ts', old_string: 'x', new_string: 'y' } },
        { toolName: 'patch', input: { path: 'src/a.ts', diff: '@@' } },
        { toolName: 'write', input: { file_path: 'src/a.ts' }, target: { key: 'src/a.ts', label: 'a.ts' },
          result: { complete: true, failed: false, paths: [{ path: 'src/a.ts', matchCount: 2 }] } },
      ];
      for (const [index, item] of cases.entries()) {
        const at_ = `${at('a write claims nothing')} (case ${String(index)})`;
        const evidence = deriveToolEvidence(item, source);
        assert.equal(evidence.kind, 'write', at_);
        assert.equal(evidence.target?.key, 'src/a.ts', at_);
        assert.equal(evidence.paths[0]?.pathKey, 'src/a.ts', at_);
        // A write proves a path changed; a zero (or positive) count says nothing about a search space.
        assert.equal(evidence.paths[0]?.outcome, 'unknown', at_);
      }
      // The family table: spellings the classifier owns, and the ones it does not.
      assert.deepEqual(['write', 'edit', 'apply_patch', 'patch'].map(classifyDshTool),
        ['write', 'write', 'write', 'write'], at('patch spellings are writes'));
      assert.deepEqual(['WRITE', 'Edit', 'apply-patch', 'str_replace'].map(classifyDshTool),
        ['write', 'write', 'other', 'other'], at('only the declared spellings are writes'));
      assert.deepEqual(['read', 'read_file', 'rg', 'grep', 'glob', 'shell'].map(classifyDshTool),
        ['read', 'read', 'search', 'search', 'glob', 'other'], at('the read and search families'));
      // Path identity is conservative: case is not folded, order is arrival order.
      const evidence = deriveToolEvidence(observed({ input: { pattern: 'x', paths: ['A.ts', 'a.ts'] },
        result: {} }), source);
      assert.deepEqual(evidence.paths.map(path => path.pathKey), ['A.ts', 'a.ts'],
        at('two spellings stay two paths'));
      assert.deepEqual(evidence.paths.map(path => path.outcome), ['unknown', 'unknown'],
        at('neither spelling proves anything'));
    } },
  { name: 'a failed call carries the failure flag on the evidence, whatever its kind',
    run(at) {
      // ISSUE-328: the host's own failure report travels on ToolEvidence so the
      // proof and invalidation lanes can refuse a failed write as a change fact.
      const failedWrite = deriveToolEvidence({ toolName: 'write',
        input: { file_path: 'src/a.ts' },
        result: { failed: true, paths: [{ path: 'src/a.ts' }] } }, source);
      assert.equal(failedWrite.kind, 'write', at('a failed write keeps its kind'));
      assert.equal(failedWrite.failed, true, at('the failure flag travels'));
      const failedRead = deriveToolEvidence({ toolName: 'read',
        input: { path: 'a.ts' },
        result: { failed: true, paths: [{ path: 'a.ts', lineCount: 3 }] } }, source);
      assert.equal(failedRead.failed, true, at('a failed read carries it too'));
      // Success declares nothing: the property is absent, never false-by-guess.
      const okWrite = deriveToolEvidence({ toolName: 'write',
        input: { file_path: 'src/a.ts' }, result: { failed: false } }, source);
      assert.equal(okWrite.failed, undefined, at('a successful write declares no failure'));
      const noFacts = deriveToolEvidence({ toolName: 'write',
        input: { file_path: 'src/a.ts' } }, source);
      assert.equal(noFacts.failed, undefined, at('no facts declare no failure'));
    } },
  { name: 'a read is a hit only on the span its meta reports, and never a miss',
    run(at) {
      // The shape a live dsh read sends: no count, a covered span from meta.
      const evidence = deriveToolEvidence({ toolName: 'read',
        input: { file_path: 'src/app.ts' },
        target: { key: 'src/app.ts', label: 'src/app.ts' },
        result: { complete: false, failed: false, paths: [{
          path: 'src/app.ts', pathKey: 'src/app.ts', lineCount: 130 }] } }, source);
      assert.equal(evidence.kind, 'read', at('a read is its own kind'));
      assert.equal(evidence.paths.length, 1, at('one path observed'));
      assert.equal(evidence.paths[0]?.pathKey, 'src/app.ts', at('the path key survives'));
      assert.equal(evidence.paths[0]?.outcome, 'hit', at('a covered span is a hit'));
      // The span it actually covered, never a guess at the file's total.
      assert.equal(evidence.paths[0]?.lineCount, 130, at('the covered span is the reported one'));
      // A read carries both spellings, so either one resolves.
      const spelled = deriveToolEvidence({ toolName: 'read',
        input: { file_path: 'src/app.ts' },
        result: { failed: false, paths: [{
          path: 'src/app.ts', pathKey: 'src/app.ts',
          displayPath: 'C:\\work\\src\\app.ts', lineCount: 4 }] } }, source);
      assert.equal(spelled.paths[0]?.displayPath, 'C:\\work\\src\\app.ts',
        at('the display path is carried'));
      assert.equal(spelled.paths[0]?.outcome, 'hit', at('the span still proves a hit'));
      // No span, an empty span, a zero count, a failed read: all unknown, never a miss.
      const unknown: readonly { readonly name: string; readonly item: DshEvidenceInput }[] = [
        { name: 'no meta span', item: { toolName: 'read', input: { path: 'a.ts' },
          result: { failed: false, paths: [{ path: 'a.ts' }] } } },
        { name: 'an empty span', item: { toolName: 'read', input: { path: 'a.ts' },
          result: { failed: false, paths: [{ path: 'a.ts', lineCount: 0 }] } } },
        { name: 'a zero count only', item: { toolName: 'read', input: { path: 'a.ts' },
          result: { complete: true, failed: false, paths: [{ path: 'a.ts', matchCount: 0 }] } } },
        { name: 'a failed read with a span', item: { toolName: 'read', input: { path: 'a.ts' },
          result: { failed: true, complete: false, paths: [{ path: 'a.ts', lineCount: 3 }] } } },
      ];
      for (const pair of unknown) {
        assert.equal(outcomeOf(pair.item), 'unknown', `${at('a read never proves a miss')}: ${pair.name}`);
      }
      // A read whose meta proves a span is a hit even when an unrelated zero count rides along.
      assert.equal(outcomeOf({ toolName: 'read', input: { path: 'a.ts' },
        result: { complete: true, failed: false, paths: [{ path: 'a.ts', lineCount: 3, matchCount: 0 }] } }),
      'hit', at('a covered span outranks a zero count'));
    } },
  { name: 'a read declares its coverage from the call arguments and the result meta',
    run(at) {
      const coverageOf = (
        input: Readonly<Record<string, unknown>>, result: DshResultFacts,
      ): string | undefined => deriveToolEvidence({ toolName: 'read', input, result }, source)
        .paths[0]?.coverage;
      const spanned = (extra: Partial<DshResultFacts> = {}): DshResultFacts => ({
        failed: false, paths: [{ path: 'a.ts', lineCount: 20 }], ...extra,
      });
      // ADR-0037 decision 2, class 2: only a whole-file read is a witness, and
      // "whole file" is the host's own declaration — never an inferred line count.
      assert.equal(coverageOf({ path: 'a.ts', offset: 10 }, spanned()), 'partial',
        at('an offset asks for a slice'));
      assert.equal(coverageOf({ path: 'a.ts', limit: 20 }, spanned()), 'partial',
        at('a limit asks for a slice'));
      assert.equal(coverageOf({ path: 'a.ts' }, spanned()), 'full',
        at('neither named and no truncation: the whole file'));
      assert.equal(coverageOf({ path: 'a.ts' }, spanned({ truncated: true })), undefined,
        at('a truncated result is never full'));
      assert.equal(coverageOf({ path: 'a.ts' }, { failed: false, paths: [{ path: 'a.ts' }] }), undefined,
        at('no span declares nothing'));
      assert.equal(coverageOf({ path: 'a.ts' },
        { failed: true, paths: [{ path: 'a.ts', lineCount: 3 }] }), undefined,
      at('a failed read declares nothing'));
      assert.equal(deriveToolEvidence(observed(), source).paths[0]?.coverage, undefined,
        at('only a read has a scope'));
    } },
];

test('every tool result shape derives exactly the evidence it proves, or none', async () => {
  await runRows(ROWS);
});

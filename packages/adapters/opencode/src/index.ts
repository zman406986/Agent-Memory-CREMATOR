// The public entry for `cremator-opencode`. The shapes and the adapter's library surface
// live here; a host mounts the package through the `./server` subpath (see `src/server.ts`
// and the README), never through this file.
export const PACKAGE_NAME = 'cremator-opencode';

export {
  OPENCODE_FORGOTTEN_NODE_FIELD, OPENCODE_RECEIPT_OF_FIELD, deriveOpencodeRevert,
  opencodeReceiptEntryId,
} from './apply.js';
export type {
  OpencodeAppliedPlan, OpencodeAppliedPlanIndex, OpencodeDerivation, OpencodeDerivationCode,
  OpencodeDerivationRefusal, OpencodeDerivedArray,
} from './apply.js';
export {
  OPENCODE_ASK_FLOOR_BYTES, OPENCODE_ASK_FRAME, OPENCODE_ASK_GRAMMAR,
  askPromptOf, buildOpencodeAskBatch, buildOpencodePassPlan, isSeenUnit, readOpencodeAskAnswer,
} from './ask.js';
export type {
  OpencodeAskBatch, OpencodeAskDropped, OpencodeAskGrammar, OpencodeAskInput, OpencodeAskPort,
} from './ask.js';
export {
  decideOpencodeForget, forgetAnswer, forgetAnswerText, opencodeForgetEventId,
  readOpencodeForgetArgs,
} from './forget.js';
export type {
  OpencodeForgetDecision, OpencodeForgetRefused, OpencodeForgetScheduled,
  OpencodeForgetValue,
} from './forget.js';
export {
  OPENCODE_CAPABILITIES, OPENCODE_INACTIVE_L1_RULES, OPENCODE_L1_FACT_RESIDUALS,
  OPENCODE_L1_FACTS, createOpencodeCapabilities,
} from './capabilities.js';
export type { OpencodeInactiveL1Rule, OpencodeL1Fact } from './capabilities.js';
export {
  DEFAULT_OPENCODE_TOOL_TABLE, OPENCODE_TOOL_CLASSES, classifyOpencodeTool,
  createOpencodeToolClassifier,
} from './classifier.js';
export type {
  OpencodeClassifierOptions, OpencodeToolClass, OpencodeToolTable,
} from './classifier.js';
export type {
  OpencodeAfterToolInput, OpencodeCleanup, OpencodeCommandDefinition, OpencodeCommandDomain,
  OpencodeCommandEditor, OpencodeCommandInvocation, OpencodeCompactionPart,
  OpencodeContentPart,
  OpencodeEffortPart, OpencodeGenerateInput, OpencodeGenerateOutput, OpencodeHostEvent,
  OpencodeIdleHookInput,
  OpencodeMediaPart, OpencodeMessage, OpencodeMessageRole, OpencodePluginContext,
  OpencodePluginDefinition, OpencodeReasoningPart, OpencodeSessionContext, OpencodeTextPart,
  OpencodeToolCallPart, OpencodeToolContext, OpencodeToolDefinition, OpencodeToolEditor,
  OpencodeStepRequestKind, OpencodeToolResult, OpencodeToolResultPart,
  OpencodeToolResultValue, OpencodeTokenUsage,
} from './host.js';
export {
  estimateRequestSplit, estimateRequestTokens, requestKindOf, requestPrefixOf, stepEndedRow,
  tokenUsageOf, usageObservation,
} from './meter.js';
export type {
  OpencodeRequestKind, OpencodeStepUsageRow, OpencodeTokenRead, OpencodeUsageRow,
} from './meter.js';
export {
  OPENCODE_ASK_REFUSED_RETRY, OPENCODE_ASK_RETRY, OPENCODE_ASK_TIMEOUT_MS,
  OPENCODE_MOUNT_SEAMS, OPENCODE_PLUGIN_NAME,
  OPENCODE_PRUNE_COMMAND, OPENCODE_SUBAGENT_TOOL, OPENCODE_TEST_EXCLUDE_TOOLS,
  createFileJournalSink, createOpencodeMount,
  createOpencodePlugin, mountOptionsFromHost,
} from './plugin.js';
export type {
  OpencodeJournalKind, OpencodeJournalRecord, OpencodeJournalSink, OpencodeMount,
  OpencodeMountOptions, OpencodeMountPort, OpencodeRequestEstimate, OpencodeSessionEntry,
  PendingForget,
} from './plugin.js';
export { OpencodeApplicationPort, createOpencodePort } from './port.js';
export type {
  OpencodePortOptions, OpencodePortSnapshotOptions, OpencodeStaging, OpencodeStagingRefusal,
} from './port.js';
export {
  OPENCODE_NODE_PREFIX, OPENCODE_RECORD_ID_FIELD, OPENCODE_RECORD_PREFIX,
  deriveOpencodeSnapshot, opencodeMessageKey, opencodeMessageNodeId, opencodePartEvidence,
  opencodePartNodeId, opencodeToolNodeId,
} from './snapshot.js';
export type {
  OpencodeAttachedEvidence, OpencodeCallSite, OpencodeResultSite, OpencodeSnapshot,
  OpencodeSnapshotOptions, OpencodeUnit,
} from './snapshot.js';
export {
  OpencodeStorageError, defaultStorageRoot, openLedger, resolveStorage, sessionStorage,
} from './storage.js';
export type {
  OpencodeStorageErrorCode, OpencodeStorageOptions, StorageSelection, StorageTarget,
} from './storage.js';
export {
  OPENCODE_RECALL_TOOL_NAME, OPENCODE_TOOL_SPECS, createOpencodeForgetTool,
  createOpencodeTool, opencodeToolSpecs, recallOutputText, recallText,
} from './tools.js';
export type {
  OpencodeRecallOutput, OpencodeRecallPart, OpencodeToolSources,
} from './tools.js';

// Shared fixtures for the 2.4.0 suite (ISSUE-192). Host-shaped messages are
// built here rather than in each test so a shape is stated once; the replay
// corpus is read from `fixtures/replay-messages.json`, which records a
// 2.4.0-shaped request with every body replaced by a placeholder.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OpencodeContentPart, OpencodeMessage, OpencodeSessionContext, OpencodeToolResultValue,
} from '../src/host.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ReplayCorpus {
  readonly meta: {
    readonly what: string;
    readonly derivedFrom: string;
    readonly how: string;
    readonly shapesFrom: string;
    readonly homeForms: string;
    readonly counts: {
      readonly messages: number;
      readonly parts: number;
      readonly nodes: number;
      readonly nodeParts: number;
      readonly unitResultParts: number;
      readonly entryNodes: number;
      readonly evidenceParts: number;
      readonly unknownPartTypes: number;
    };
  };
  readonly sessionId: string;
  readonly messages: readonly OpencodeMessage[];
}

/** The recorded-shape corpus, parsed once per process. */
export function replayCorpus(): ReplayCorpus {
  return JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'replay-messages.json'), 'utf8'),
  ) as ReplayCorpus;
}

export function message(
  role: OpencodeMessage['role'], id: string | undefined,
  content: readonly OpencodeContentPart[], extra: Record<string, unknown> = {},
): OpencodeMessage {
  return {
    ...(id === undefined ? {} : { id }),
    role,
    content: [...content] as OpencodeContentPart[],
    ...extra,
  };
}

export function userMessage(id: string, content: readonly OpencodeContentPart[],
  extra: Record<string, unknown> = {}): OpencodeMessage {
  return message('user', id, content, extra);
}

export function assistantMessage(id: string, content: readonly OpencodeContentPart[],
  extra: Record<string, unknown> = {}): OpencodeMessage {
  return message('assistant', id, content, extra);
}

export function toolMessage(id: string, content: readonly OpencodeContentPart[],
  extra: Record<string, unknown> = {}): OpencodeMessage {
  return message('tool', id, content, extra);
}

export function text(value: string): OpencodeContentPart {
  return { type: 'text', text: value };
}

export function reasoning(value: string): OpencodeContentPart {
  return { type: 'reasoning', text: value };
}

export function toolCall(
  id: string, name: string, input: Readonly<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): OpencodeContentPart {
  return { type: 'tool-call', id, name, input: { ...input }, ...extra };
}

export function toolResult(
  id: string, name: string, result: OpencodeToolResultValue,
  extra: Record<string, unknown> = {},
): OpencodeContentPart {
  return { type: 'tool-result', id, name, result, ...extra };
}

export function textResult(value: string): OpencodeToolResultValue {
  return { type: 'text', value };
}

export function jsonResult(value: unknown): OpencodeToolResultValue {
  return { type: 'json', value };
}

export function errorResult(value: string): OpencodeToolResultValue {
  return { type: 'error', value };
}

export function mediaPart(filename: string, url = `file:///${filename}`): OpencodeContentPart {
  return { type: 'media', filename,
    media: { source: { type: 'url', url }, mediaType: 'text/plain' } };
}

export function compactionPart(textValue: string | null = 'earlier summary'): OpencodeContentPart {
  return { type: 'compaction', provider: 'anthropic', text: textValue };
}

export function effortPart(effort = 'low'): OpencodeContentPart {
  return { type: 'effort', effort };
}

/** One prompt, one read call, its result, one closing answer. */
export function minimalConversation(): readonly OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult('# Note\n\nbody\n'))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

/** One request context, so a test drives the hook with the host's own shape. */
export function sessionContext(
  messages: readonly OpencodeMessage[],
  extra: Partial<OpencodeSessionContext> = {},
): OpencodeSessionContext {
  return {
    sessionID: sessionId,
    messages: [...messages] as OpencodeMessage[],
    tools: {},
    ...extra,
  };
}

export const sessionId = 'ses_test';

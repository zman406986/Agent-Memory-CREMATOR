import type {
  CacheState, MessageNode, SessionSnapshot,
  ToolEvidence, ToolResultNode,
} from './types.js';

export interface FixtureContent {
  readonly utf8: string;
  readonly repeat?: number;
}

type FixtureBase = {
  readonly id: string;
  readonly turnOrdinal: number;
  readonly stepOrdinal: number;
  readonly content: FixtureContent;
};

export type FixtureNode = FixtureBase & (
  | Pick<MessageNode, 'kind' | 'role' | 'toolCallIds'>
  | (Pick<ToolResultNode, 'kind' | 'callId' | 'embeddedRecords'> & {
      readonly evidence: Omit<ToolEvidence, 'source'>;
    })
);

export interface FixtureData extends Pick<SessionSnapshot,
  'sessionId' | 'revision' | 'currentTurnOrdinal' |
  'completedThroughTurnOrdinal' | 'currentStepOrdinal'> {
  readonly version: 1;
  readonly nodes: readonly FixtureNode[];
  readonly cache: CacheState;
}


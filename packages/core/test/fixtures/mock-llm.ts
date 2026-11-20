export interface MockToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export type MockAssistantReply =
  | { readonly text: string; readonly toolCalls?: readonly MockToolCall[] }
  | { readonly text?: string; readonly toolCalls: readonly MockToolCall[] };

export type MockMessage =
  | { readonly role: 'system' | 'developer' | 'user'; readonly text: string }
  | ({ readonly role: 'assistant' } & MockAssistantReply)
  | { readonly role: 'tool'; readonly callId: string; readonly text: string };

/** An in-process reply queue. It performs no I/O and consumes one reply per request. */
export class MockLLM {
  private readonly script: readonly MockAssistantReply[];
  private readonly history: (readonly MockMessage[])[] = [];
  private nextReply = 0;

  constructor(script: readonly MockAssistantReply[]) {
    this.script = structuredClone(script);
  }

  /** Copies prevent caller mutations from changing recorded requests. */
  get requests(): readonly (readonly MockMessage[])[] {
    return structuredClone(this.history);
  }

  respond(messages: readonly MockMessage[]): MockAssistantReply {
    this.history.push(structuredClone(messages));
    const reply = this.script[this.nextReply];
    if (reply === undefined) {
      throw new Error(`MockLLM script exhausted: request ${this.history.length}, ${this.script.length} scripted replies`);
    }
    this.nextReply += 1;
    return structuredClone(reply);
  }
}

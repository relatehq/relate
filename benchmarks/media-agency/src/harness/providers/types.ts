import type { ArmHandle } from '../arms.js';
import type { Row } from '../../systems/simulators.js';

export interface Usage {
  /** Uncached input only: cache reads and writes are disjoint categories. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type Provider = 'anthropic' | 'openai';
export type Reasoning = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelConfig {
  provider: Provider;
  model: string;
  maxOutputTokens: number;
  /** Omit to use the provider/model default. Only OpenAI accepts this option. */
  reasoning?: Reasoning | undefined;
}

export type Block =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: Row;
      argumentError?: string;
    }
  | { type: 'tool_result'; id: string; content: string; isError: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  /** Opaque provider output replayed by its adapter, including reasoning state. */
  continuation?: Row[];
}

export interface ModelReply {
  content: Block[];
  usage: Usage;
  stopReason: 'complete' | 'limit' | 'error';
  continuation?: Row[];
  /** Original response, retained in the transcript for auditing. Never credentials. */
  raw?: unknown;
}

export interface Model {
  name: string;
  complete(input: {
    system: string;
    messages: Message[];
    tools: ArmHandle['tools'];
    signal: AbortSignal;
  }): Promise<ModelReply>;
}

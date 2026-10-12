import type { ConsumerDescription } from 'relate/consumer';
import type { ConsumerOperations, Json } from '@relate/protocol';

/** Host-owned metadata and operations for exactly one authenticated actor. */
export interface GraphBinding {
  readonly description: ConsumerDescription & {
    readonly objects: Readonly<
      Record<
        string,
        {
          readonly definitionId: string;
          readonly traversals: Readonly<
            Record<
              string,
              { readonly cardinality: 'one' | 'many'; readonly target: string }
            >
          >;
        }
      >
    >;
    readonly actions: Readonly<
      Record<string, { readonly definitionId: string }>
    >;
  };
  readonly operations: ConsumerOperations;
}

export interface ExecutionLog {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ExecutionError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export type ExecutionResult = {
  readonly logs: readonly ExecutionLog[];
} & (
  | { readonly status: 'succeeded'; readonly result: Json }
  | { readonly status: 'failed'; readonly error: ExecutionError }
);

/** Replace this with your execution service without changing MCP tools. */
export interface CodeExecutor {
  execute(request: {
    code: string;
    graph: GraphBinding;
    signal?: AbortSignal;
  }): Promise<ExecutionResult>;
}

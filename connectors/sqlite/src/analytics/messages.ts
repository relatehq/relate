import type { DatasetExecution, PhysicalSchema } from 'relate/connectors';
import type { SelectedDataset, SqlitePlan } from './plan.js';

export type AnalyticalOperation =
  | { kind: 'describe'; resource: SelectedDataset }
  | { kind: 'execute'; plan: SqlitePlan };

export type ChildRequest =
  | { kind: 'open'; path: string; busyTimeoutMs: number; lifetimeMs: number }
  | AnalyticalOperation;

export type ChildResponse =
  | { kind: 'ready' }
  | { kind: 'result'; value: DatasetExecution | PhysicalSchema }
  | {
      kind: 'failure';
      code: 'execution-failed' | 'invalid-result';
      retryable: boolean;
    };

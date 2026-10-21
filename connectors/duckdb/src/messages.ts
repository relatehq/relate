import type { DatasetExecution, PhysicalSchema } from 'relate/connectors';
import type { SelectedDataset, DuckDBPlan } from './plan.js';

export type AnalyticalOperation =
  | { kind: 'describe'; resource: SelectedDataset }
  | { kind: 'execute'; plan: DuckDBPlan };

export type ChildRequest = { kind: 'open'; path: string } | AnalyticalOperation;

export type ChildResponse =
  | { kind: 'ready' }
  | { kind: 'result'; value: DatasetExecution | PhysicalSchema }
  | {
      kind: 'failure';
      code: 'execution-failed' | 'invalid-result';
      retryable: boolean;
    };

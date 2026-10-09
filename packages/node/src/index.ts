export { ActionError } from '@relate/protocol';

export type { QueryResult } from '@relate/runtime';

export type {
  Consumer,
  ActionOperations,
  ObjectResult,
  ObjectRecord,
  Page,
  PageOptions,
  QueryOptions,
  ObjectOperations,
  ObjectDescription,
  ReadOptions,
  Relate,
  TraversalDescription,
} from './types.js';

export type {
  ActionDescription,
  ActionFieldDescription,
  ActionSummary,
  GraphDescription,
  ObjectSummary,
  OperationContract,
  OperationContracts,
  OptionDescription,
  PropertyDescription,
} from '@relate/runtime';

export { createRuntime } from './runtime.js';

export type { AppOptions } from './runtime.js';

export { startApp } from './app.js';

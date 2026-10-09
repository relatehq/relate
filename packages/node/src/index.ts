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
  ReadOptions,
  Relate,
} from './types.js';

export type {
  ActionDescription,
  ActionFieldDescription,
  ActionSummary,
  GraphDescription,
  ObjectDescription,
  ObjectSummary,
  PropertyDescription,
  TraversalDescription,
} from '@relate/runtime';

export { createRuntime } from './runtime.js';

export type { AppOptions } from './runtime.js';

export { startApp } from './app.js';

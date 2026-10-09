export { createRuntime } from './runtime.js';
export type { RuntimeOptions } from './runtime.js';
export type { Principal } from './authorization/index.js';
export { ReadError } from '@relate/protocol';
export type { ReadRequest, ReadResult } from '@relate/protocol';

export { createMemoryStore } from './memory.js';
export { createQuery } from './pagination.js';
export type { QueryResult } from './pagination.js';

export type { ActionHandler, ActionExecutionContext } from './actions/index.js';

export { createDiscovery } from './discovery.js';
export { operationContracts } from './contracts.js';

export type {
  OperationContract,
  OperationContracts,
  OptionDescription,
} from './contracts.js';

export type {
  ActionDescription,
  ActionFieldDescription,
  ActionSummary,
  GraphDescription,
  ObjectDescription,
  ObjectSummary,
  PropertyDescription,
  TraversalDescription,
} from './discovery.js';

export { ActionError } from '@relate/protocol';

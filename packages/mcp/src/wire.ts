import { ActionError, ReadError } from '@relate/protocol';
import type { ConsumerOperations, ReadErrorDetails } from '@relate/protocol';
import type { ExecutionError } from './executor.js';

export type Operation = Exclude<keyof ConsumerOperations, 'discovery'>;

export const operationNames: readonly Operation[] = [
  'get',
  'query',
  'traverse',
  'invoke',
  'getReceipt',
];

export interface WireError extends ExecutionError {
  details?: ReadErrorDetails;
}

/** Parent failures only expose the public protocol errors, never stacks/causes. */
export function operationError(error: unknown): WireError {
  if (error instanceof ReadError)
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.operation
        ? {
            details: {
              operation: error.operation,
              issues: error.issues,
              ...(error.acceptedOptions
                ? { acceptedOptions: error.acceptedOptions }
                : {}),
            },
          }
        : {}),
    };

  if (error instanceof ActionError)
    return { name: error.name, message: error.message, code: error.code };

  return { name: 'Error', message: 'Graph operation failed', code: 'internal' };
}

export function restoreError(error: WireError): Error {
  if (error.name === 'ReadError')
    return new ReadError(error.code as ReadError['code'], error.details);

  if (error.name === 'ActionError')
    return new ActionError(error.code as ActionError['code']);

  return Object.assign(new Error(error.message), {
    name: error.name,
    code: error.code,
  });
}

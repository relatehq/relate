import { expect, it } from 'vitest';
import { DatasetExecutionError } from 'relate/connectors';

it.each(['execution-failed', 'invalid-result'] as const)(
  'keeps the %s cause internal while preserving a portable code',
  (code) => {
    const cause = new Error('secret literal and physical table');
    const error = new DatasetExecutionError(code, { retryable: false, cause });

    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('secret');
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'DatasetExecutionError',
      code,
      retryable: false,
    });
    expect(Object.keys(error)).not.toContain('cause');
  },
);

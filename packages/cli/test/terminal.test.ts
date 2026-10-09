import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createTerminal } from '@relate/cli';

it('quiet output keeps bootstrap links, application output and diagnostics', () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';

  stdout.on('data', (chunk) => {
    output += chunk;
  });
  stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const terminal = createTerminal({
    stdout,
    stderr,
    cwd: '/project',
    projectRoot: '/project',
    color: false,
    quiet: true,
  });

  terminal.banner({
    project: '/project',
    config: 'relate.config.ts',
    inspectorUrl: 'http://127.0.0.1:4318/#token=test',
  });
  terminal.notice('port fallback');
  terminal.loading(1);
  terminal.update(['model.ts'], 2, 'model changed', 10);
  terminal.childStdout('  Loading application data');
  terminal.childStderr('application error');
  terminal.warn('warning');
  terminal.startupError('startup error');
  terminal.error(
    [],
    1,
    [
      {
        severity: 'error',
        kind: 'worker',
        code: 'worker.error',
        message: 'failed to load',
      },
    ],
    null,
  );

  expect(output).toBe(
    'Inspector  http://127.0.0.1:4318/#token=test\n  Loading application data\n',
  );
  expect(errors).toContain('application error');
  expect(errors).toContain('warning');
  expect(errors).toContain('startup error');
  expect(errors).toContain('failed to load');
});

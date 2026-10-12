import { expect, it, onTestFinished } from 'vitest';
import { childEnvironment } from '../src/process-lifecycle.js';
import { createDevelopmentExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

it('preserves Windows OS essentials case-insensitively without inheriting application secrets or loaders', () => {
  const env = childEnvironment('C:\\execution', 'win32', {
    SYSTEMROOT: 'C:\\Windows',
    windir: 'C:\\Windows',
    Path: 'C:\\Windows\\System32',
    PATHEXT: '.EXE;.CMD',
    TEMP: 'C:\\host-temp',
    TMP: 'C:\\host-temp',
    DATABASE_URL: 'secret',
    NODE_OPTIONS: '--inspect',
    NODE_PATH: 'private-modules',
  });

  expect(env).toEqual({
    SYSTEMROOT: 'C:\\Windows',
    windir: 'C:\\Windows',
    Path: 'C:\\Windows\\System32',
    PATHEXT: '.EXE;.CMD',
    TEMP: 'C:\\execution',
    TMP: 'C:\\execution',
    TMPDIR: 'C:\\execution',
  });
});

it('starts crypto and local networking and uses the disposable directory for temporary files', async () => {
  const { binding } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor().execute({
    graph: binding,
    code: `
    const crypto = await import('node:crypto');
    const net = await import('node:net');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
    return { random: crypto.randomBytes(8).length, temporary: fs.realpathSync(os.tmpdir()) === fs.realpathSync(process.cwd()), systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT };
  `,
  });

  expect(result).toMatchObject({
    status: 'succeeded',
    result: { random: 8, temporary: true },
  });

  if (process.platform === 'win32')
    expect(result).toMatchObject({
      result: { systemRoot: expect.any(String) },
    });
});

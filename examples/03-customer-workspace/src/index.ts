import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const inspector = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL('../../../packages/cli/bin/relate.js', import.meta.url),
    ),
    'dev',
    '--config',
    fileURLToPath(new URL('../relate.config.ts', import.meta.url)),
  ],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NO_COLOR: '1' },
  },
);
let application: Awaited<ReturnType<typeof startServer>> | undefined;
let stopping: Promise<void> | undefined;
const inspectorExited = new Promise<void>((resolve) =>
  inspector.once('exit', () => resolve()),
);
const stop = () =>
  (stopping ??= (async () => {
    if (application) await application.close();

    if (inspector.exitCode === null && inspector.signalCode === null) {
      inspector.kill('SIGTERM');
      const timeout = setTimeout(() => inspector.kill('SIGKILL'), 6000);

      await inspectorExited;
      clearTimeout(timeout);
    }
  })());

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  const inspectorUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('Inspector startup timed out')),
      30000,
    );

    inspector.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    inspector.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('Inspector exited before startup'));
    });
    inspector.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-10000);
      const match = output.match(
        /Inspector\s+(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)/,
      );

      if (match) {
        clearTimeout(timeout);
        resolve(match[1]!);
      }
    });
  });

  if (stopping) throw new Error('Startup interrupted');

  application = await startServer(inspectorUrl);

  if (stopping) {
    await application.close();
  } else {
    console.log(
      `\nCustomer workspace  ${application.url}\nState resets when you stop. Press Ctrl+C to close the app and inspector.\n`,
    );

    if (!process.argv.includes('--no-open')) {
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer.exe'
            : 'xdg-open';
      const browser = spawn(command, [application.url], { stdio: 'ignore' });

      browser.on('error', () =>
        console.log('Open the application URL above in your browser.'),
      );
      browser.unref();
    }

    void inspectorExited.then(() => {
      if (!stopping) {
        console.error('Inspector stopped; closing the workspace.');
        process.exitCode = 1;
        void stop();
      }
    });
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
  await stop();
}

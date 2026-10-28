import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Use a fresh emulator process and a free loopback port for every walkthrough.
const reservation = createServer();

await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;

await new Promise((resolve) => reservation.close(resolve));
const server = spawn(
  'uvx',
  [
    '--from',
    'moto[server]==5.1.16',
    'moto_server',
    '-H',
    '127.0.0.1',
    '-p',
    String(port),
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let serverError;
let serverExited = false;
const serverDone = new Promise((resolve) => {
  server.on('error', (error) => {
    serverError = error;
  });
  server.on('close', () => {
    serverExited = true;
    resolve();
  });
});
let stderr = '';

server.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-4096);
});
const endpoint = `http://127.0.0.1:${port}`;
let demo;
const stop = () => {
  demo?.kill('SIGTERM');
  server.kill('SIGTERM');
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const deadline = Date.now() + 120_000;

  while (true) {
    if (serverError) throw serverError;

    if (serverExited) throw new Error(`S3 emulator exited: ${stderr}`);

    try {
      if ((await fetch(endpoint, { signal: AbortSignal.timeout(500) })).ok)
        break;
    } catch {
      /* starting */
    }

    if (Date.now() > deadline)
      throw new Error(`S3 emulator startup timed out: ${stderr}`);

    await delay(100);
  }

  console.log(`Local S3 ready at ${endpoint}`);
  demo = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    ],
    { stdio: 'inherit', env: { ...process.env, RELATE_S3_ENDPOINT: endpoint } },
  );
  const code = await new Promise((resolve, reject) => {
    demo.once('error', reject);
    demo.once('close', resolve);
  });

  if (code !== 0) throw new Error(`DataFusion walkthrough exited (${code})`);
} finally {
  stop();
  const timer = setTimeout(() => server.kill('SIGKILL'), 2000);

  await serverDone;
  clearTimeout(timer);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

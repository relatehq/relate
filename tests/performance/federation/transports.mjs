import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('.', import.meta.url));

export const binary = `${root}rust/target/release/federation-engine`;

const require = createRequire(import.meta.url);

export async function openTransport(kind, config) {
  const start = performance.now();

  if (kind === 'neon') {
    const addon = require(`${root}engine.node`);
    let handle = await addon.open(JSON.stringify(config));

    return {
      kind,
      startupMs: performance.now() - start,
      pid: process.pid,
      async query(request) {
        if (!handle) throw new Error('engine closed');

        return JSON.parse(
          await addon.query(
            handle,
            typeof request === 'string' ? request : JSON.stringify(request),
          ),
        );
      },
      async close() {
        handle = null;
        global.gc?.();
      },
    };
  }

  const child = spawn(binary, kind === 'http' ? ['--http'] : [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  const pending = [];
  let exited = false;
  const lines = createInterface({ input: child.stdout });

  lines.on('line', (line) => {
    const waiter = pending.shift();

    if (!waiter) return;

    try {
      waiter.resolve(JSON.parse(line));
    } catch (error) {
      waiter.reject(error);
    }
  });
  const fail = (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  };

  child.on('error', fail);
  child.on('exit', (code) => {
    exited = true;
    fail(new Error(`Engine exited (${code}): ${stderr}`));
  });
  const next = () =>
    new Promise((resolve, reject) => {
      if (exited) reject(new Error('Engine has exited'));
      else pending.push({ resolve, reject });
    });
  const readyPromise = next();

  child.stdin.write(`${JSON.stringify(config)}\n`);
  let ready;

  try {
    ready = await readyPromise;
  } catch (error) {
    child.kill();
    throw error;
  }

  const endpoint = `http://127.0.0.1:${ready.port}/query`;

  return {
    kind,
    startupMs: performance.now() - start,
    pid: child.pid,
    async query(request) {
      const body =
        typeof request === 'string' ? request : JSON.stringify(request);
      let reply;

      if (kind === 'http') {
        const response = await fetch(endpoint, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(125000),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        reply = await response.json();
      } else {
        const response = next();

        child.stdin.write(`${body}\n`);
        reply = await response;
      }

      if (!reply.ok) throw new Error(reply.error);

      return reply.result;
    },
    async close() {
      if (exited) return;

      const exit = once(child, 'exit');

      child.kill('SIGTERM');
      await exit;
      lines.close();
    },
  };
}

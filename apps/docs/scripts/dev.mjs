import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const port = process.env.PORT ?? '3100';
const url = `http://localhost:${port}`;
const next = createRequire(import.meta.url).resolve('next/dist/bin/next');

const server = spawn(process.execPath, [next, 'dev', '--port', port], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['inherit', 'pipe', 'inherit'],
});

let announced = false;

server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);

  if (!announced && /\bReady\b/.test(chunk.toString())) {
    announced = true;
    announce();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

server.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function announce() {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const lines = [
    paint('1', 'Relate docs are running'),
    '',
    `${paint('2', 'Open')}   ${paint('36;4', url)}`,
    paint('2', 'Edit   apps/docs/content/*.md'),
    paint('2', 'Stop   Ctrl+C'),
  ];
  const visible = (line) => line.replace(/\x1b\[[\d;]*m/g, '').length;
  const width = Math.max(...lines.map(visible));
  const row = (line) => `│  ${line}${' '.repeat(width - visible(line))}  │`;

  console.log(
    [
      '',
      `╭${'─'.repeat(width + 4)}╮`,
      ...lines.map(row),
      `╰${'─'.repeat(width + 4)}╯`,
      '',
    ].join('\n'),
  );
}

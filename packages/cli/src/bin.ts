import { runDev } from './dev/run.js';
import { exitCodes } from './dev/run.js';

const usage = `Usage: relate <command> [options]

Commands:
  dev    Serve the inspector for this project's definitions and reload on save

Run \`relate <command> --help\` for command options.
`;

const [command, ...rest] = process.argv.slice(2);

if (command === undefined || command === '-h' || command === '--help') {
  process.stdout.write(usage);
  process.exitCode = command === undefined ? exitCodes.usage : exitCodes.ok;
} else if (command === 'dev') {
  process.exitCode = await runDev({
    argv: rest,
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${usage}`);
  process.exitCode = exitCodes.usage;
}

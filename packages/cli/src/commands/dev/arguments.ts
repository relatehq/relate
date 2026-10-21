/**
 * `relate dev` flags. Invalid values fail before anything starts (exit 2).
 */

export interface DevArguments {
  readonly config: string | undefined;
  /** Explicit port, or `undefined` for the default range with fallback. */
  readonly port: number | undefined;
  readonly open: boolean;
  readonly quiet: boolean;
  /** Inspect the model only: start no runtime host. */
  readonly runtime: boolean;
  /** Run the config's named seed export in each new runtime. */
  readonly seed: boolean;
  /** Replace the project's saved `/mcp` bearer token with a new one. */
  readonly rotateMcpToken: boolean;
  readonly evalTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
}

import {
  DEFAULT_PORT_RANGE,
  DEFAULT_EVAL_TIMEOUT_MS,
  MAX_TIMER_MS,
  normalizeAllowedOrigin as normalizeServiceOrigin,
  normalizeDevOptions,
} from '@relate/dev';

export { DEFAULT_PORT_RANGE, DEFAULT_EVAL_TIMEOUT_MS } from '@relate/dev';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const devUsage = `Usage: relate dev [options]

Serve the inspector for the project's Relate definitions and reload on save.

Options:
  --config <path>           Entry module exporting defineApp(...) or a graph
                            (default: relate.config.{ts,mts,js,mjs} in the
                            working directory)
  --port <number>           Bind exactly this port (default: ${DEFAULT_PORT_RANGE.from}-${DEFAULT_PORT_RANGE.to},
                            first free)
  --quiet                   Hide status chatter; keep the URL and diagnostics
  --open                    Open the inspector URL once it is ready
  --seed                    Run the config's seed(relate) export on every
                            runtime start, including after reload
  --no-runtime              Inspect the model only; do not start the
                            application or run its setup
  --rotate-mcp-token        Issue a new /mcp bearer token for this project;
                            saved MCP client entries need the new one
  --eval-timeout <ms>       Deadline for loading and compiling definitions
                            (default: ${DEFAULT_EVAL_TIMEOUT_MS})
  --allowed-origin <origin> Additionally accept this exact browser origin
                            (repeatable; HTTPS unless loopback)
  -h, --help                Show this help
`;

function integer(
  value: string | undefined,
  flag: string,
  min: number,
  max: number,
) {
  if (value === undefined || !/^\d+$/.test(value))
    throw new UsageError(
      `${flag} requires an integer from ${min} through ${max}`,
    );

  const parsed = Number(value);

  if (parsed < min || parsed > max)
    throw new UsageError(
      `${flag} must be from ${min} through ${max}; got ${value}`,
    );

  return parsed;
}

/** Preserve command usage errors while sharing the service's origin rules. */
export function normalizeAllowedOrigin(value: string): string {
  try {
    return normalizeServiceOrigin(value);
  } catch (error) {
    throw new UsageError(
      (error as Error).message.replace('allowedOrigins', '--allowed-origin'),
    );
  }
}

export function parseDevArguments(
  argv: readonly string[],
): DevArguments | 'help' {
  let config: string | undefined;
  let port: number | undefined;
  let open = false;
  let quiet = false;
  let runtime = true;
  let seed = false;
  let rotateMcpToken = false;
  let evalTimeoutMs = DEFAULT_EVAL_TIMEOUT_MS;
  const allowedOrigins: string[] = [];
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];

    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${flag} requires a value`);

    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inline] = argument.includes('=')
      ? [
          argument.slice(0, argument.indexOf('=')),
          argument.slice(argument.indexOf('=') + 1),
        ]
      : [argument, undefined];
    const value = () => {
      if (inline !== undefined) return inline;

      index += 1;

      return take(index - 1, flag);
    };

    switch (flag) {
      case '-h':
      case '--help':
        return 'help';
      case '--config':
        config = value();
        break;
      case '--port':
        port = integer(value(), '--port', 1, 65_535);
        break;
      case '--quiet':
        if (inline !== undefined)
          throw new UsageError('--quiet takes no value');

        quiet = true;
        break;
      case '--open':
        if (inline !== undefined) throw new UsageError('--open takes no value');

        open = true;
        break;
      case '--no-runtime':
        if (inline !== undefined)
          throw new UsageError('--no-runtime takes no value');

        runtime = false;
        break;
      case '--seed':
        if (inline !== undefined) throw new UsageError('--seed takes no value');

        seed = true;
        break;
      case '--rotate-mcp-token':
        if (inline !== undefined)
          throw new UsageError('--rotate-mcp-token takes no value');

        rotateMcpToken = true;
        break;
      case '--eval-timeout':
        evalTimeoutMs = integer(value(), '--eval-timeout', 1, MAX_TIMER_MS);
        break;
      case '--allowed-origin':
        allowedOrigins.push(normalizeAllowedOrigin(value()));
        break;
      default:
        throw new UsageError(`Unknown option: ${argument}`);
    }
  }

  if (seed && !runtime)
    throw new UsageError('--seed cannot be combined with --no-runtime');

  const normalized = normalizeDevOptions({
    port,
    evalTimeoutMs,
    allowedOrigins,
    runtime,
    seed,
    rotateMcpToken,
  });

  return Object.freeze({
    ...normalized,
    config,
    open,
    quiet,
    allowedOrigins: Object.freeze(normalized.allowedOrigins),
  });
}

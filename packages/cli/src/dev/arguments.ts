/**
 * `relate dev` flags. Invalid values fail before anything starts (exit 2).
 */

export interface DevArguments {
  readonly config: string | undefined;
  /** Explicit port, or `undefined` for the default range with fallback. */
  readonly port: number | undefined;
  readonly open: boolean;
  readonly evalTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
}

export const DEFAULT_PORT_RANGE = Object.freeze({ from: 4318, to: 4327 });
export const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

/** Node's timer limit. */
const MAX_TIMER_MS = 2_147_483_647;

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
  --open                    Open the inspector URL once it is ready
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

/** Exact origin: scheme and host, optional port normalized to the scheme default. */
export function normalizeAllowedOrigin(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      `--allowed-origin must be an absolute origin; got ${value}`,
    );
  }

  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]';

  if (
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    value.includes('*')
  )
    throw new UsageError(
      `--allowed-origin accepts scheme and host only, no path, query, fragment, credentials or wildcard; got ${value}`,
    );

  if (url.protocol === 'http:' && !loopback)
    throw new UsageError(
      `--allowed-origin requires HTTPS for remote origins; got ${value}`,
    );

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new UsageError(
      `--allowed-origin must use http or https; got ${value}`,
    );

  return url.origin;
}

export function parseDevArguments(
  argv: readonly string[],
): DevArguments | 'help' {
  let config: string | undefined;
  let port: number | undefined;
  let open = false;
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
      case '--open':
        if (inline !== undefined) throw new UsageError('--open takes no value');

        open = true;
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

  return Object.freeze({
    config,
    port,
    open,
    evalTimeoutMs,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
  });
}

import { expect, it } from 'vitest';
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  UsageError,
  normalizeAllowedOrigin,
  parseDevArguments,
} from '@relate/cli';

it('parses defaults, explicit flags and inline values', () => {
  expect(parseDevArguments([])).toEqual({
    config: undefined,
    port: undefined,
    open: false,
    quiet: false,
    evalTimeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
    allowedOrigins: [],
  });
  expect(
    parseDevArguments([
      '--config',
      './packages/business/relate.config.ts',
      '--port=4500',
      '--open',
      '--quiet',
      '--eval-timeout',
      '60000',
      '--allowed-origin',
      'https://my-private-forward.example/',
      '--allowed-origin',
      'HTTPS://My-Private-Forward.example:443',
    ]),
  ).toEqual({
    config: './packages/business/relate.config.ts',
    port: 4500,
    open: true,
    quiet: true,
    evalTimeoutMs: 60_000,
    allowedOrigins: ['https://my-private-forward.example'],
  });
  expect(parseDevArguments(['--help'])).toBe('help');
  expect(parseDevArguments(['-h'])).toBe('help');
});

it.each([
  [['--port'], /requires a value/],
  [['--port', 'abc'], /integer from 1 through 65535/],
  [['--port', '0'], /from 1 through 65535/],
  [['--port', '65536'], /from 1 through 65535/],
  [['--eval-timeout', '-1'], /integer/],
  [['--eval-timeout', '2147483648'], /through 2147483647/],
  [['--quiet=yes'], /takes no value/],
  [['--open=yes'], /takes no value/],
  [['--bogus'], /Unknown option/],
  [['--allowed-origin', 'not a url'], /absolute origin/],
  [['--allowed-origin', 'http://remote.example'], /HTTPS/],
  [['--allowed-origin', 'https://a.example/path'], /scheme and host only/],
  [['--allowed-origin', 'https://*.example'], /scheme and host only/],
  [['--allowed-origin', 'ftp://a.example'], /http or https/],
])('rejects invalid arguments %j before starting', (argv, message) => {
  expect(() => parseDevArguments(argv)).toThrow(UsageError);
  expect(() => parseDevArguments(argv)).toThrow(message);
});

it('normalizes exact origins and allows plain HTTP only for loopback', () => {
  expect(normalizeAllowedOrigin('http://localhost:5173')).toBe(
    'http://localhost:5173',
  );
  expect(normalizeAllowedOrigin('http://127.0.0.1:4318/')).toBe(
    'http://127.0.0.1:4318',
  );
  expect(normalizeAllowedOrigin('https://forward.example:443')).toBe(
    'https://forward.example',
  );
  expect(normalizeAllowedOrigin('https://forward.example:8443')).toBe(
    'https://forward.example:8443',
  );
});

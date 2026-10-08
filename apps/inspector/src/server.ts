/**
 * Server-only entry: serves the prebuilt inspector shell and content-hashed
 * assets from a base-path-aware Hono app. The host (the CLI today) owns
 * sessions, dev endpoints and the listener; this module owns asset routing and
 * the response headers that make upgrades and caching safe.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

export { PROTOCOL_VERSION } from './protocol.js';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Restrictive by default; the shell only talks to its own origin. */
export const shellContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface InspectorServerOptions {
  /** Mount path such as `/` or `/inspector`; no trailing slash. */
  readonly basePath?: string;
  /** Directory holding the built client; defaults to the packaged assets. */
  readonly assetsDirectory?: string;
}

/** Absolute path of the packaged client build next to this module. */
export function packagedAssetsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client');
}

export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';

  if (!basePath.startsWith('/') || basePath.includes('//'))
    throw new Error(`Base path must start with "/": ${basePath}`);

  return basePath.replace(/\/+$/, '');
}

/** Headers for the shell: it revalidates on every load and never caches sessions. */
export function shellHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': shellContentSecurityPolicy,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

/** Build-time hashed assets never change at the same URL. */
export const immutableCacheControl = 'public, max-age=31536000, immutable';

export interface InspectorApp {
  readonly app: Hono;
  readonly basePath: string;
  readonly assetsDirectory: string;
  /** Verify the packaged shell exists before serving it. */
  verify(): Promise<void>;
}

export function createInspectorApp(
  options: InspectorServerOptions = {},
): InspectorApp {
  const basePath = normalizeBasePath(options.basePath);
  const assetsDirectory = resolve(
    options.assetsDirectory ?? packagedAssetsDirectory(),
  );
  const shellPath = join(assetsDirectory, 'index.html');
  const app = new Hono();
  const serveShell = async () => {
    const html = await readFile(shellPath, 'utf8');

    return new Response(html, {
      headers: { ...shellHeaders(), 'Content-Type': types['.html']! },
    });
  };

  // The shell lives at exactly `${basePath}/`; the bare base redirects there so
  // relative asset and API URLs resolve under the mount.
  if (basePath) app.get(basePath, (c) => c.redirect(`${basePath}/`, 308));
  else app.get('/index.html', (c) => c.redirect('/', 308));

  app.get(`${basePath}/`, serveShell);

  app.get(`${basePath}/assets/*`, async (c) => {
    const requested = decodeURIComponent(
      c.req.path.slice(`${basePath}/assets/`.length),
    );
    const target = normalize(join(assetsDirectory, 'assets', requested));

    if (
      !target.startsWith(join(assetsDirectory, 'assets') + sep) ||
      requested.includes('\0')
    )
      return c.notFound();

    let file;

    try {
      if (!(await stat(target)).isFile()) return c.notFound();

      file = await readFile(target);
    } catch {
      return c.notFound();
    }

    return new Response(new Uint8Array(file), {
      headers: {
        'Content-Type': types[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': immutableCacheControl,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // Anything else under the mount is a missing asset, never the SPA fallback.
  app.all(`${basePath}/*`, (c) => c.notFound());

  return Object.freeze({
    app,
    basePath,
    assetsDirectory,
    async verify() {
      try {
        if (!(await stat(shellPath)).isFile()) throw new Error('not a file');
      } catch {
        throw new Error(
          `Inspector assets are missing at ${assetsDirectory}; build @relate/inspector first`,
        );
      }
    },
  });
}

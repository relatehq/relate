import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { startWorkspace } from './app.js';

const requestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('read'),
    actor: z.enum(['ana', 'fin']),
    refresh: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('review'),
    actor: z.enum(['ana', 'fin']),
    note: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    operation: z.literal('rename'),
    name: z.string().trim().min(1).max(100),
  }),
]);

/** Example-specific routes, not a public Relate HTTP transport or authentication system. */
export async function startServer(inspectorUrl: string) {
  const workspace = await startWorkspace();
  let origin = '';
  const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    );
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers['sec-fetch-site'] &&
          req.headers['sec-fetch-site'] !== 'same-origin' &&
          req.headers['sec-fetch-site'] !== 'none')
      )
        return json(403, {
          error: 'Open the local application URL from the terminal.',
        });

      if (req.method === 'GET' && req.url === '/config')
        return json(200, { inspectorUrl });

      const asset = assets.get(req.url ?? '');

      if (req.method === 'GET' && asset) {
        const content = await readFile(
          new URL(`./ui/${asset[0]}`, import.meta.url),
        );

        res.writeHead(200, { 'Content-Type': asset[1]! });
        res.end(content);

        return;
      }

      if (req.method !== 'POST' || req.url !== '/api')
        return json(404, { error: 'Not found' });

      if (
        req.headers.origin !== origin ||
        req.headers['content-type'] !== 'application/json'
      )
        return json(403, { error: 'A same-origin JSON request is required.' });

      let body = '';

      for await (const chunk of req) {
        body += chunk;

        if (Buffer.byteLength(body) > 20000) {
          json(413, { error: 'Request too large' });

          return;
        }
      }

      const parsed = requestSchema.safeParse(JSON.parse(body));

      if (!parsed.success)
        return json(400, {
          error: 'Check the actor, operation and input fields.',
        });

      const input = parsed.data;

      if (input.operation === 'read')
        return json(200, await workspace.read(input.actor, input.refresh));

      if (input.operation === 'review')
        return json(
          200,
          await workspace.review(input.actor, input.note, input.idempotencyKey),
        );

      await workspace.rename(input.name);

      return json(200, { updated: true });
    } catch (error) {
      if (error instanceof SyntaxError)
        return json(400, { error: 'Invalid JSON' });

      // Runtime rejections are safe to present here; never return connector errors or stacks.
      return json(400, {
        error:
          'The operation was rejected. Check your role and input, then retry.',
      });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();

    if (!address || typeof address === 'string') throw new Error('No listener');

    origin = `http://127.0.0.1:${address.port}`;

    return {
      url: origin,
      async close() {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
        await workspace.close();
      },
    };
  } catch (error) {
    await workspace.close();
    throw error;
  }
}

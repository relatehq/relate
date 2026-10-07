/**
 * Local development sessions: a bootstrap token from the terminal becomes an
 * opaque HttpOnly cookie. Host and Origin are validated on every request.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export interface SessionOptions {
  readonly instanceId: string;
  /** Exact origins browsers may use; the first is the printed loopback origin. */
  readonly allowedOrigins: readonly string[];
}

export interface Sessions {
  /** 256-bit bootstrap token for the terminal link fragment; reusable for this instance. */
  readonly token: string;
  readonly cookieName: string;
  readonly allowedOrigins: readonly string[];
  /** Validate Host (and Origin when present) on every request. */
  readonly guard: MiddlewareHandler;
  /** Require a session cookie. */
  readonly requireSession: MiddlewareHandler;
  /** Exchange the token for a cookie; the request body is `{ token }`. */
  exchange(c: Context): Promise<Response>;
  /** Forget every session, for shutdown. */
  clear(): void;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function hostOf(origin: string): string {
  return new URL(origin).host;
}

export function createSessions(options: SessionOptions): Sessions {
  const token = randomBytes(32).toString('base64url');
  // Cookies are not isolated by port, so the name is unique to this instance.
  const cookieName = `relate_dev_${options.instanceId.slice(0, 12)}`;
  const allowedOrigins = Object.freeze([...new Set(options.allowedOrigins)]);
  const allowedHosts = new Set(allowedOrigins.map(hostOf));
  const active = new Set<string>();
  const secure = allowedOrigins.some((origin) => origin.startsWith('https:'));
  const guard: MiddlewareHandler = async (c, next) => {
    const host = c.req.header('host');

    if (!host || !allowedHosts.has(host))
      return c.text('Forbidden: unexpected Host', 403, {
        'Cache-Control': 'no-store',
      });

    const origin = c.req.header('origin');

    if (origin !== undefined && !allowedOrigins.includes(origin))
      return c.text('Forbidden: unexpected Origin', 403, {
        'Cache-Control': 'no-store',
      });

    // Top-level navigations may legitimately come from anywhere (the
    // terminal, another site); fetches from other sites may not.
    const site = c.req.header('sec-fetch-site');
    const navigation = c.req.header('sec-fetch-mode') === 'navigate';

    if (site === 'cross-site' && !navigation)
      return c.text('Forbidden: cross-site request', 403, {
        'Cache-Control': 'no-store',
      });

    await next();
  };
  const requireSession: MiddlewareHandler = async (c, next) => {
    const cookie = getCookie(c, cookieName);

    if (!cookie || !active.has(cookie))
      return c.json(
        {
          error: 'No development session; open the link printed by relate dev',
        },
        401,
        { 'Cache-Control': 'no-store' },
      );

    await next();
  };

  return {
    token,
    cookieName,
    allowedOrigins,
    guard,
    requireSession,
    async exchange(c) {
      const origin = c.req.header('origin');

      // The bootstrap POST must come from the page itself.
      if (origin === undefined || !allowedOrigins.includes(origin))
        return c.text('Forbidden: Origin required', 403, {
          'Cache-Control': 'no-store',
        });

      let body: unknown;

      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Expected JSON' }, 400, {
          'Cache-Control': 'no-store',
        });
      }

      const supplied = (body as { token?: unknown } | null)?.token;

      if (typeof supplied !== 'string' || !constantTimeEqual(supplied, token))
        return c.json({ error: 'Invalid token' }, 403, {
          'Cache-Control': 'no-store',
        });

      const session = randomBytes(32).toString('base64url');

      active.add(session);
      setCookie(c, cookieName, session, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        secure,
      });

      return c.body(null, 204, { 'Cache-Control': 'no-store' });
    },
    clear() {
      active.clear();
    },
  };
}

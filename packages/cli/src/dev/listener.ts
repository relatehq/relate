/**
 * Loopback listener with direct bind attempts: try each candidate port, retry
 * only on address-in-use, never probe-release-rebind.
 */
import type { Server } from 'node:http';
import { DEFAULT_PORT_RANGE } from './arguments.js';

export const LOOPBACK_HOST = '127.0.0.1';

export class ListenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListenError';
  }
}

export interface Bound {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** Fallback message such as `Port 4318 is in use; using 4319`, if any. */
  readonly notice: string | null;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

export async function bindLoopback(
  createServer: () => Server,
  explicitPort: number | undefined,
  range: { readonly from: number; readonly to: number } = DEFAULT_PORT_RANGE,
): Promise<Bound> {
  const candidates =
    explicitPort !== undefined
      ? [explicitPort]
      : Array.from(
          { length: range.to - range.from + 1 },
          (_, i) => range.from + i,
        );
  const busy: number[] = [];

  for (const port of candidates) {
    const server = createServer();

    try {
      await listen(server, port);
    } catch (error) {
      server.close();

      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (explicitPort !== undefined)
          throw new ListenError(
            `Port ${port} is in use. Stop the other process or choose another --port.`,
          );

        busy.push(port);
        continue;
      }

      throw new ListenError(
        `Could not listen on ${LOOPBACK_HOST}:${port}: ${(error as Error).message}`,
      );
    }

    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;

    return {
      server,
      port: bound,
      url: `http://${LOOPBACK_HOST}:${bound}`,
      notice: busy.length ? `Port ${busy[0]} is in use; using ${bound}` : null,
    };
  }

  throw new ListenError(
    `Ports ${range.from}-${range.to} are all in use. Pass --port <number> to choose one.`,
  );
}

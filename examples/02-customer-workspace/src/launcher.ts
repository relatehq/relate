import type { EventEmitter } from 'node:events';
import type { Inspector } from './inspector.js';

interface Application {
  url: string;
  close(): Promise<void>;
  forceClose(): void;
}

/** One launch owns its application and CLI child, but may borrow an existing inspector. */
export async function runWorkspace(options: {
  inspector: Inspector;
  startApplication(url: string): Promise<Application>;
  signals: Pick<EventEmitter, 'on' | 'off'>;
  onReady(app: Application, reused: boolean): void;
  reportError(error: unknown): void;
  forceExit(code: number): void;
  shutdownTimeoutMs?: number;
}): Promise<number> {
  const { inspector } = options;
  let application: Application | undefined;
  let starting: Promise<Application> | undefined;
  let cancelled = false;
  let shuttingDown = false;
  let code = 0;
  let requestStop!: () => void;
  let didForce!: () => void;
  const stopRequested = new Promise<null>((resolve) => {
    requestStop = () => resolve(null);
  });
  const forced = new Promise<void>((resolve) => {
    didForce = resolve;
  });
  const force = (exitCode: number) => {
    code = exitCode;
    void inspector.stop(true).catch(options.reportError);
    application?.forceClose();
    didForce();
    options.forceExit(exitCode);
  };
  const signal = () => {
    if (cancelled || shuttingDown) {
      force(130);

      return;
    }

    cancelled = true;
    requestStop();
  };

  options.signals.on('SIGINT', signal);
  options.signals.on('SIGTERM', signal);
  options.signals.on('SIGHUP', signal);

  try {
    const ready = await Promise.race([inspector.ready, stopRequested]);

    if (ready) {
      starting = options.startApplication(ready.url);
      application =
        (await Promise.race([starting, stopRequested])) ?? undefined;

      if (application && !cancelled) {
        options.onReady(application, ready.reused);

        if (ready.reused) await stopRequested;
        else
          await Promise.race([
            stopRequested,
            inspector.exited.then(() => {
              if (!cancelled)
                throw new Error('Inspector stopped; closing the workspace.');
            }),
          ]);
      }
    }
  } catch (error) {
    if (!cancelled) {
      code = 1;
      options.reportError(error);
    }
  } finally {
    shuttingDown = true;
    const timeout = setTimeout(() => {
      options.reportError(new Error('Shutdown timed out; forcing exit.'));
      force(1);
    }, options.shutdownTimeoutMs ?? 6000);
    // Start both cleanups independently. A late application startup is closed too.
    const cleanup = Promise.allSettled([
      inspector.stop(),
      starting?.then(
        (app) => {
          application = app;

          return app.close();
        },
        () => {},
      ),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          code = 1;
          options.reportError(result.reason);
        }
      }
    });

    await Promise.race([cleanup, forced]);
    clearTimeout(timeout);
    options.signals.off('SIGINT', signal);
    options.signals.off('SIGTERM', signal);
    options.signals.off('SIGHUP', signal);
  }

  return code;
}

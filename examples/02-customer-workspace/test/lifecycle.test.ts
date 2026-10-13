import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { watchInspector } from '../src/inspector.js';
import { runWorkspace } from '../src/launcher.js';
import type { Inspector } from '../src/inspector.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

it('waits for a complete token line even when stdout splits the token', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const inspector = watchInspector(
    child as unknown as ChildProcessWithoutNullStreams,
  );
  const received = vi.fn();

  void inspector.ready.then(received);
  child.stdout.write(
    'Relate dev is already running for /demo\nInspector  http://127.0.0.1:4318/#token=abc',
  );
  await Promise.resolve();
  expect(received).not.toHaveBeenCalled();
  child.stdout.write('def\n');
  expect(await inspector.ready).toEqual({
    url: 'http://127.0.0.1:4318/#token=abcdef',
    reused: true,
  });
  child.emit('exit', 0);
});

it('reads the final token line when the CLI exits before stdout drains', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const inspector = watchInspector(
    child as unknown as ChildProcessWithoutNullStreams,
  );

  child.emit('exit', 0);
  child.stdout.end('Inspector  http://127.0.0.1:4318/#token=abc\n');
  await new Promise((resolve) => child.stdout.once('end', resolve));
  child.emit('close', 0);
  expect(await inspector.ready).toEqual({
    url: 'http://127.0.0.1:4318/#token=abc',
    reused: false,
  });
});

function fixture(reused = false) {
  const signals = new EventEmitter();
  const exited = deferred<void>();
  const inspector: Inspector = {
    ready: Promise.resolve({ url: 'http://127.0.0.1:4318/#token=abc', reused }),
    exited: exited.promise,
    stop: vi.fn(async () => {
      exited.resolve();
    }),
  };
  const app = {
    url: 'http://127.0.0.1:4321',
    close: vi.fn(async () => {}),
    forceClose: vi.fn(),
  };
  const options = {
    inspector,
    signals,
    startApplication: vi.fn(async () => app),
    onReady: vi.fn(),
    reportError: vi.fn(),
    forceExit: vi.fn(),
  };

  return { options, app, exited };
}

describe('workspace shutdown', () => {
  it('keeps a reused inspector CLI exit from stopping the application', async () => {
    const { options, app, exited } = fixture(true);
    const running = runWorkspace(options);

    await vi.waitFor(() => expect(options.onReady).toHaveBeenCalled());
    exited.resolve();
    await Promise.resolve();
    expect(app.close).not.toHaveBeenCalled();
    options.signals.emit('SIGINT');
    expect(await running).toBe(0);
    expect(app.close).toHaveBeenCalledOnce();
  });
  it('stops the inspector even when app cleanup rejects and reports the failure', async () => {
    const { options, app } = fixture();
    const failure = new Error('App close failed');

    app.close.mockRejectedValue(failure);
    const running = runWorkspace(options);

    await vi.waitFor(() => expect(options.onReady).toHaveBeenCalled());
    options.signals.emit('SIGINT');
    expect(await running).toBe(1);
    expect(options.inspector.stop).toHaveBeenCalled();
    expect(options.reportError).toHaveBeenCalledWith(failure);
  });
  it('forces shutdown on a second signal while app cleanup hangs', async () => {
    const { options, app } = fixture();

    app.close.mockReturnValue(new Promise(() => {}));
    const running = runWorkspace(options);

    await vi.waitFor(() => expect(options.onReady).toHaveBeenCalled());
    options.signals.emit('SIGINT');
    await vi.waitFor(() => expect(app.close).toHaveBeenCalled());
    options.signals.emit('SIGINT');
    expect(await running).toBe(130);
    expect(options.inspector.stop).toHaveBeenCalledWith(true);
    expect(app.forceClose).toHaveBeenCalledOnce();
    expect(options.forceExit).toHaveBeenCalledWith(130);
  });
  it('bounds hanging cleanup even without a second signal', async () => {
    const { options, app } = fixture();

    app.close.mockReturnValue(new Promise(() => {}));
    const running = runWorkspace({ ...options, shutdownTimeoutMs: 10 });

    await vi.waitFor(() => expect(options.onReady).toHaveBeenCalled());
    options.signals.emit('SIGINT');
    expect(await running).toBe(1);
    expect(options.forceExit).toHaveBeenCalledWith(1);
  });
  it('cancels inspector startup cleanly', async () => {
    const { options } = fixture();

    options.inspector.ready = new Promise(() => {});
    const running = runWorkspace(options);

    options.signals.emit('SIGINT');
    expect(await running).toBe(0);
    expect(options.reportError).not.toHaveBeenCalled();
    expect(options.startApplication).not.toHaveBeenCalled();
    expect(options.inspector.stop).toHaveBeenCalled();
  });
  it('closes an application that finishes starting after cancellation', async () => {
    const { options, app } = fixture();
    const starting = deferred<typeof app>();

    options.startApplication.mockReturnValue(starting.promise);
    const running = runWorkspace(options);

    await vi.waitFor(() => expect(options.startApplication).toHaveBeenCalled());
    options.signals.emit('SIGINT');
    starting.resolve(app);
    expect(await running).toBe(0);
    expect(app.close).toHaveBeenCalledOnce();
    expect(options.onReady).not.toHaveBeenCalled();
  });
});

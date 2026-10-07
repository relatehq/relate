/**
 * ELK in a browser Web Worker: the thin `elk-api` client runs on the main
 * thread and posts graphs to `elk-worker.min.js`, which Vite emits as its own
 * worker asset. React Flow owns interaction; the worker only computes placement.
 */
import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?worker&url';
import type { ElkLike } from './elk.js';

type ElkConstructor = new (options: {
  workerUrl: string;
  workerFactory?: (url: string) => Worker;
}) => ElkLike & { terminateWorker(): void };

// elkjs ships CommonJS with ESM-style typings; bundlers differ on the default.
const ELK =
  (ElkApi as unknown as { default?: ElkConstructor }).default ??
  (ElkApi as unknown as ElkConstructor);

export interface LayoutEngine extends ElkLike {
  terminate(): void;
}

/** Throws when the worker cannot start; callers surface that as a layout diagnostic. */
export function createLayoutEngine(): LayoutEngine {
  const elk = new ELK({
    workerUrl: elkWorkerUrl,
    workerFactory: (url) => new Worker(url, { type: 'module' }),
  });

  return {
    layout: (graph) => elk.layout(graph),
    terminate: () => elk.terminateWorker(),
  };
}

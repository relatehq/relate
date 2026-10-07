/// <reference lib="webworker" />
/**
 * Layout Web Worker: only computes placement. React Flow owns interaction on
 * the main thread.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { layoutWithElk } from './elk.js';
import type { LayoutRequest, LayoutResponse } from './elk.js';

const elk = new ELK();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
};

scope.onmessage = async (event) => {
  const request = event.data;

  try {
    scope.postMessage({ ok: true, result: await layoutWithElk(request, elk) });
  } catch (error) {
    scope.postMessage({
      ok: false,
      generation: request.generation,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

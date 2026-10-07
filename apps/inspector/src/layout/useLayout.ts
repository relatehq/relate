import { useEffect, useRef, useState } from 'react';
import type { LayoutRequest, LayoutResponse, Position } from './elk.js';
import type { Diagnostic } from '../protocol.js';

export interface LayoutState {
  /** Positions of the newest completed layout; retained when a newer one fails. */
  readonly positions: Readonly<Record<string, Position>>;
  readonly generation: number;
  readonly diagnostic: Diagnostic | null;
}

/**
 * Run ELK in a Web Worker. Requests are tagged with the model generation and
 * a topology signature; obsolete results are discarded and failures keep the
 * last valid layout with a visible diagnostic.
 */
export function useLayout(
  request: LayoutRequest | null,
  signature: string,
): LayoutState {
  const [state, setState] = useState<LayoutState>({
    positions: {},
    generation: 0,
    diagnostic: null,
  });
  const worker = useRef<Worker | null>(null);
  // The request actually sent; responses for any other generation are obsolete.
  const posted = useRef<{ generation: number; signature: string } | null>(null);

  useEffect(() => {
    let instance: Worker;

    try {
      instance = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (error) {
      setState((current) => ({ ...current, diagnostic: unavailable(error) }));

      return undefined;
    }

    instance.onmessage = (event: MessageEvent<LayoutResponse>) => {
      const response = event.data;
      const generation = response.ok
        ? response.result.generation
        : response.generation;

      if (posted.current?.generation !== generation) return;

      if (response.ok)
        setState({
          positions: response.result.positions,
          generation,
          diagnostic: null,
        });
      else
        setState((current) => ({
          ...current,
          diagnostic: {
            kind: 'layout',
            code: 'layout.failed',
            severity: 'error',
            message: `Layout failed for generation ${generation}; keeping the previous placement. ${response.message}`,
          },
        }));
    };
    instance.onerror = (event) => {
      event.preventDefault();
      setState((current) => ({
        ...current,
        diagnostic: unavailable(event.message),
      }));
    };
    worker.current = instance;

    return () => {
      instance.terminate();
      worker.current = null;
      posted.current = null;
    };
  }, []);

  useEffect(() => {
    if (!request || !worker.current) return;

    // Presentation-only changes keep coordinates; topology and sizes relayout.
    if (posted.current?.signature === signature) return;

    posted.current = { generation: request.generation, signature };
    worker.current.postMessage(request);
  }, [request, signature]);

  return state;
}

function unavailable(error: unknown): Diagnostic {
  return {
    kind: 'layout',
    code: 'layout.worker-unavailable',
    severity: 'error',
    message: `The layout worker could not start; reload the page to recover. ${
      error instanceof Error ? error.message : String(error ?? '')
    }`.trim(),
  };
}

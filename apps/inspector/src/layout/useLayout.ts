import { useEffect, useRef, useState } from 'react';
import { layoutWithElk } from './elk.js';
import type { LayoutRequest, Position } from './elk.js';
import { createLayoutEngine } from './engine.js';
import type { LayoutEngine } from './engine.js';
import type { Diagnostic } from '../protocol.js';

export interface LayoutState {
  /** Positions of the newest completed layout; retained when a newer one fails. */
  readonly positions: Readonly<Record<string, Position>>;
  readonly generation: number;
  readonly diagnostic: Diagnostic | null;
}

/**
 * Run ELK in its Web Worker. Requests are tagged with the model generation and
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
  const engine = useRef<LayoutEngine | null>(null);
  // The request actually sent; results for any other generation are obsolete.
  const posted = useRef<{ generation: number; signature: string } | null>(null);

  useEffect(() => {
    try {
      engine.current = createLayoutEngine();
    } catch (error) {
      setState((current) => ({ ...current, diagnostic: unavailable(error) }));

      return undefined;
    }

    return () => {
      engine.current?.terminate();
      engine.current = null;
      posted.current = null;
    };
  }, []);

  useEffect(() => {
    if (!request || !engine.current) return;

    // Presentation-only changes keep coordinates; topology changes relayout.
    if (posted.current?.signature === signature) return;

    const generation = request.generation;

    posted.current = { generation, signature };
    layoutWithElk(request, engine.current).then(
      (result) => {
        if (posted.current?.generation !== generation) return;

        setState({
          positions: result.positions,
          generation,
          diagnostic: null,
        });
      },
      (error: unknown) => {
        if (posted.current?.generation !== generation) return;

        setState((current) => ({
          ...current,
          diagnostic: {
            kind: 'layout',
            code: 'layout.failed',
            severity: 'error',
            message: `Layout failed for generation ${generation}; keeping the previous placement. ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        }));
      },
    );
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

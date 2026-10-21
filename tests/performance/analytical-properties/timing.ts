export interface Span {
  name: string;
  kind: 'real' | 'mock';
  startMs: number;
  durationMs: number;
}

export class Trace {
  private origin = performance.now();
  readonly spans: Span[] = [];
  readonly counters: Record<string, number> = {};
  async measure<T>(
    name: string,
    kind: Span['kind'],
    task: () => T | Promise<T>,
  ): Promise<T> {
    const start = performance.now();

    try {
      return await task();
    } finally {
      this.spans.push({
        name,
        kind,
        startMs: start - this.origin,
        durationMs: performance.now() - start,
      });
    }
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { json } from '../world/model.js';
import type { Row } from '../systems/simulators.js';

export const telemetryVersion = 1;

export type SpanKind =
  | 'phase'
  | 'model'
  | 'provider'
  | 'tool'
  | 'http'
  | 'sql'
  | 'source-fetch'
  | 'analytical-dispatch';

export interface SpanRecord {
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: string;
}

function resources() {
  return { cpu: process.cpuUsage(), memory: process.memoryUsage() };
}

/** One instance per run. Writes are ordered even when child operations overlap. */
export class Trace {
  private context = new AsyncLocalStorage<string>();
  private activeScope: string | undefined;
  private open = new Map<string, Row>();
  private completed: SpanRecord[] = [];
  private queue = Promise.resolve();
  private sequence = 0;
  private nextSpan = 0;
  private origin: number;
  private bytes = 0;
  private writeMs = 0;
  private initial = resources();
  private maxObservedRssBytes = this.initial.memory.rss;

  constructor(
    private sink: (event: Row) => Promise<void>,
    readonly runId = 'standalone',
    private clock = {
      now: () => performance.now(),
      iso: () => new Date().toISOString(),
    },
  ) {
    this.origin = clock.now();
  }

  emit = (event: Row): Promise<void> => {
    const contextSpanId = this.context.getStore();
    const row = {
      ...event,
      ...(contextSpanId && this.open.has(contextSpanId)
        ? { contextSpanId }
        : {}),
      telemetryVersion,
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: this.clock.iso(),
      elapsedMs: this.clock.now() - this.origin,
    };

    this.bytes += Buffer.byteLength(json(row) + '\n');
    this.queue = this.queue.then(async () => {
      const start = performance.now();

      try {
        await this.sink(row);
      } finally {
        this.writeMs += performance.now() - start;
      }
    });

    return this.queue;
  };

  async span<T>(
    kind: SpanKind,
    name: string,
    attributes: Row,
    operation: (attributes: Row) => Promise<T> | T,
    scope = false,
  ): Promise<T> {
    const inherited = this.context.getStore();
    // Executor IPC listeners may have been installed during setup. A closed setup
    // context must not steal attribution from the currently dispatched tool.
    const parentSpanId =
      inherited && this.open.has(inherited)
        ? inherited
        : (this.activeScope ?? null);
    const spanId = `${this.runId}:${++this.nextSpan}`;

    attributes.spanId = spanId;
    const startedAt = this.clock.iso();
    const start = this.clock.now();
    const before = resources();
    const base = { spanId, parentSpanId, kind, name, startedAt };
    const previous = this.activeScope;

    this.open.set(spanId, base);

    if (scope) this.activeScope = spanId;

    let outcome = 'ok';
    let error: string | undefined;

    try {
      await this.emit({
        type: 'span-start',
        ...base,
        attributes: { ...attributes },
        resources: before,
      });

      return await this.context.run(spanId, () => operation(attributes));
    } catch (cause) {
      outcome =
        cause instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(cause.name)
          ? 'aborted'
          : 'error';
      error = String(cause);
      throw cause;
    } finally {
      const durationMs = this.clock.now() - start;
      const after = resources();

      this.maxObservedRssBytes = Math.max(
        this.maxObservedRssBytes,
        before.memory.rss,
        after.memory.rss,
      );
      const record = {
        ...base,
        endedAt: this.clock.iso(),
        durationMs,
        outcome:
          outcome === 'ok' && typeof attributes.outcome === 'string'
            ? attributes.outcome
            : outcome,
      };

      this.completed.push(record);
      this.open.delete(spanId);

      if (scope) this.activeScope = previous;

      attributes.durationMs = durationMs;
      await this.emit({
        type: 'span-end',
        ...record,
        attributes: { ...attributes },
        ...(error ? { error } : {}),
        resources: {
          ...after,
          cpuUserMicros: after.cpu.user - before.cpu.user,
          cpuSystemMicros: after.cpu.system - before.cpu.system,
          rssDeltaBytes: after.memory.rss - before.memory.rss,
        },
      });
    }
  }

  summary() {
    const current = resources();

    return {
      version: telemetryVersion,
      events: this.sequence,
      bytes: this.bytes,
      writeMs: this.writeMs,
      elapsedMs: this.clock.now() - this.origin,
      resourceScope:
        'parent-process; concurrent work included; child executor CPU excluded',
      cpuUserMicros: current.cpu.user - this.initial.cpu.user,
      cpuSystemMicros: current.cpu.system - this.initial.cpu.system,
      maxObservedRssBytes: Math.max(
        this.maxObservedRssBytes,
        current.memory.rss,
      ),
      unfinished: [...this.open.values()],
      spans: this.completed,
    };
  }
}

export async function traced<T>(
  trace: Trace | undefined,
  kind: SpanKind,
  name: string,
  attributes: Row,
  operation: (attributes: Row) => Promise<T> | T,
): Promise<T> {
  return trace
    ? trace.span(kind, name, attributes, operation)
    : operation(attributes);
}

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Row } from '../systems/simulators.js';
import type { SpanRecord } from '../harness/telemetry.js';

/** Read spans independently of results so crashed attempts remain visible. */
export async function readTelemetry(out: string) {
  const groups = new Map<string, SpanRecord[]>();
  const unfinished: Row[] = [];
  const malformed: Row[] = [];
  let instrumentedTranscripts = 0,
    legacyTranscripts = 0;

  for (const file of (await readdir(out))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()) {
    const starts = new Map<string, SpanRecord>();
    const ends = new Map<string, SpanRecord>();
    const lines = createInterface({
      input: createReadStream(join(out, file)),
      crlfDelay: Infinity,
    });
    let identity: Row = {},
      instrumented = false,
      lineNumber = 0;

    for await (const line of lines) {
      lineNumber++;

      if (!line.trim()) continue;

      let event: Row;

      try {
        event = JSON.parse(line) as Row;
      } catch {
        malformed.push({ file, line: lineNumber });
        continue;
      }

      if (event.type === 'start') identity = event.identity as Row;

      if (event.telemetryVersion !== 1) continue;

      instrumented = true;

      if (event.type === 'span-start')
        starts.set(String(event.spanId), event as unknown as SpanRecord);

      if (event.type === 'span-end')
        ends.set(String(event.spanId), event as unknown as SpanRecord);
    }

    if (!instrumented) {
      legacyTranscripts++;
      continue;
    }

    instrumentedTranscripts++;

    for (const [id, start] of starts) {
      const end = ends.get(id);

      if (!end) {
        unfinished.push({ file, ...identity, ...start });
        continue;
      }

      let ancestor: SpanRecord | undefined = start;
      let segment = 'measured';

      while (ancestor) {
        if (ancestor.kind === 'phase') {
          if (
            ['world', 'environment-setup', 'arm-setup'].includes(ancestor.name)
          )
            segment = 'setup';

          if (
            ['drain', 'arm-cleanup', 'environment-cleanup'].includes(
              ancestor.name,
            )
          )
            segment = 'cleanup';

          if (ancestor.name === 'grading') segment = 'grading';
        }

        ancestor = ancestor.parentSpanId
          ? starts.get(ancestor.parentSpanId)
          : undefined;
      }

      const key = `${identity.arm ?? 'unknown'}/${identity.tier ?? 'unknown'}/${segment}/${end.kind}/${end.name}`;

      const group = groups.get(key) ?? [];

      group.push(end);
      groups.set(key, group);
    }
  }

  const steps = [...groups].map(([group, spans]) => {
    const durations = spans.map((s) => s.durationMs).sort((a, b) => a - b);
    const percentile = (q: number) =>
      durations[Math.ceil(durations.length * q) - 1]!;

    return {
      group,
      count: spans.length,
      errors: spans.filter((s) => s.outcome !== 'ok').length,
      totalMs: durations.reduce((a, b) => a + b, 0),
      medianMs: percentile(0.5),
      p90Ms: percentile(0.9),
      p99Ms: percentile(0.99),
      maxMs: durations.at(-1)!,
    };
  });

  return {
    version: 1,
    instrumentedTranscripts,
    legacyTranscripts,
    unfinished,
    malformed,
    steps,
  };
}

export function renderTelemetry(
  report: Awaited<ReturnType<typeof readTelemetry>>,
) {
  return `\n## Step telemetry\n\nInstrumented transcripts: ${report.instrumentedTranscripts}; legacy (no step timings): ${report.legacyTranscripts}; unfinished spans: ${report.unfinished.length}; malformed log lines: ${report.malformed.length}. Setup and cleanup are separated from measured work. Durations include nested operations and logging overhead; do not add different kinds together. Errors count non-ok outcomes, including recoverable faults.\n\n| Arm / tier / segment / kind / operation | Steps | Errors | Median ms | p90 ms | p99 ms | Max ms |\n|---|---:|---:|---:|---:|---:|---:|\n${report.steps.map((s) => `| ${s.group} | ${s.count} | ${s.errors} | ${s.medianMs.toFixed(2)} | ${s.p90Ms.toFixed(2)} | ${s.p99Ms.toFixed(2)} | ${s.maxMs.toFixed(2)} |`).join('\n')}\n`;
}
